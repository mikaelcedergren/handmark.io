import compression from 'compression';
import crypto from 'node:crypto';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBrowserServing,
  hardenApp,
  healthPayload,
  missingAsset404,
  securityHeaders,
  staticOptions,
} from '../../server-ops/lib/site-server.mjs';
import { retainedReleaseAssetMiddleware } from '../../server-ops/lib/site-release.mjs';
import { ApplicationStoreError, createApplicationStore } from './application-store.mjs';
import { createRequestLimiter } from './request-limiter.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
loadLocalEnv(join(ROOT, '.env'));

const browserServing = createBrowserServing({
  express,
  repoRoot: ROOT,
  legacyBrowserDir: join(ROOT, 'dist', 'browser'),
  browserDirOverride: process.env.SITE_BROWSER_DIR,
});
const dataDir = resolve(ROOT, process.env.DATA_DIR ?? 'data');
const applicationsPath = join(dataDir, 'applications.jsonl');

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const PASSWORD = process.env.HANDMARK_PASSWORD ?? (isProduction ? '' : 'handmark-dev-password');
const DEFAULT_SESSION_SECRET = 'handmark-local-development-secret-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET ?? (isProduction ? '' : DEFAULT_SESSION_SECRET);
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const MIN_PASSWORD_LENGTH = 12;
const MIN_SESSION_SECRET_LENGTH = 32;

if (isProduction && PASSWORD.length < MIN_PASSWORD_LENGTH) {
  throw new Error(
    `HANDMARK_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters in production.`,
  );
}
if (isProduction && SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
  throw new Error(
    `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production.`,
  );
}

const applicationStore = createApplicationStore({ filePath: applicationsPath });
try {
  const storage = await applicationStore.initialize();
  console.log('[handmark] application storage ready', storage);
} catch (error) {
  // Keep the sales site available, but block intake with a clear error until storage is healthy.
  console.error('[handmark] application storage needs attention', error);
}
applicationStore.startMaintenance();
const requestLimiter = createRequestLimiter();
requestLimiter.startSweep();

const app = express();
hardenApp(app);
app.use(securityHeaders());
app.use(compression());

app.get('/healthz', (_req, res) => {
  res.json(healthPayload('handmark.io', PORT));
});

app.get('/login', (req, res) => sendBuiltFile(req, res, 'login.html'));
app.get('/styles.css', (req, res) => sendBuiltFile(req, res, 'styles.css'));
app.get('/robots.txt', (req, res) => sendBuiltFile(req, res, 'robots.txt'));
app.get('/sitemap.xml', (req, res) => sendBuiltFile(req, res, 'sitemap.xml'));
app.get('/site.webmanifest', (req, res) => sendBuiltFile(req, res, 'site.webmanifest'));
app.use('/assets', browserServing.staticMiddleware({ immutable: true, maxAge: '1y' }, 'assets'));

app.post('/login', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  if (!allowRequest(req, 'login', 20, 15 * 60 * 1000)) {
    res.status(429).type('text/plain').send('Too many login attempts. Try again later.');
    return;
  }

  const submittedPassword = String(req.body?.password ?? '');
  if (!constantTimeEqual(submittedPassword, PASSWORD)) {
    res.redirect(302, '/login?error=1');
    return;
  }

  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie('hm_session', createSessionCookie(), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
  });
  res.redirect(302, '/');
});

app.post('/logout', (_req, res) => {
  res.clearCookie('hm_session', { httpOnly: true, sameSite: 'lax', path: '/' });
  res.redirect(302, '/login');
});

app.use(requireAuth);
app.post('/api/apply', express.json({ limit: '64kb' }), handleApplication);
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, message: 'API route not found.' });
});

app.use(browserServing.staticMiddleware(staticOptions()));
if (browserServing.useReleaseHistory) {
  app.use(retainedReleaseAssetMiddleware({ repoRoot: ROOT }));
}
app.use(missingAsset404());
app.get(/.*/, (req, res) => sendBuiltFile(req, res, 'index.html'));
app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const providedStatus = Number(error?.status ?? error?.statusCode);
  const status =
    Number.isInteger(providedStatus) && providedStatus >= 400 && providedStatus < 500
      ? providedStatus
      : 500;
  if (status === 500) console.error('[handmark] unhandled request error', error);

  const message =
    status === 413
      ? 'Request body is too large.'
      : status === 400
        ? 'Request body is invalid.'
        : 'The request could not be processed.';
  if (req.path.startsWith('/api/')) {
    res.status(status).json({ ok: false, message });
    return;
  }
  res.status(status).type('text/plain').send(message);
});

const server = app.listen(PORT, HOST, (error) => {
  if (error) {
    console.error(`[handmark] failed to listen on http://${HOST}:${PORT}`, error);
    throw error;
  }
  console.log(`[handmark] listening on http://${HOST}:${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[handmark] shutting down (${signal})`);
  requestLimiter.stopSweep();
  const hardStop = setTimeout(() => process.exit(1), 10_000);
  hardStop.unref();

  const closed = new Promise((resolveClose) => {
    server.close((error) => {
      if (error) console.error('[handmark] HTTP shutdown failed', error);
      resolveClose(error ? 1 : 0);
    });
  });
  await applicationStore.stopMaintenance();
  const exitCode = await closed;
  clearTimeout(hardStop);
  process.exit(exitCode);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSyncUtf8(filePath);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readFileSyncUtf8(filePath) {
  return readFileSync(filePath, 'utf8');
}

function sendBuiltFile(req, res, fileName) {
  const filePath = join(browserServing.browserDirForRequest(req), fileName);
  if (!existsSync(filePath)) {
    res.status(503).type('text/plain').send('Build missing. Run pnpm build first.');
    return;
  }
  if (fileName.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(filePath);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ ok: false, message: 'Login required.' });
    return;
  }
  res.redirect(302, '/login');
}

function createSessionCookie() {
  const payload = JSON.stringify({
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('base64url'),
  });
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function isAuthenticated(req) {
  const token = req.headers.cookie
    ?.split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith('hm_session='))
    ?.slice('hm_session='.length);
  if (!token || !token.includes('.')) return false;

  try {
    const [encoded, signature] = decodeURIComponent(token).split('.');
    if (!encoded || !signature || !constantTimeEqual(sign(encoded), signature)) return false;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const ageSeconds = (Date.now() - Number(payload.issuedAt || 0)) / 1000;
    return ageSeconds >= 0 && ageSeconds <= SESSION_MAX_AGE_SECONDS;
  } catch {
    return false;
  }
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function constantTimeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function allowRequest(req, scope, maxRequests, windowMs) {
  const key = `${scope}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  return requestLimiter.allow(key, maxRequests, windowMs);
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

class ValidationError extends Error {}

function requireField(payload, field, maxLength = 10_000) {
  const raw = payload[field];
  if (typeof raw !== 'string') {
    throw new ValidationError(`${field} must be text.`);
  }
  const value = raw.trim();
  if (!value) throw new ValidationError(`${field} is required.`);
  if (value.length > maxLength) {
    throw new ValidationError(`${field} is too long.`);
  }
  return value;
}

function requireEmail(payload) {
  const value = requireField(payload, 'email', 254);
  if (!EMAIL_PATTERN.test(value)) throw new ValidationError('Enter a valid email address.');
  return value;
}

function optionalField(payload, field, maxLength) {
  const raw = payload[field];
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') {
    throw new ValidationError(`${field} must be text.`);
  }
  const value = raw.trim();
  if (value.length > maxLength) throw new ValidationError(`${field} is too long.`);
  return value;
}

async function handleApplication(req, res) {
  try {
    if (!allowRequest(req, 'apply', 30, 60 * 60 * 1000)) {
      res.status(429).json({ ok: false, message: 'Too many applications. Try again later.' });
      return;
    }

    const payload = req.body ?? {};
    const plan = requireField(payload, 'plan', 32);
    if (plan !== 'verification') throw new ValidationError('Choose a valid plan.');
    if (payload.agree !== true) throw new ValidationError('Agreement is required.');

    const billingCycle = requireField(payload, 'billingCycle', 32);
    if (billingCycle !== 'monthly') throw new ValidationError('Choose a valid billing cycle.');
    const paymentPreference = requireField(payload, 'paymentPreference', 32);
    if (paymentPreference !== 'after-approval') {
      throw new ValidationError('Choose a valid payment preference.');
    }

    const application = {
      id: `HM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      plan,
      billingCycle,
      name: requireField(payload, 'name', 200),
      email: requireEmail(payload),
      contactPreference: requireField(payload, 'contactPreference', 500),
      brand: requireField(payload, 'brand', 200),
      website: requireField(payload, 'website', 2_048),
      category: requireField(payload, 'category', 200),
      craftSummary: requireField(payload, 'craftSummary'),
      proofLinks: requireField(payload, 'proofLinks'),
      walkthroughPreference: optionalField(payload, 'walkthroughPreference', 1_000),
      paymentPreference,
    };

    await applicationStore.append(application);
    res.status(201).json({
      ok: true,
      id: application.id,
      message: 'Application received. The next step is human review and process walkthrough.',
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ ok: false, message: error.message });
      return;
    }
    if (error instanceof ApplicationStoreError) {
      console.error('[handmark] application storage rejected write', {
        code: error.code,
        message: error.message,
        cause: error.cause,
      });
      res.status(error.status).json({ ok: false, code: error.code, message: error.publicMessage });
      return;
    }
    console.error('[handmark] application save failed', error);
    res.status(500).json({ ok: false, message: 'Could not save the application. Try again.' });
  }
}

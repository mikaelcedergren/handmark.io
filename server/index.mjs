import compression from 'compression';
import crypto from 'node:crypto';
import express from 'express';
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hardenApp,
  healthPayload,
  securityHeaders,
  staticOptions,
} from '../../server-ops/lib/site-server.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const BROWSER = join(ROOT, 'dist', 'browser');
const dataDir = join(ROOT, 'data');
const applicationsPath = join(dataDir, 'applications.jsonl');

loadLocalEnv(join(ROOT, '.env'));

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const PASSWORD = process.env.HANDMARK_PASSWORD ?? (isProduction ? '' : 'handmark-dev-password');
const DEFAULT_SESSION_SECRET = 'handmark-local-development-secret-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET ?? (isProduction ? '' : DEFAULT_SESSION_SECRET);
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

if (isProduction && !process.env.HANDMARK_PASSWORD) {
  throw new Error('HANDMARK_PASSWORD must be set in production.');
}
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production.');
}

const app = express();
hardenApp(app);
app.use(securityHeaders());
app.use(compression());

app.get('/healthz', (_req, res) => {
  res.json(healthPayload('handmark.io', PORT));
});
app.get('/api/health', (_req, res) => {
  res.json(healthPayload('handmark.io', PORT));
});

app.get('/login', (_req, res) => sendBuiltFile(res, 'login.html'));
app.get('/login.html', (_req, res) => sendBuiltFile(res, 'login.html'));
app.get('/styles.css', (_req, res) => sendBuiltFile(res, 'styles.css'));
app.get('/robots.txt', (_req, res) => sendBuiltFile(res, 'robots.txt'));
app.get('/sitemap.xml', (_req, res) => sendBuiltFile(res, 'sitemap.xml'));
app.get('/site.webmanifest', (_req, res) => sendBuiltFile(res, 'site.webmanifest'));
app.use(
  '/assets',
  express.static(join(BROWSER, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }),
);

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

app.use(express.static(BROWSER, staticOptions()));
app.get('*', (_req, res) => sendBuiltFile(res, 'index.html'));

app.listen(PORT, HOST, () => {
  console.log(`[handmark] listening on http://${HOST}:${PORT}`);
});

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readFileSyncUtf8(filePath) {
  return readFileSync(filePath, 'utf8');
}

function sendBuiltFile(res, fileName) {
  const filePath = join(BROWSER, fileName);
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
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith('hm_session='))
    ?.slice('hm_session='.length);
  if (!token || !token.includes('.')) return false;

  const [encoded, signature] = decodeURIComponent(token).split('.');
  if (!encoded || !signature || !constantTimeEqual(sign(encoded), signature)) return false;

  try {
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

const rateBuckets = new Map();
function allowRequest(req, scope, maxRequests, windowMs) {
  const now = Date.now();
  const key = `${scope}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    cleanupRateBuckets(now);
    return true;
  }
  current.count += 1;
  return current.count <= maxRequests;
}

function cleanupRateBuckets(now) {
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function requireField(payload, field) {
  const value = String(payload[field] || '').trim();
  if (!value) throw new Error(`${field} is required.`);
  return value;
}

function requireEmail(payload) {
  const value = requireField(payload, 'email');
  if (!EMAIL_PATTERN.test(value)) throw new Error('Enter a valid email address.');
  return value;
}

async function handleApplication(req, res) {
  try {
    if (!allowRequest(req, 'apply', 30, 60 * 60 * 1000)) {
      res.status(429).json({ ok: false, message: 'Too many applications. Try again later.' });
      return;
    }

    const payload = req.body ?? {};
    const plan = requireField(payload, 'plan');
    if (plan !== 'verification') throw new Error('Choose a valid plan.');
    if (!payload.agree) throw new Error('Agreement is required.');

    const application = {
      id: `HM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      plan,
      billingCycle: String(payload.billingCycle || 'monthly'),
      name: requireField(payload, 'name'),
      email: requireEmail(payload),
      contactPreference: requireField(payload, 'contactPreference'),
      brand: requireField(payload, 'brand'),
      website: requireField(payload, 'website'),
      category: requireField(payload, 'category'),
      craftSummary: requireField(payload, 'craftSummary'),
      proofLinks: requireField(payload, 'proofLinks'),
      walkthroughPreference: String(payload.walkthroughPreference || '').trim(),
      paymentPreference: requireField(payload, 'paymentPreference'),
    };

    await appendApplication(application);
    res.status(201).json({
      ok: true,
      id: application.id,
      message: 'Application received. The next step is human review and process walkthrough.',
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Could not save the application.',
    });
  }
}

async function appendApplication(application) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(applicationsPath, `${JSON.stringify(application)}
`);
}

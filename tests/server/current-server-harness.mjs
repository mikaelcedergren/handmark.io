import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const CURRENT_PASSWORD = 'handmark-current-password';
export const CURRENT_SESSION_SECRET = 'handmark-current-session-secret-for-tests-only';
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const productionDataDir = path.join(repoRoot, 'data');
const nativeFetch = globalThis.fetch.bind(globalThis);

export function localFetch(input, init) {
  const url = new URL(String(input));
  assert.ok(
    ['127.0.0.1', '::1', 'localhost'].includes(url.hostname),
    `Current-behavior tests refuse non-loopback fetches: ${url.origin}`,
  );
  return nativeFetch(input, init);
}

export async function createCurrentFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'handmark-current-'));
  const browserDir = path.join(root, 'browser');
  const dataDir = path.join(root, 'data');
  const servers = [];
  await mkdir(path.join(browserDir, 'assets'), { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const [loginHtml, indexHtml, robots, manifest, logo, symbol] = await Promise.all([
    readFile(path.join(repoRoot, 'public', 'login.html')),
    readFile(path.join(repoRoot, 'src', 'index.html')),
    readFile(path.join(repoRoot, 'public', 'robots.txt')),
    readFile(path.join(repoRoot, 'public', 'site.webmanifest')),
    readFile(path.join(repoRoot, 'public', 'assets', 'handmark-logo.svg')),
    readFile(path.join(repoRoot, 'public', 'assets', 'handmark-symbol.svg')),
  ]);

  await Promise.all([
    writeFile(path.join(browserDir, 'login.html'), loginHtml),
    writeFile(path.join(browserDir, 'index.html'), indexHtml),
    writeFile(path.join(browserDir, 'styles.css'), 'body { color: black; }\n'),
    writeFile(path.join(browserDir, 'robots.txt'), robots),
    writeFile(path.join(browserDir, 'sitemap.xml'), '<urlset></urlset>\n'),
    writeFile(path.join(browserDir, 'site.webmanifest'), manifest),
    writeFile(
      path.join(browserDir, 'cx-build.json'),
      `${JSON.stringify({ buildId: 'current-characterization' })}\n`,
    ),
    writeFile(path.join(browserDir, 'main-CURRENT123.js'), 'globalThis.handmark = true;\n'),
    writeFile(path.join(browserDir, 'assets', 'handmark-logo.svg'), logo),
    writeFile(path.join(browserDir, 'assets', 'handmark-symbol.svg'), symbol),
  ]);

  assert.notEqual(path.resolve(dataDir), path.resolve(productionDataDir));
  const fixture = { browserDir, dataDir, root, servers };
  t.after(async () => {
    for (const server of [...servers].reverse()) {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill('SIGTERM');
        await waitForExit(server).catch(() => {
          server.child.kill('SIGKILL');
        });
      }
    }
    await rm(root, { force: true, recursive: true });
  });
  return fixture;
}

export async function startCurrentServer(
  fixture,
  { clockFile, nowMs, password = CURRENT_PASSWORD, sessionSecret = CURRENT_SESSION_SECRET } = {},
) {
  if (clockFile && nowMs !== undefined) {
    throw new Error('Configure either clockFile or nowMs, not both.');
  }
  const port = await reserveLoopbackPort();
  assert.notEqual(port, 3000, 'Current-behavior tests refuse the production port.');
  let output = '';
  const args = [];
  if (clockFile || nowMs !== undefined) {
    args.push('--import', path.join(repoRoot, 'tests', 'server', 'current-fixed-clock.mjs'));
  }
  args.push('server/index.mjs');

  const childEnvironment = {
    DATA_DIR: fixture.dataDir,
    HANDMARK_LOAD_ENV_FILE: 'false',
    HANDMARK_PASSWORD: password,
    HOST: '127.0.0.1',
    LANG: 'C',
    NODE_ENV: 'production',
    PATH: process.env.PATH,
    PORT: String(port),
    SESSION_SECRET: sessionSecret,
    SITE_BROWSER_DIR: fixture.browserDir,
    TMPDIR: fixture.root,
  };
  if (clockFile) childEnvironment.HANDMARK_CURRENT_CLOCK_FILE = clockFile;
  if (nowMs !== undefined) childEnvironment.HANDMARK_CURRENT_NOW_MS = String(nowMs);

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  const server = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    fixture,
    output: () => output,
    port,
  };
  fixture.servers.push(server);
  await waitForHealth(server);
  return server;
}

export async function createCurrentClock(fixture, initialNowMs) {
  assert.ok(Number.isSafeInteger(initialNowMs));
  const filePath = path.join(fixture.root, 'clock.txt');
  const set = async (nowMs) => {
    assert.ok(Number.isSafeInteger(nowMs));
    await writeFile(filePath, String(nowMs));
  };
  await set(initialNowMs);
  return { filePath, set };
}

export async function stopCurrentServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
  }
  const result = await waitForExit(server);
  assert.deepEqual(result, { code: 0, signal: null }, server.output());
  assert.match(server.output(), /shutting down \(SIGTERM\)/);
}

export async function waitForExit(server, timeoutMs = 12_000) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return { code: server.child.exitCode, signal: server.child.signalCode };
  }
  return await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Handmark server did not exit in time.\n${server.output()}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    server.child.once('exit', onExit);
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      server.child.off('exit', onExit);
      clearTimeout(timeout);
      resolveExit({ code: server.child.exitCode, signal: server.child.signalCode });
    }
  });
}

export async function waitForOutput(server, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(server.output())) return;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Handmark exited before expected output.\n${server.output()}`);
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${pattern}.\n${server.output()}`);
}

export async function login(
  server,
  { forwardedFor, origin, password = CURRENT_PASSWORD, proto } = {},
) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  if (origin) headers.origin = origin;
  if (proto) headers['x-forwarded-proto'] = proto;
  const response = await localFetch(`${server.baseUrl}/login`, {
    body: new URLSearchParams({ password }),
    headers,
    method: 'POST',
    redirect: 'manual',
  });
  return response;
}

export function cookiePair(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected a Set-Cookie response header.');
  return setCookie.split(';', 1)[0];
}

export function signedSessionCookie(payload, sessionSecret = CURRENT_SESSION_SECRET, suffix = '') {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `hm_session=${encoded}.${signature}${suffix}`;
}

export function jsonBodyWithExactBytes(payload, targetBytes) {
  const empty = JSON.stringify({ ...payload, ignoredPadding: '' });
  const paddingBytes = targetBytes - Buffer.byteLength(empty);
  assert.ok(paddingBytes >= 0, 'Target body is smaller than the base payload.');
  const body = JSON.stringify({ ...payload, ignoredPadding: 'x'.repeat(paddingBytes) });
  assert.equal(Buffer.byteLength(body), targetBytes);
  return body;
}

export function formBodyWithExactBytes(password, targetBytes) {
  const prefix = `password=${encodeURIComponent(password)}&ignoredPadding=`;
  const paddingBytes = targetBytes - Buffer.byteLength(prefix);
  assert.ok(paddingBytes >= 0, 'Target body is smaller than the login payload.');
  const body = `${prefix}${'x'.repeat(paddingBytes)}`;
  assert.equal(Buffer.byteLength(body), targetBytes);
  return body;
}

async function waitForHealth(server) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Handmark exited before health was ready.\n${server.output()}`);
    }
    try {
      const response = await localFetch(`${server.baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The child has not started listening yet.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for Handmark health.\n${server.output()}`);
}

async function reserveLoopbackPort() {
  const reservation = net.createServer();
  await new Promise((resolveListen, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolveListen);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolveClose, reject) => {
    reservation.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

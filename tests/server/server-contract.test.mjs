import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const PASSWORD = 'handmark-contract-password';
const SESSION_SECRET = 'handmark-contract-session-secret-not-for-production';
const ROOT_PREFIX = 'handmark-server-contract-';
const OUTPUT_LIMIT_BYTES = 512 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const compiledEntrypoint = path.join(repoRoot, 'server', 'dist', 'index.js');
const externalFetchGuard = path.join(repoRoot, 'tests', 'support', 'block-external-fetch.mjs');
const nativeFetch = globalThis.fetch.bind(globalThis);
const require = createRequire(import.meta.url);
const {
  createE2EServerEnvironment,
  E2E_SERVER_ENVIRONMENT_KEYS,
} = require('../e2e/web-server-environment.cjs');

const validApplication = Object.freeze({
  agree: true,
  billingCycle: 'monthly',
  brand: 'Contract studio',
  category: 'Furniture',
  contactPreference: 'Email',
  craftSummary: 'A human-made process.',
  email: 'contract@example.com',
  name: 'Contract maker',
  paymentPreference: 'after-approval',
  plan: 'verification',
  proofLinks: 'https://example.com/proof',
  walkthroughPreference: 'Video call',
  website: 'https://example.com',
});

test('the E2E controller passes only the explicit synthetic environment to its server child', () => {
  const environment = createE2EServerEnvironment({
    pathValue: '/synthetic/bin',
    port: 50_123,
    runtimeRoot: '/private/tmp/handmark-e2e-AbC123',
    runtimeTemp: '/private/tmp/handmark-e2e-AbC123/tmp',
  });
  assert.deepEqual(Object.keys(environment).sort(), E2E_SERVER_ENVIRONMENT_KEYS);
  for (const forbidden of ['HOME', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']) {
    assert.equal(Object.hasOwn(environment, forbidden), false, forbidden);
  }
});

test('compiled server preserves auth, intake, SQLite, restart, and shutdown contracts', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const health = await localFetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { app: 'handmark', ok: true, port: server.port });
    assert.equal(health.headers.get('cache-control'), 'no-store');

    const gate = await localFetch(`${server.baseUrl}/login`);
    assert.equal(gate.status, 200);
    assert.match(await gate.text(), /Human-made work, verified\./);

    const failed = await unlock(server.baseUrl, 'incorrect-password');
    assert.equal(failed.status, 302);
    assert.equal(failed.headers.get('location'), '/login?error=1');

    const login = await unlock(server.baseUrl, PASSWORD);
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /^hm_session=[A-Za-z0-9_.-]+;/);
    const cookie = setCookie.split(';', 1)[0];

    const protectedPage = await localFetch(`${server.baseUrl}/`, { headers: { cookie } });
    assert.equal(protectedPage.status, 200);
    assert.match(await protectedPage.text(), /Handmark fixture/);

    const rejectedOrigin = await localFetch(`${server.baseUrl}/api/apply`, {
      body: JSON.stringify(validApplication),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://not-handmark.example',
      },
      method: 'POST',
    });
    assert.equal(rejectedOrigin.status, 403);

    const submitted = await localFetch(`${server.baseUrl}/api/apply`, {
      body: JSON.stringify(validApplication),
      headers: { 'content-type': 'application/json', cookie, origin: server.baseUrl },
      method: 'POST',
    });
    assert.equal(submitted.status, 201);
    const accepted = await submitted.json();
    assert.match(accepted.id, /^HM-[0-9A-F]{8}$/);

    await stopServer(server);
    server = undefined;
    assertStoredApplication(fixture.databasePath, accepted.id);

    server = await startServer(fixture);
    const restarted = await localFetch(`${server.baseUrl}/`, { headers: { cookie } });
    assert.equal(restarted.status, 200);
    assertStoredApplication(fixture.databasePath, accepted.id);

    const logout = await localFetch(`${server.baseUrl}/logout`, {
      headers: { cookie, origin: server.baseUrl },
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/login');
  } finally {
    if (server) await stopServer(server);
    removeFixture(fixture);
  }
});

test('ordinary production refuses a missing database and never creates a replacement', async () => {
  const fixture = createFixture();
  let server;
  try {
    const identityFile = prepareProductionFixture(fixture);
    const port = await reservePort();
    server = spawnServerProcess(fixture, port, { identityFile, production: true });
    const code = await waitForExit(server, 8_000);
    assert.notEqual(code, 0, server.output());
    assert.equal(existsSync(fixture.databasePath), false);
    assert.doesNotMatch(server.output(), /\[handmark\] listening/);
  } finally {
    if (server?.child.exitCode === null) {
      server.child.kill('SIGKILL');
      await waitForExit(server);
    }
    removeFixture(fixture);
  }
});

function createFixture() {
  assert.ok(lstatSync(compiledEntrypoint).isFile(), 'Build server/dist/index.js before this test.');
  assert.ok(lstatSync(externalFetchGuard).isFile());
  const canonicalTemp = realpathSync(os.tmpdir());
  const root = realpathSync(mkdtempSync(path.join(canonicalTemp, ROOT_PREFIX)));
  const token = randomUUID();
  const ownerFile = path.join(root, '.handmark-test-owner');
  writeFileSync(ownerFile, `${token}\n`, { flag: 'wx', mode: 0o600 });
  const browserDir = path.join(root, 'browser');
  const dataDir = path.join(root, 'data');
  const databasePath = path.join(dataDir, 'handmark.sqlite');
  mkdirSync(path.join(browserDir, 'assets', 'fonts'), { mode: 0o700, recursive: true });
  mkdirSync(dataDir, { mode: 0o700 });
  writeBrowserFixture(browserDir);
  return { browserDir, dataDir, databasePath, ownerFile, root, token };
}

function prepareProductionFixture(fixture) {
  const browserDir = path.join(fixture.root, 'dist', 'browser');
  mkdirSync(path.join(browserDir, 'assets', 'fonts'), { mode: 0o700, recursive: true });
  writeBrowserFixture(browserDir);
  writeFileSync(
    path.join(fixture.root, '.env.web'),
    `HANDMARK_PASSWORD=${PASSWORD}\nSESSION_SECRET=${SESSION_SECRET}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const artifactDigest = 'a'.repeat(64);
  const identityFile = path.join(fixture.root, 'server-release.json');
  writeFileSync(
    identityFile,
    `${JSON.stringify({
      artifactBytes: 1,
      artifactDigest,
      artifactFiles: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
      entrypoint: 'server/dist/index.js',
      nodeMajor: 26,
      releaseId: 'handmark-production-contract',
      revision: '0'.repeat(40),
      schemaVersion: 1,
      serverBuildId: `server-${artifactDigest}`,
      sourceDirty: true,
      sourceFingerprint: 'b'.repeat(64),
      workers: [],
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return identityFile;
}

function writeBrowserFixture(browserDir) {
  const files = new Map([
    ['index.html', '<!doctype html><html><body><h1>Handmark fixture</h1></body></html>'],
    ['styles.css', 'body { color: black; }'],
    ['robots.txt', 'User-agent: *\nAllow: /\n'],
    ['sitemap.xml', '<urlset></urlset>'],
    ['site.webmanifest', '{"name":"Handmark"}\n'],
    ['cx-build.json', '{"buildId":"handmark-contract"}\n'],
    ['main-ABCDEF12.js', 'globalThis.handmarkFixture = true;'],
    ['assets/handmark-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['assets/handmark-symbol.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['assets/handmark-stamp.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
  ]);
  for (const [relativePath, contents] of files) {
    writeFileSync(path.join(browserDir, relativePath), contents, { flag: 'wx' });
  }
}

async function startServer(fixture) {
  const port = await reservePort();
  const server = spawnServerProcess(fixture, port);
  await waitForHealth(server);
  return server;
}

function spawnServerProcess(fixture, port, { identityFile, production = false } = {}) {
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let output = '';
  const child = spawn(process.execPath, ['--import', externalFetchGuard, compiledEntrypoint], {
    cwd: fixture.root,
    env: {
      APP_BASE_URL: production ? 'https://handmark.io' : baseUrl,
      CX_TEST_ALLOWED_ORIGIN: baseUrl,
      ...(production
        ? { CX_SERVER_RELEASE_IDENTITY_FILE: identityFile }
        : {
            HANDMARK_LOAD_ENV_FILE: 'false',
            HANDMARK_PASSWORD: PASSWORD,
            SESSION_SECRET,
            SITE_BROWSER_DIR: fixture.browserDir,
          }),
      DATA_DIR: 'data',
      DB_PATH: 'data/handmark.sqlite',
      HOST: '127.0.0.1',
      NODE_ENV: production ? 'production' : 'test',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    output += String(chunk);
    if (Buffer.byteLength(output, 'utf8') > OUTPUT_LIMIT_BYTES) child.kill('SIGKILL');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { baseUrl, child, output: () => output, port };
}

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth(server) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Handmark exited before health was ready.\n${server.output()}`);
    }
    try {
      const response = await localFetch(`${server.baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The owned child has not opened its loopback socket yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Handmark health.\n${server.output()}`);
}

async function stopServer(server) {
  if (server.child.exitCode === null) server.child.kill('SIGTERM');
  assert.equal(await waitForExit(server), 0, server.output());
  assert.match(server.output(), /shutting down \(SIGTERM\)/);
}

async function waitForExit(server, timeoutMs = 12_000) {
  if (server.child.exitCode !== null) return server.child.exitCode;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL');
      reject(new Error(`Handmark server did not exit in time.\n${server.output()}`));
    }, timeoutMs);
    server.child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function unlock(baseUrl, password) {
  return await localFetch(`${baseUrl}/login`, {
    body: new URLSearchParams({ password }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    redirect: 'manual',
  });
}

function assertStoredApplication(databasePath, expectedId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT id, record_json, record_hash FROM applications').get();
    assert.equal(row.id, expectedId);
    const canonical = Buffer.from(row.record_json);
    assert.equal(createHash('sha256').update(canonical).digest('hex'), row.record_hash);
  } finally {
    database.close();
  }
}

function removeFixture(fixture) {
  assert.equal(realpathSync(fixture.root), fixture.root);
  assert.equal(readFileSync(fixture.ownerFile, 'utf8'), `${fixture.token}\n`);
  rmSync(fixture.root, { force: false, recursive: true });
}

function localFetch(input, init) {
  const url = new URL(String(input));
  assert.ok(['127.0.0.1', '::1', 'localhost'].includes(url.hostname));
  return nativeFetch(input, init);
}

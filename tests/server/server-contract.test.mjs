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
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT_PREFIX = 'handmark-server-contract-';
const ROOT_PATTERN = /^handmark-server-contract-[A-Za-z0-9]{6}$/;
const OWNER_FILE = '.handmark-test-owner';
const OWNER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const PASSWORD = 'handmark-contract-password';
const SESSION_SECRET = 'handmark-contract-session-secret-not-for-production';
const ROTATED_SESSION_SECRET = 'handmark-rotated-session-secret-not-for-production';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const compiledEntrypoint = path.join(repoRoot, 'server', 'dist', 'index.js');
const compiledImporter = path.join(repoRoot, 'server', 'dist', 'application-import.js');
const externalFetchGuard = path.join(repoRoot, 'tests', 'support', 'block-external-fetch.mjs');
const productionDataRoot = path.join(repoRoot, 'data');
const nativeFetch = globalThis.fetch.bind(globalThis);
const require = createRequire(import.meta.url);
const {
  createE2EServerEnvironment,
  E2E_SERVER_ENVIRONMENT_KEYS,
} = require('../e2e/web-server-environment.cjs');

const FONT_FILES = Object.freeze([
  'ArchivoNarrow.woff2',
  'DMSerifDisplay.woff2',
  'InterVariable-Italic.woff2',
  'InterVariable.woff2',
  'PlusJakartaSans.woff2',
  'RobotoMono.woff2',
  'Rubik.woff2',
]);

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
  assert.equal(Object.isFrozen(environment), true);
  for (const forbidden of [
    'HOME',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'HANDMARK_E2E_RUNTIME_ROOT',
    'HANDMARK_E2E_RUNTIME_TOKEN',
  ]) {
    assert.equal(Object.hasOwn(environment, forbidden), false, forbidden);
  }
});

test('compiled server preserves the gate, HTTP, SQLite, restart, and shutdown contracts', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const { baseUrl } = server;

    const health = await localFetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { app: 'handmark', ok: true, port: fixture.port });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assertSecurityHeaders(health);

    const spoofedRequestId = 'client-supplied-request-id';
    const requestIdProbe = await localFetch(`${baseUrl}/healthz`, {
      headers: { 'x-request-id': spoofedRequestId },
    });
    const assignedRequestId = requestIdProbe.headers.get('x-request-id');
    assert.match(assignedRequestId ?? '', /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/);
    assert.notEqual(assignedRequestId, spoofedRequestId);

    const gatePage = await localFetch(`${baseUrl}/login`);
    assert.equal(gatePage.status, 200);
    assert.equal(gatePage.headers.get('cache-control'), 'no-store');
    assert.equal(gatePage.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(
      gatePage.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const gateHtml = await gatePage.text();
    assert.match(gateHtml, /Human-made work, verified\./);
    assert.match(gateHtml, /<form class="login-form" method="post" action="\/login">/);
    assert.doesNotMatch(gateHtml, /<script\b/i);
    assert.doesNotMatch(gateHtml, /Incorrect password\. Try again\./);

    const failedUnlock = await unlock(baseUrl, 'incorrect-password');
    assert.equal(failedUnlock.status, 302);
    assert.equal(failedUnlock.headers.get('location'), '/login?error=1');
    const failedPage = await localFetch(`${baseUrl}/login?error=1`);
    const failedHtml = await failedPage.text();
    assert.match(failedHtml, /Incorrect password\. Try again\./);
    assert.match(failedHtml, /role="alert"/);
    assert.doesNotMatch(failedHtml, /<script\b/i);

    await assertPublicAssetContract(baseUrl);
    await assertSelectivePreAuthContract(baseUrl);

    const lockedMalformed = await localFetch(`${baseUrl}/api/apply`, {
      body: '{',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await assertJsonError(lockedMalformed, 401, 'gate_locked', 'Handmark is not open yet.');

    const unlockResponse = await unlock(baseUrl, PASSWORD);
    assert.equal(unlockResponse.status, 302);
    assert.equal(unlockResponse.headers.get('location'), '/');
    const setCookie = unlockResponse.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /^hm_session=[A-Za-z0-9_.-]+; Path=\/; Max-Age=43200;/);
    assert.match(setCookie, /; HttpOnly;/);
    assert.match(setCookie, /; SameSite=Lax$/);
    assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);
    const cookie = setCookie.split(';', 1)[0];

    for (const requestPath of ['/', '/an-authenticated-route', '/index.html']) {
      const page = await localFetch(`${baseUrl}${requestPath}`, { headers: { cookie } });
      assert.equal(page.status, 200, requestPath);
      assert.equal(page.headers.get('cache-control'), 'no-store', requestPath);
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow', requestPath);
      assert.match(await page.text(), /Handmark fixture/, requestPath);
    }

    const hashedAsset = await localFetch(`${baseUrl}/main-ABCDEF12.js`, {
      headers: { cookie },
    });
    assert.equal(hashedAsset.status, 200);
    assert.equal(hashedAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(hashedAsset.headers.get('x-robots-tag'), 'noindex, nofollow');

    const authenticatedStamp = await localFetch(`${baseUrl}/assets/handmark-stamp.svg`, {
      headers: { cookie },
    });
    assert.equal(authenticatedStamp.status, 200);
    assert.equal(authenticatedStamp.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(authenticatedStamp.headers.get('x-robots-tag'), 'noindex, nofollow');

    const duplicateCookie = await localFetch(`${baseUrl}/`, {
      headers: { cookie: `${cookie}; ${cookie}` },
      redirect: 'manual',
    });
    assert.equal(duplicateCookie.status, 302);
    assert.equal(duplicateCookie.headers.get('location'), '/login');

    for (const invalidCookie of ['hm_session=legacy-token', 'hm_session=%']) {
      const response = await localFetch(`${baseUrl}/`, {
        headers: { cookie: invalidCookie },
        redirect: 'manual',
      });
      assert.equal(response.status, 302, invalidCookie);
      assert.equal(response.headers.get('location'), '/login', invalidCookie);
    }

    const tamperedCookie = mutateCookieToken(cookie);
    const rejectedTamper = await localFetch(`${baseUrl}/`, {
      headers: { cookie: tamperedCookie },
      redirect: 'manual',
    });
    assert.equal(rejectedTamper.status, 302);
    assert.equal(rejectedTamper.headers.get('location'), '/login');

    const originBeforeParser = await localFetch(`${baseUrl}/api/apply`, {
      body: '{',
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    });
    await assertJsonError(
      originBeforeParser,
      403,
      'origin_required',
      'This request must include its origin.',
    );

    const rejectedOrigin = await localFetch(`${baseUrl}/api/apply`, {
      body: JSON.stringify(validApplication),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://not-handmark.example',
      },
      method: 'POST',
    });
    await assertJsonError(
      rejectedOrigin,
      403,
      'origin_not_allowed',
      'This request came from an origin that is not allowed.',
    );

    const malformed = await localFetch(`${baseUrl}/api/apply`, {
      body: '{',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: baseUrl,
      },
      method: 'POST',
    });
    await assertJsonError(malformed, 400, 'invalid_json', 'The request body is not valid JSON.');

    const oversized = await localFetch(`${baseUrl}/api/apply`, {
      body: JSON.stringify({ ...validApplication, craftSummary: 'x'.repeat(70 * 1024) }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: baseUrl,
      },
      method: 'POST',
    });
    await assertJsonError(oversized, 413, 'request_too_large', 'The request body is too large.');

    const unknownApi = await localFetch(`${baseUrl}/api/not-a-route`, { headers: { cookie } });
    await assertJsonError(
      unknownApi,
      404,
      'route_not_found',
      'No route exists at /api/not-a-route.',
    );

    const application = await localFetch(`${baseUrl}/api/apply`, {
      body: JSON.stringify(validApplication),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: baseUrl,
      },
      method: 'POST',
    });
    assert.equal(application.status, 201);
    assert.equal(application.headers.get('cache-control'), 'private, no-store');
    const accepted = await application.json();
    assert.deepEqual(accepted, {
      id: accepted.id,
      message: 'Application received. The next step is human review and process walkthrough.',
      ok: true,
    });
    assert.match(accepted.id, /^HM-[0-9A-F]{8}$/);

    await stopServer(server);
    server = undefined;
    assertStoredApplication(fixture.databasePath, accepted.id);
    assert.equal(statSync(fixture.databasePath).mode & 0o777, 0o600);

    server = await startServer(fixture, { sessionSecret: ROTATED_SESSION_SECRET });
    const rejectedRotatedSecret = await localFetch(`${server.baseUrl}/`, {
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(rejectedRotatedSecret.status, 302);
    assert.equal(rejectedRotatedSecret.headers.get('location'), '/login');
    await stopServer(server);
    server = undefined;

    server = await startServer(fixture);
    const restartedPage = await localFetch(`${server.baseUrl}/`, { headers: { cookie } });
    assert.equal(restartedPage.status, 200);
    assert.match(await restartedPage.text(), /Handmark fixture/);
    assertStoredApplication(fixture.databasePath, accepted.id);

    const logout = await localFetch(`${server.baseUrl}/logout`, {
      headers: { cookie, origin: server.baseUrl },
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/login');
    const clearedCookie = logout.headers.get('set-cookie');
    assert.ok(clearedCookie);
    assert.match(clearedCookie, /^hm_session=; Path=\/; Max-Age=0;/);
    assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    assert.match(clearedCookie, /HttpOnly/);
    assert.match(clearedCookie, /SameSite=Lax/);
  } finally {
    if (server) await stopServer(server);
    removeFixture(fixture);
  }
});

test('compiled server rate limits only requests that reach the owning limiter', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await unlock(server.baseUrl, 'wrong-password', '198.51.100.70');
      assert.equal(response.status, 302, `gate attempt ${attempt + 1}`);
    }
    const deniedGate = await unlock(server.baseUrl, 'wrong-password', '198.51.100.70');
    assert.equal(deniedGate.status, 429);
    assert.equal(await deniedGate.text(), 'Too many attempts. Try again in a few minutes.');
    assert.ok(Number(deniedGate.headers.get('retry-after')) >= 1);

    const login = await unlock(server.baseUrl, PASSWORD, '198.51.100.71');
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie);
    const cookie = setCookie.split(';', 1)[0];

    for (let index = 0; index < 3; index += 1) {
      const malformed = await localFetch(`${server.baseUrl}/api/apply`, {
        body: '{',
        headers: { 'content-type': 'application/json', cookie, origin: server.baseUrl },
        method: 'POST',
      });
      assert.equal(malformed.status, 400);
      const missingOrigin = await localFetch(`${server.baseUrl}/api/apply`, {
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      });
      assert.equal(missingOrigin.status, 403);
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await localFetch(`${server.baseUrl}/api/apply`, {
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json', cookie, origin: server.baseUrl },
        method: 'POST',
      });
      await assertJsonError(response, 400, 'invalid_application', 'plan must be text.');
      assert.equal(response.headers.get('ratelimit-limit'), '30');
      assert.equal(response.headers.get('ratelimit-remaining'), String(29 - attempt));
    }

    const deniedIntake = await localFetch(`${server.baseUrl}/api/apply`, {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json', cookie, origin: server.baseUrl },
      method: 'POST',
    });
    await assertJsonError(
      deniedIntake,
      429,
      'application_rate_limited',
      'Too many applications. Try again later.',
    );
    assert.equal(deniedIntake.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(deniedIntake.headers.get('retry-after')) >= 1);
  } finally {
    if (server) await stopServer(server);
    removeFixture(fixture);
  }
});

test('compiled server reports essential SQLite failure through health and intake', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const login = await unlock(server.baseUrl, PASSWORD);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie);
    const cookie = setCookie.split(';', 1)[0];

    const external = new DatabaseSync(fixture.databasePath);
    try {
      external.exec('DROP TABLE applications');
    } finally {
      external.close();
    }

    const health = await localFetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 503);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { ok: false });

    const application = await localFetch(`${server.baseUrl}/api/apply`, {
      body: JSON.stringify(validApplication),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: server.baseUrl,
      },
      method: 'POST',
    });
    await assertJsonError(
      application,
      503,
      'application_storage_error',
      'Application storage needs administrator attention. No application was written.',
    );
  } finally {
    if (server) await stopServer(server);
    removeFixture(fixture);
  }
});

test('compiled startup reports an occupied listener honestly', async () => {
  const fixture = createFixture();
  const occupied = net.createServer();
  let childServer;
  try {
    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen({ exclusive: true, host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = occupied.address();
    assert.ok(address && typeof address === 'object');
    assert.notEqual(address.port, 3000);

    childServer = spawnServerProcess(fixture, address.port);
    const exitCode = await waitForExit(childServer, 8_000);
    assert.notEqual(exitCode, 0, childServer.output());
    assert.match(childServer.output(), /EADDRINUSE/);
    assert.doesNotMatch(childServer.output(), /\[handmark\] listening/);
  } finally {
    if (childServer?.child.exitCode === null) {
      childServer.child.kill('SIGKILL');
      await waitForExit(childServer);
    }
    await new Promise((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
    removeFixture(fixture);
  }
});

test('occupied startup cannot prune imported retention-boundary rows or their receipt', async () => {
  const fixture = createFixture();
  const occupied = net.createServer();
  let childServer;
  try {
    const observedNow = Date.now();
    const cutoff = observedNow - 90 * 24 * 60 * 60 * 1_000;
    const records = [-1, 0, 1].map((offset, index) => ({
      id: `HM-${String(index + 1).padStart(8, '0')}`,
      createdAt: new Date(cutoff + offset).toISOString(),
      plan: 'verification',
      billingCycle: 'monthly',
      name: `Boundary maker ${String(index + 1)}`,
      email: `boundary-${String(index + 1)}@example.com`,
      contactPreference: 'Email',
      brand: 'Boundary studio',
      website: 'https://example.com',
      category: 'Furniture',
      craftSummary: 'Made by a person.',
      proofLinks: 'https://example.com/proof',
      walkthroughPreference: '',
      paymentPreference: 'after-approval',
    }));
    const sourcePath = path.join(fixture.dataDir, 'applications.jsonl');
    const sourceBytes = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    writeFileSync(sourcePath, sourceBytes, { flag: 'wx', mode: 0o600 });
    await importLegacyApplications(sourcePath, fixture.databasePath);
    const databaseBefore = readCutoverState(fixture.databasePath);

    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen({ exclusive: true, host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = occupied.address();
    assert.ok(address && typeof address === 'object');
    assert.notEqual(address.port, 3000);

    childServer = spawnServerProcess(fixture, address.port);
    const exitCode = await waitForExit(childServer, 8_000);
    assert.notEqual(exitCode, 0, childServer.output());
    assert.match(childServer.output(), /EADDRINUSE/);
    assert.doesNotMatch(childServer.output(), /expired applications removed/);
    assert.deepEqual(readCutoverState(fixture.databasePath), databaseBefore);
    assert.deepEqual(readFileSync(sourcePath), sourceBytes);
  } finally {
    if (childServer?.child.exitCode === null) {
      childServer.child.kill('SIGKILL');
      await waitForExit(childServer);
    }
    await new Promise((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
    removeFixture(fixture);
  }
});

test('compiled startup never opens an empty SQLite target beside an unimported legacy source', async () => {
  const fixture = createFixture();
  const occupied = net.createServer();
  let childServer;
  try {
    const legacyRecord = {
      id: 'HM-00000001',
      createdAt: '2026-08-25T00:00:00.000Z',
      plan: 'verification',
      billingCycle: 'monthly',
      name: 'Legacy maker',
      email: 'legacy@example.com',
      contactPreference: 'Email',
      brand: 'Legacy studio',
      website: 'https://example.com',
      category: 'Furniture',
      craftSummary: 'Made by a person.',
      proofLinks: 'https://example.com/proof',
      walkthroughPreference: '',
      paymentPreference: 'after-approval',
    };
    writeFileSync(
      path.join(fixture.dataDir, 'applications.jsonl'),
      `${JSON.stringify(legacyRecord)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen({ exclusive: true, host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = occupied.address();
    assert.ok(address && typeof address === 'object');
    assert.notEqual(address.port, 3000);

    childServer = spawnServerProcess(fixture, address.port);
    const exitCode = await waitForExit(childServer, 8_000);
    assert.equal(
      existsSync(fixture.databasePath),
      false,
      'Legacy-source interlock must run before SQLite creation or listen failure.',
    );
    assert.notEqual(exitCode, 0, childServer.output());
  } finally {
    if (childServer?.child.exitCode === null) {
      childServer.child.kill('SIGKILL');
      await waitForExit(childServer);
    }
    await new Promise((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
    removeFixture(fixture);
  }
});

test('compiled startup accepts only the exact still-present legacy source sealed by its receipt', async () => {
  const exactFixture = createFixture();
  const mismatchedFixture = createFixture();
  let exactServer;
  let mismatchedServer;
  const legacyRecord = {
    id: 'HM-00000001',
    createdAt: new Date().toISOString(),
    plan: 'verification',
    billingCycle: 'monthly',
    name: 'Imported maker',
    email: 'imported@example.com',
    contactPreference: 'Email',
    brand: 'Imported studio',
    website: 'https://example.com',
    category: 'Furniture',
    craftSummary: 'Made by a person.',
    proofLinks: 'https://example.com/proof',
    walkthroughPreference: '',
    paymentPreference: 'after-approval',
  };
  try {
    for (const fixture of [exactFixture, mismatchedFixture]) {
      const sourcePath = path.join(fixture.dataDir, 'applications.jsonl');
      writeFileSync(sourcePath, `${JSON.stringify(legacyRecord)}\n`, { flag: 'wx', mode: 0o600 });
      await importLegacyApplications(sourcePath, fixture.databasePath);
    }

    exactServer = await startServer(exactFixture);
    const health = await localFetch(`${exactServer.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    await stopServer(exactServer);

    const mismatchedSource = path.join(mismatchedFixture.dataDir, 'applications.jsonl');
    writeFileSync(
      mismatchedSource,
      `${JSON.stringify({ ...legacyRecord, brand: 'Changed studio' })}\n`,
    );
    const databaseBefore = createHash('sha256')
      .update(readFileSync(mismatchedFixture.databasePath))
      .digest('hex');
    mismatchedServer = spawnServerProcess(mismatchedFixture, await reservePort());
    const exitCode = await waitForExit(mismatchedServer, 8_000);
    assert.notEqual(exitCode, 0, mismatchedServer.output());
    assert.match(mismatchedServer.output(), /does not prove an exact import/);
    assert.doesNotMatch(mismatchedServer.output(), /\[handmark\] listening/);
    assert.equal(
      createHash('sha256').update(readFileSync(mismatchedFixture.databasePath)).digest('hex'),
      databaseBefore,
      'A mismatched source must be rejected through a read-only database preflight.',
    );
  } finally {
    if (exactServer?.child.exitCode === null) await stopServer(exactServer);
    if (mismatchedServer?.child.exitCode === null) {
      mismatchedServer.child.kill('SIGKILL');
      await waitForExit(mismatchedServer);
    }
    removeFixture(exactFixture);
    removeFixture(mismatchedFixture);
  }
});

test('ordinary production requires a durable sealed receipt after legacy evidence removal', async () => {
  const missingFixture = createFixture();
  const unsealedFixture = createFixture();
  const importedFixture = createFixture();
  let missingServer;
  let unsealedServer;
  let importedServer;
  try {
    const missingIdentity = prepareProductionFixture(missingFixture, { browser: true });
    const unsealedIdentity = prepareProductionFixture(unsealedFixture, { browser: true });
    const importedIdentity = prepareProductionFixture(importedFixture, { browser: true });

    missingServer = spawnServerProcess(missingFixture, await reservePort(), {
      productionIdentityFile: missingIdentity,
    });
    const missingExit = await waitForExit(missingServer, 8_000);
    assert.notEqual(missingExit, 0, missingServer.output());
    assert.match(missingServer.output(), /must be imported.*before startup/);
    assert.doesNotMatch(missingServer.output(), /\[handmark\] listening/);
    assert.equal(existsSync(missingFixture.databasePath), false);

    await createCanonicalDatabaseWithoutReceipt(unsealedFixture);
    const unsealedBefore = readFileSync(unsealedFixture.databasePath);
    unsealedServer = spawnServerProcess(unsealedFixture, await reservePort(), {
      productionIdentityFile: unsealedIdentity,
    });
    const unsealedExit = await waitForExit(unsealedServer, 8_000);
    assert.notEqual(unsealedExit, 0, unsealedServer.output());
    assert.match(unsealedServer.output(), /does not contain a sealed legacy import receipt/);
    assert.doesNotMatch(unsealedServer.output(), /\[handmark\] listening/);
    assert.deepEqual(readFileSync(unsealedFixture.databasePath), unsealedBefore);

    const sourcePath = path.join(importedFixture.dataDir, 'applications.jsonl');
    const importedRecord = {
      id: 'HM-00000001',
      createdAt: new Date().toISOString(),
      plan: 'verification',
      billingCycle: 'monthly',
      name: 'Receipt-backed maker',
      email: 'receipt-backed@example.com',
      contactPreference: 'Email',
      brand: 'Receipt-backed studio',
      website: 'https://example.com',
      category: 'Furniture',
      craftSummary: 'Made by a person.',
      proofLinks: 'https://example.com/proof',
      walkthroughPreference: '',
      paymentPreference: 'after-approval',
    };
    writeFileSync(sourcePath, `${JSON.stringify(importedRecord)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await importLegacyApplications(sourcePath, importedFixture.databasePath);
    const importedBefore = readCutoverState(importedFixture.databasePath);
    unlinkSync(sourcePath);

    importedServer = await startServer(importedFixture, {
      productionIdentityFile: importedIdentity,
    });
    const health = await localFetch(`${importedServer.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    await stopServer(importedServer);
    importedServer = undefined;
    assert.deepEqual(readCutoverState(importedFixture.databasePath), importedBefore);
  } finally {
    for (const server of [missingServer, unsealedServer, importedServer]) {
      if (server?.child.exitCode === null) {
        server.child.kill('SIGKILL');
        await waitForExit(server);
      }
    }
    removeFixture(missingFixture);
    removeFixture(unsealedFixture);
    removeFixture(importedFixture);
  }
});

function createFixture() {
  assert.ok(lstatSync(compiledEntrypoint).isFile(), 'Build server/dist/index.js before this test.');
  assert.ok(lstatSync(externalFetchGuard).isFile());
  const canonicalTemp = realpathSync(os.tmpdir());
  const root = realpathSync(mkdtempSync(path.join(canonicalTemp, ROOT_PREFIX)));
  assert.equal(path.dirname(root), canonicalTemp);
  assert.match(path.basename(root), ROOT_PATTERN);
  const rootEntry = lstatSync(root);
  assert.ok(rootEntry.isDirectory() && !rootEntry.isSymbolicLink());
  assert.equal(rootEntry.mode & 0o777, 0o700);
  const token = randomUUID();
  const ownerFile = path.join(root, OWNER_FILE);
  writeFileSync(ownerFile, `${token}\n`, { flag: 'wx', mode: 0o600 });

  const browserDir = path.join(root, 'browser');
  const dataDir = path.join(root, 'data');
  const databasePath = path.join(dataDir, 'handmark.sqlite');
  mkdirSync(path.join(browserDir, 'assets', 'fonts'), { mode: 0o700, recursive: true });
  mkdirSync(dataDir, { mode: 0o700 });
  writeBrowserFixture(browserDir);
  assert.notEqual(path.resolve(dataDir), path.resolve(productionDataRoot));
  return { browserDir, dataDir, databasePath, ownerFile, port: undefined, root, token };
}

async function importLegacyApplications(sourcePath, databasePath) {
  const importer = await import(pathToFileURL(compiledImporter).href);
  await importer.importApplicationsJsonl({ databasePath, sourcePath });
}

async function createCanonicalDatabaseWithoutReceipt(fixture) {
  const repositoryModule = await import(
    pathToFileURL(path.join(repoRoot, 'server', 'dist', 'application-repository.js')).href
  );
  const repository = repositoryModule.openApplicationRepository({
    databasePath: fixture.databasePath,
    operationalRoot: fixture.root,
  });
  repository.close();
}

function prepareProductionFixture(fixture, { browser }) {
  if (browser) {
    const browserDir = path.join(fixture.root, 'dist', 'browser');
    mkdirSync(path.join(browserDir, 'assets', 'fonts'), { mode: 0o700, recursive: true });
    writeBrowserFixture(browserDir);
  }
  const privateEnvironmentFile = path.join(fixture.root, '.env.web');
  writeFileSync(
    privateEnvironmentFile,
    `HANDMARK_PASSWORD=${PASSWORD}\nSESSION_SECRET=${SESSION_SECRET}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const privateEnvironmentEntry = lstatSync(privateEnvironmentFile);
  assert.ok(privateEnvironmentEntry.isFile() && !privateEnvironmentEntry.isSymbolicLink());
  assert.equal(privateEnvironmentEntry.nlink, 1);
  assert.equal(privateEnvironmentEntry.mode & 0o777, 0o600);
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

function removeFixture(fixture) {
  const root = realpathSync(fixture.root);
  assert.equal(root, fixture.root);
  assert.equal(path.dirname(root), realpathSync(os.tmpdir()));
  assert.match(path.basename(root), ROOT_PATTERN);
  assert.match(fixture.token, OWNER_PATTERN);
  const ownerEntry = lstatSync(fixture.ownerFile);
  assert.ok(ownerEntry.isFile() && !ownerEntry.isSymbolicLink());
  assert.equal(readFileSync(fixture.ownerFile, 'utf8'), `${fixture.token}\n`);
  rmSync(root, { force: false, recursive: true });
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
    ['assets/handmark-seal.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['assets/handmark-og.png', 'synthetic-png'],
    ['assets/arbitrary.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
  ]);
  for (const font of FONT_FILES) files.set(`assets/fonts/${font}`, `synthetic ${font}`);
  for (const [relativePath, contents] of files) {
    writeFileSync(path.join(browserDir, relativePath), contents, { flag: 'wx' });
  }
}

async function startServer(
  fixture,
  { productionIdentityFile, sessionSecret = SESSION_SECRET } = {},
) {
  const port = await reservePort();
  assert.notEqual(port, 3000);
  fixture.port = port;
  const server = spawnServerProcess(fixture, port, { productionIdentityFile, sessionSecret });
  await waitForHealth(server);
  return server;
}

function spawnServerProcess(
  fixture,
  port,
  { productionIdentityFile, sessionSecret = SESSION_SECRET } = {},
) {
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const production = productionIdentityFile !== undefined;
  let output = '';
  const child = spawn(process.execPath, ['--import', externalFetchGuard, compiledEntrypoint], {
    cwd: fixture.root,
    env: {
      APP_BASE_URL: production ? 'https://handmark.io' : baseUrl,
      CX_TEST_ALLOWED_ORIGIN: baseUrl,
      ...(production
        ? { CX_SERVER_RELEASE_IDENTITY_FILE: productionIdentityFile }
        : {
            HANDMARK_LOAD_ENV_FILE: 'false',
            HANDMARK_PASSWORD: PASSWORD,
            SESSION_SECRET: sessionSecret,
            SITE_BROWSER_DIR: fixture.browserDir,
          }),
      DATA_DIR: 'data',
      DB_PATH: path.join('data', 'handmark.sqlite'),
      HOST: '127.0.0.1',
      NODE_ENV: production ? 'production' : 'test',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    output += String(chunk);
    if (Buffer.byteLength(output, 'utf8') > OUTPUT_LIMIT_BYTES) {
      child.kill('SIGKILL');
      output = `${output.slice(0, OUTPUT_LIMIT_BYTES)}\n[output limit exceeded]`;
    }
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
  const { port } = address;
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
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
  const code = await waitForExit(server);
  assert.equal(code, 0, server.output());
  assert.match(server.output(), /shutting down \(SIGTERM\)/);
  await assertPortClosed(server.port);
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

async function assertPortClosed(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const result = await new Promise((resolve) => {
    socket.once('connect', () => resolve('open'));
    socket.once('error', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 1_000).unref();
  });
  socket.destroy();
  assert.equal(result, 'closed', `Owned Handmark test port ${String(port)} remained open.`);
}

async function unlock(baseUrl, password, forwardedFor = '198.51.100.20') {
  return await localFetch(`${baseUrl}/login`, {
    body: new URLSearchParams({ password }),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': forwardedFor,
    },
    method: 'POST',
    redirect: 'manual',
  });
}

function mutateCookieToken(cookie) {
  const separator = cookie.indexOf('=');
  assert.ok(separator > 0 && separator < cookie.length - 1);
  const tokenParts = cookie.slice(separator + 1).split('.');
  assert.equal(tokenParts.length, 4);
  const signature = tokenParts[3];
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  const tamperIndex = Math.floor(signature.length / 2);
  const replacement = signature[tamperIndex] === 'A' ? 'B' : 'A';
  tokenParts[3] = `${signature.slice(0, tamperIndex)}${replacement}${signature.slice(tamperIndex + 1)}`;
  return `${cookie.slice(0, separator + 1)}${tokenParts.join('.')}`;
}

async function assertPublicAssetContract(baseUrl) {
  const expected = new Map([
    ['/styles.css', 'public, max-age=3600'],
    ['/robots.txt', 'public, max-age=3600'],
    ['/sitemap.xml', 'public, max-age=3600'],
    ['/site.webmanifest', 'public, max-age=3600'],
    ['/assets/handmark-logo.svg', 'public, max-age=3600'],
    ['/assets/handmark-symbol.svg', 'public, max-age=3600'],
    ['/cx-build.json', 'no-store, no-cache, must-revalidate'],
  ]);
  for (const font of FONT_FILES) {
    expected.set(`/assets/fonts/${font}`, 'public, max-age=3600');
  }
  for (const [requestPath, cacheControl] of expected) {
    const response = await localFetch(`${baseUrl}${requestPath}`, { redirect: 'manual' });
    assert.equal(response.status, 200, requestPath);
    assert.equal(response.headers.get('cache-control'), cacheControl, requestPath);
    assert.equal(response.headers.get('x-robots-tag'), null, requestPath);
  }
}

async function assertSelectivePreAuthContract(baseUrl) {
  for (const requestPath of [
    '/',
    '/index.html',
    '/main-ABCDEF12.js',
    '/assets/handmark-stamp.svg',
    '/assets/handmark-seal.svg',
    '/assets/handmark-og.png',
    '/assets/arbitrary.svg',
    '/assets/fonts/not-public.woff2',
  ]) {
    const response = await localFetch(`${baseUrl}${requestPath}`, { redirect: 'manual' });
    assert.equal(response.status, 302, requestPath);
    assert.equal(response.headers.get('location'), '/login', requestPath);
    assert.equal(response.headers.get('cache-control'), 'no-store', requestPath);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', requestPath);
  }
}

async function assertJsonError(response, status, code, message) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/);
  assert.deepEqual(await response.json(), {
    error: { code, message, requestId },
  });
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(
    response.headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=()',
  );
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
}

function assertStoredApplication(databasePath, expectedId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT intake_sequence, id, created_at, name, email, contact_preference, brand,
                walkthrough_preference, record_json, record_hash
         FROM applications`,
      )
      .get();
    assert.ok(row);
    assert.equal(row.intake_sequence, 1);
    assert.equal(row.id, expectedId);
    assert.equal(row.name, validApplication.name);
    assert.equal(row.email, validApplication.email);
    assert.equal(row.contact_preference, validApplication.contactPreference);
    assert.equal(row.brand, validApplication.brand);
    assert.equal(row.walkthrough_preference, validApplication.walkthroughPreference);
    assert.equal(new Date(row.created_at).toISOString(), row.created_at);
    const canonical = Buffer.from(row.record_json);
    const record = JSON.parse(canonical.toString('utf8'));
    assert.deepEqual(Object.keys(record), [
      'id',
      'createdAt',
      'plan',
      'billingCycle',
      'name',
      'email',
      'contactPreference',
      'brand',
      'website',
      'category',
      'craftSummary',
      'proofLinks',
      'walkthroughPreference',
      'paymentPreference',
    ]);
    assert.equal(record.id, expectedId);
    assert.equal(record.email, validApplication.email);
    assert.equal(createHash('sha256').update(canonical).digest('hex'), row.record_hash);
  } finally {
    database.close();
  }
}

function readCutoverState(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      applications: database
        .prepare(
          `SELECT intake_sequence, id, created_at, created_at_ms, record_hash
           FROM applications
           ORDER BY intake_sequence`,
        )
        .all(),
      receipt: database
        .prepare(
          `SELECT receipt_key, format_version, source_bytes, source_sha256, record_count,
                  ordered_records_sha256
           FROM application_import_receipts`,
        )
        .get(),
      sequence: database
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'applications'")
        .get(),
    };
  } finally {
    database.close();
  }
}

function localFetch(input, init) {
  const url = new URL(String(input));
  assert.ok(
    ['127.0.0.1', '::1', 'localhost'].includes(url.hostname),
    `Contract tests refuse non-loopback fetches: ${url.origin}`,
  );
  return nativeFetch(input, init);
}

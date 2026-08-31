import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createGracefulShutdown } from '@mikaelcedergren/cx-framework/server/shutdown';

import { createHandmarkApplication } from './app.js';
import type { ApplicationRepository } from './application-repository.js';
import type { ApplicationService } from './application-service.js';
import { createHandmarkBrowserServing } from './browser-serving.js';
import type { HandmarkEnvironment } from './environment.js';

test('shutdown drains an accepted mutation after its JSON body has been fully parsed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-shutdown-drain-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const browser = path.join(root, 'browser');
  fs.mkdirSync(browser);
  fs.mkdirSync(path.join(browser, 'assets'));
  fs.writeFileSync(path.join(browser, 'index.html'), '<!doctype html><h1>Handmark</h1>');
  fs.writeFileSync(path.join(browser, 'main-ABC12345.js'), 'globalThis.handmark = true;');
  fs.writeFileSync(path.join(browser, 'assets', 'handmark-stamp.svg'), '<svg></svg>');

  let acceptSubmission!: () => void;
  const accepted = new Promise<void>((resolve) => {
    acceptSubmission = resolve;
  });
  let finishSubmission!: () => void;
  const finish = new Promise<void>((resolve) => {
    finishSubmission = resolve;
  });
  const applicationService: ApplicationService = Object.freeze({
    async submit(payload: unknown) {
      assert.deepEqual(payload, { accepted: true });
      acceptSubmission();
      await finish;
      return {
        id: 'HM-00000001',
        message: 'Application received. The next step is human review and process walkthrough.',
        ok: true as const,
      };
    },
  });
  const repository: ApplicationRepository = Object.freeze({
    append: () => 1,
    close: () => undefined,
    isReady: () => true,
    pruneExpired: () => 0,
    startMaintenance: () => undefined,
    stopMaintenance: () => undefined,
  });
  const environment: HandmarkEnvironment = Object.freeze({
    appOrigin: 'http://handmark.test',
    browserDirOverride: browser,
    dataDirectory: root,
    databasePath: path.join(root, 'handmark.sqlite'),
    gatePassword: 'handmark-test-password',
    host: '127.0.0.1',
    isProduction: false,
    mutationOrigins: Object.freeze(['http://handmark.test']),
    operationalRoot: root,
    port: 4232,
    releaseValidation: false,
    sessionSecret: 'handmark-test-session-secret-000000000',
  });
  const app = createHandmarkApplication({
    applicationService,
    browserServing: createHandmarkBrowserServing(environment),
    environment,
    repository,
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => {
    if (server.listening) server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  for (const pathname of ['/assets/handmark-stamp.svg', '/login.html']) {
    const narrowedPublicSurface = await fetch(`${baseUrl}${pathname}`, {
      headers: { connection: 'close' },
      redirect: 'manual',
    });
    assert.equal(narrowedPublicSurface.status, 302, pathname);
    assert.equal(narrowedPublicSurface.headers.get('location'), '/login', pathname);
  }

  const lockedWithoutOrigin = await fetch(`${baseUrl}/api/apply`, {
    body: JSON.stringify({ accepted: true }),
    headers: { connection: 'close', 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(lockedWithoutOrigin.status, 401);
  assert.equal(jsonErrorCode(await lockedWithoutOrigin.json()), 'gate_locked');

  const login = await fetch(`${baseUrl}/login`, {
    body: new URLSearchParams({ password: environment.gatePassword }),
    headers: { connection: 'close', origin: environment.appOrigin },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie);
  const cookie = setCookie.split(';', 1)[0];

  for (const pathname of ['/', '/an-authenticated-route', '/index.html']) {
    const protectedPage = await fetch(`${baseUrl}${pathname}`, {
      headers: { connection: 'close', cookie },
    });
    assert.equal(protectedPage.status, 200, pathname);
    assert.equal(protectedPage.headers.get('cache-control'), 'no-store', pathname);
    assert.equal(protectedPage.headers.get('x-robots-tag'), 'noindex, nofollow', pathname);
  }
  const cacheableAsset = await fetch(`${baseUrl}/main-ABC12345.js`, {
    headers: { connection: 'close', cookie },
  });
  assert.equal(cacheableAsset.status, 200);
  assert.equal(cacheableAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const unlockedWithoutOrigin = await fetch(`${baseUrl}/api/apply`, {
    body: JSON.stringify({ accepted: true }),
    headers: { connection: 'close', 'content-type': 'application/json', cookie },
    method: 'POST',
  });
  assert.equal(unlockedWithoutOrigin.status, 403);
  assert.equal(jsonErrorCode(await unlockedWithoutOrigin.json()), 'origin_required');

  const responsePromise = fetch(`${baseUrl}/api/apply`, {
    body: JSON.stringify({ accepted: true }),
    headers: {
      'content-type': 'application/json',
      connection: 'close',
      cookie,
      origin: environment.appOrigin,
    },
    method: 'POST',
  });
  await accepted;

  const shutdown = createGracefulShutdown({ server, timeoutMs: 2_000 });
  let shutdownSettled = false;
  const shutdownPromise = shutdown.close('test').then(() => {
    shutdownSettled = true;
  });
  await nextTurn();
  assert.equal(shutdownSettled, false);

  finishSubmission();
  const response = await responsePromise;
  assert.equal(response.status, 201);
  assert.equal(jsonStringField(await response.json(), 'id'), 'HM-00000001');
  await shutdownPromise;
  assert.equal(shutdownSettled, true);
});

function jsonErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as { readonly error?: unknown }).error;
  return jsonStringField(error, 'code');
}

function jsonStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Readonly<Record<string, unknown>>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

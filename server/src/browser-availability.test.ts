import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertBrowserServingForStartup } from '@mikaelcedergren/cx-framework/server/static-files';

import { createHandmarkApplication } from './app.js';
import type { ApplicationRepository } from './application-repository.js';
import { createHandmarkBrowserServing } from './browser-serving.js';
import type { HandmarkEnvironment } from './environment.js';

const repository: ApplicationRepository = Object.freeze({
  append: () => 1,
  close: () => undefined,
  isReady: () => true,
  pruneExpired: () => 0,
  startMaintenance: () => undefined,
  stopMaintenance: () => undefined,
});

test('release validation boots and serves health without a browser release', async (t) => {
  const operationalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'handmark-release-browser-absence-'),
  );
  t.after(() => fs.rmSync(operationalRoot, { force: true, recursive: true }));
  const environment = productionEnvironment(operationalRoot, true);
  const browserServing = createHandmarkBrowserServing(environment);
  assert.equal(
    assertBrowserServingForStartup({
      browserServing,
      environment: { CX_RELEASE_VALIDATION: '1', NODE_ENV: 'production' },
    }),
    undefined,
  );
  const app = createHandmarkApplication({ browserServing, environment, repository });
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
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/healthz`, {
    headers: { connection: 'close' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { app: 'handmark', ok: true, port: 4232 });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('ordinary production fails closed when its browser snapshot is missing', (t) => {
  const operationalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'handmark-production-browser-absence-'),
  );
  t.after(() => fs.rmSync(operationalRoot, { force: true, recursive: true }));
  const environment = productionEnvironment(operationalRoot, false);
  const browserServing = createHandmarkBrowserServing(environment);
  assert.throws(
    () =>
      assertBrowserServingForStartup({
        browserServing,
        environment: { NODE_ENV: 'production' },
      }),
    /Browser snapshot is missing/,
  );
});

test('runtime proves browser availability before SQLite access or HTTP listen', () => {
  const source = fs.readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
  const startup = source.indexOf('export async function startHandmarkServer');
  const browserAssertion = source.indexOf('assertBrowserServingForStartup({', startup);
  const databaseOpen = source.indexOf('openApplicationRepository({', startup);
  const listener = source.indexOf('await listenHttpApplication(', startup);

  assert.ok(startup >= 0);
  assert.ok(browserAssertion > startup);
  assert.ok(databaseOpen > browserAssertion);
  assert.ok(listener > databaseOpen);

  const browserSource = fs.readFileSync(new URL('./browser-serving.ts', import.meta.url), 'utf8');
  assert.match(browserSource, /createSinglePageApplicationMiddlewareStack\(\{/);
  assert.doesNotMatch(
    browserSource,
    /Handmark browser release is missing|readActiveBrowserRelease|browserServing\.staticMiddleware|retainedReleaseAssetMiddleware|missingAssetMiddleware/,
  );
});

function productionEnvironment(
  operationalRoot: string,
  releaseValidation: boolean,
): HandmarkEnvironment {
  return Object.freeze({
    appOrigin: releaseValidation ? 'http://127.0.0.1' : 'https://handmark.io',
    browserDirOverride: undefined,
    dataDirectory: path.join(operationalRoot, 'data'),
    databasePath: path.join(operationalRoot, 'data', 'handmark.sqlite'),
    gatePassword: 'handmark-test-password',
    host: '127.0.0.1',
    isProduction: true,
    mutationOrigins: Object.freeze([
      releaseValidation ? 'http://127.0.0.1' : 'https://handmark.io',
    ]),
    operationalRoot,
    port: 4232,
    releaseValidation,
    sessionSecret: 'handmark-test-session-secret-000000000',
  });
}

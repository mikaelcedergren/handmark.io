import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadHandmarkEnvironment } from './environment.js';

const secrets = Object.freeze({
  CX_EXECUTION_SCOPE: 'development',
  CX_DATA_MODE: 'shared',
  CX_SCHEDULE_OWNER: 'false',
  HANDMARK_PASSWORD: 'handmark-test-password',
  SESSION_SECRET: 'handmark-test-session-secret-000000000',
});

test('ordinary production accepts mutations from both exact live Handmark origins', () => {
  const environment = loadHandmarkEnvironment({
    ...secrets,
    APP_BASE_URL: 'https://handmark.io',
    NODE_ENV: 'production',
    CX_EXECUTION_SCOPE: 'production',
    CX_DATA_MODE: 'shared',
    CX_SCHEDULE_OWNER: 'true',
    PORT: '3000',
  });
  assert.equal(environment.appOrigin, 'https://handmark.io');
  assert.equal(environment.dataDirectory, path.resolve('data'));
  assert.deepEqual(environment.mutationOrigins, ['https://handmark.io', 'https://www.handmark.io']);
});

test('release validation accepts only its exact isolated loopback origin', (t) => {
  const runtimeRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'handmark-release-validation-')),
  );
  t.after(() => fs.rmSync(runtimeRoot, { force: true, recursive: true }));
  const suppliedGatePassword = 'release-validation-password-must-be-ignored';
  const suppliedSessionSecret = 'release-validation-session-secret-must-be-ignored';
  const environment = loadHandmarkEnvironment({
    APP_BASE_URL: 'http://127.0.0.1',
    CX_EXECUTION_SCOPE: 'validation',
    CX_DATA_MODE: 'isolated',
    CX_SCHEDULE_OWNER: 'false',
    CX_RELEASE_VALIDATION: '1',
    CX_RUNTIME_ROOT: runtimeRoot,
    HANDMARK_PASSWORD: suppliedGatePassword,
    NODE_ENV: 'production',
    PORT: '4232',
    SESSION_SECRET: suppliedSessionSecret,
  });
  const secondEnvironment = loadHandmarkEnvironment({
    APP_BASE_URL: 'http://127.0.0.1',
    CX_EXECUTION_SCOPE: 'validation',
    CX_DATA_MODE: 'isolated',
    CX_SCHEDULE_OWNER: 'false',
    CX_RELEASE_VALIDATION: '1',
    CX_RUNTIME_ROOT: runtimeRoot,
    NODE_ENV: 'production',
    PORT: '4232',
  });
  assert.equal(environment.databasePath, path.join(runtimeRoot, 'data', 'handmark.sqlite'));
  assert.deepEqual(environment.mutationOrigins, ['http://127.0.0.1']);
  assert.match(environment.gatePassword, /^[A-Za-z0-9_-]{43}$/);
  assert.match(environment.sessionSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(environment.gatePassword, suppliedGatePassword);
  assert.notEqual(environment.sessionSecret, suppliedSessionSecret);
  assert.notEqual(environment.gatePassword, 'handmark-local-development-password');
  assert.notEqual(environment.sessionSecret, 'handmark-local-development-session-secret');
  assert.notEqual(environment.gatePassword, secondEnvironment.gatePassword);
  assert.notEqual(environment.sessionSecret, secondEnvironment.sessionSecret);
});

test('ordinary development uses the authoritative records with schedules disabled', () => {
  const environment = loadHandmarkEnvironment({ ...secrets, NODE_ENV: 'development' });
  assert.equal(environment.dataDirectory, path.resolve('data'));
  assert.equal(environment.databasePath, path.resolve('data/handmark.sqlite'));
});

test('environment mode is an exact closed set', () => {
  for (const NODE_ENV of ['', 'prod', 'Production', ' production', 'production ']) {
    assert.throws(
      () => loadHandmarkEnvironment({ ...secrets, NODE_ENV }),
      /NODE_ENV must be exactly development, test, or production/,
      NODE_ENV,
    );
  }
  assert.doesNotThrow(() => loadHandmarkEnvironment({ ...secrets, NODE_ENV: 'test' }));
  assert.throws(
    () =>
      loadHandmarkEnvironment({
        ...secrets,
        APP_BASE_URL: 'http://127.0.0.1',
        CX_EXECUTION_SCOPE: 'validation',
        CX_DATA_MODE: 'isolated',
        CX_SCHEDULE_OWNER: 'false',
        CX_RELEASE_VALIDATION: '1',
        CX_RUNTIME_ROOT: '/private/tmp/handmark-invalid-release-mode',
        NODE_ENV: 'test',
      }),
    /CX_RELEASE_VALIDATION=1 requires NODE_ENV=production/,
  );
});

test('shared development requires real credentials and refuses alternate stores', () => {
  const policy = {
    CX_EXECUTION_SCOPE: 'development',
    CX_DATA_MODE: 'shared',
    CX_SCHEDULE_OWNER: 'false',
  };
  assert.throws(() => loadHandmarkEnvironment(policy), /HANDMARK_PASSWORD/);
  assert.throws(
    () => loadHandmarkEnvironment({ ...secrets, DATA_DIR: '.run/dev/data' }),
    /Shared Handmark data/,
  );
  assert.throws(
    () => loadHandmarkEnvironment({ ...secrets, CX_SCHEDULE_OWNER: 'true' }),
    /recurring schedules/,
  );
});

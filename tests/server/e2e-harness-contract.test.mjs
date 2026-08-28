import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  createE2EBuildEnvironment,
  createE2EReleaseBuildEnvironment,
  createE2EServerEnvironment,
  E2E_BUILD_ENVIRONMENT_KEYS,
  E2E_RELEASE_BUILD_ENVIRONMENT_KEYS,
  E2E_SERVER_ENVIRONMENT_KEYS,
} = require('../e2e/web-server-environment.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the product E2E layer is thin and delegates containment to cx-framework', () => {
  const build = createE2EBuildEnvironment({
    pathValue: '/synthetic/bin',
    runtimeTemp: '/synthetic/runtime/tmp',
  });
  const releaseBuild = createE2EReleaseBuildEnvironment({
    pathValue: '/synthetic/bin',
    releaseDirectory: '/synthetic/runtime/browser-output',
    runtimeTemp: '/synthetic/runtime/tmp',
  });
  const server = createE2EServerEnvironment({
    pathValue: '/synthetic/bin',
    port: 50_123,
    runtimeRoot: '/synthetic/runtime',
    runtimeTemp: '/synthetic/runtime/tmp',
  });

  assert.deepEqual(Object.keys(build).sort(), E2E_BUILD_ENVIRONMENT_KEYS);
  assert.deepEqual(Object.keys(releaseBuild).sort(), E2E_RELEASE_BUILD_ENVIRONMENT_KEYS);
  assert.deepEqual(Object.keys(server).sort(), E2E_SERVER_ENVIRONMENT_KEYS);
  assert.equal(server.CX_TEST_ALLOWED_ORIGIN, 'http://127.0.0.1:50123');
  assert.equal(build.TMPDIR, '/synthetic/runtime/tmp');
  assert.equal(releaseBuild.TMPDIR, '/synthetic/runtime/tmp');
  assert.equal(server.TMPDIR, '/synthetic/runtime/tmp');
  assert.equal(build.NPM_CONFIG_GLOBALCONFIG, '/dev/null');
  assert.equal(build.NPM_CONFIG_USERCONFIG, '/dev/null');
  assert.equal(releaseBuild.NPM_CONFIG_GLOBALCONFIG, '/dev/null');
  assert.equal(releaseBuild.NPM_CONFIG_USERCONFIG, '/dev/null');
  for (const environment of [build, releaseBuild, server]) {
    assert.equal(Object.isFrozen(environment), true);
    for (const forbidden of [
      'BASH_ENV',
      'HOME',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'PS4',
      'SHELLOPTS',
      'SSH_AUTH_SOCK',
    ]) {
      assert.equal(Object.hasOwn(environment, forbidden), false, forbidden);
    }
  }

  const runner = readFileSync(path.join(repoRoot, 'scripts', 'run-e2e.mjs'), 'utf8');
  const config = readFileSync(path.join(repoRoot, 'playwright.config.mjs'), 'utf8');
  const controller = readFileSync(path.join(repoRoot, 'scripts', 'e2e-server.mjs'), 'utf8');
  const fetchGuard = readFileSync(
    path.join(repoRoot, 'tests', 'support', 'block-external-fetch.mjs'),
    'utf8',
  );
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts.e2e, 'node scripts/run-e2e.mjs');
  assert.match(runner, /createE2EControllerEnvironment/);
  assert.match(runner, /runHermeticE2E/);
  assert.match(runner, /testDirectory:/);
  assert.doesNotMatch(runner, /fixedPort|forbiddenPorts/);
  assert.doesNotMatch(runner, /npm_execpath|process\.env\.PATH|playwright test/);

  assert.match(config, /validateOwnedE2ERuntime/);
  assert.match(config, /createHermeticPlaywrightUse\(RUNTIME/);
  assert.doesNotMatch(config, /\bproxy\s*:|\bserviceWorkers\s*:/);
  assert.doesNotMatch(config, /webServer|globalTeardown|mkdtemp/);

  assert.match(controller, /validateOwnedE2ERuntime/);
  assert.match(controller, /CX_E2E_PNPM_CLI_PATH/);
  assert.doesNotMatch(controller, /npm_execpath|\.\.\.process\.env|detached:\s*true/);
  const spec = readFileSync(path.join(repoRoot, 'tests', 'e2e', 'handmark.spec.cjs'), 'utf8');
  assert.match(spec, /127\.0\.0\.1:3000/);
  assert.match(spec, /cx-e2e-launch-proxy-proof/);
  assert.doesNotMatch(spec, /127\.0\.0\.1:3030/);
  assert.match(fetchGuard, /createExactOriginFetch/);
  assert.doesNotMatch(fetchGuard, /hostname/);
});

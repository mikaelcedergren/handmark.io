const path = require('node:path');

const E2E_BUILD_ENVIRONMENT_KEYS = Object.freeze(
  [
    'CI',
    'NG_CLI_ANALYTICS',
    'NPM_CONFIG_GLOBALCONFIG',
    'NPM_CONFIG_USERCONFIG',
    'PATH',
    'TMPDIR',
  ].sort(),
);
const E2E_RELEASE_BUILD_ENVIRONMENT_KEYS = Object.freeze(
  [
    'CI',
    'NG_CLI_ANALYTICS',
    'NPM_CONFIG_GLOBALCONFIG',
    'NPM_CONFIG_USERCONFIG',
    'PATH',
    'SITE_RELEASE_DIR',
    'TMPDIR',
  ].sort(),
);
const E2E_SERVER_ENVIRONMENT_KEYS = Object.freeze(
  [
    'APP_BASE_URL',
    'CX_TEST_ALLOWED_ORIGIN',
    'DATA_DIR',
    'DB_PATH',
    'HANDMARK_LOAD_ENV_FILE',
    'HANDMARK_PASSWORD',
    'HOST',
    'NODE_ENV',
    'PATH',
    'PORT',
    'SESSION_SECRET',
    'SITE_BROWSER_DIR',
    'TMPDIR',
  ].sort(),
);

function createE2EBuildEnvironment({ pathValue, runtimeTemp }) {
  return exactEnvironment(
    'build',
    {
      CI: '1',
      NG_CLI_ANALYTICS: 'false',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      PATH: pathValue,
      TMPDIR: runtimeTemp,
    },
    E2E_BUILD_ENVIRONMENT_KEYS,
  );
}

function createE2EReleaseBuildEnvironment({ pathValue, releaseDirectory, runtimeTemp }) {
  return exactEnvironment(
    'release build',
    {
      CI: '1',
      NG_CLI_ANALYTICS: 'false',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      PATH: pathValue,
      SITE_RELEASE_DIR: releaseDirectory,
      TMPDIR: runtimeTemp,
    },
    E2E_RELEASE_BUILD_ENVIRONMENT_KEYS,
  );
}

function createE2EServerEnvironment({ pathValue, port, runtimeRoot, runtimeTemp }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return exactEnvironment(
    'server',
    {
      APP_BASE_URL: baseUrl,
      CX_TEST_ALLOWED_ORIGIN: baseUrl,
      DATA_DIR: path.join(runtimeRoot, 'data'),
      DB_PATH: path.join(runtimeRoot, 'data', 'handmark.sqlite'),
      HANDMARK_LOAD_ENV_FILE: 'false',
      HANDMARK_PASSWORD: 'handmark-e2e-gate-password',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PATH: pathValue,
      PORT: String(port),
      SESSION_SECRET: 'handmark-e2e-session-secret-not-for-production',
      SITE_BROWSER_DIR: path.join(runtimeRoot, 'browser-output', 'browser'),
      TMPDIR: runtimeTemp,
    },
    E2E_SERVER_ENVIRONMENT_KEYS,
  );
}

function exactEnvironment(label, values, expectedKeys, allowEmpty = false) {
  const environment = Object.freeze(values);
  assertExactEnvironment(label, environment, expectedKeys, allowEmpty);
  return environment;
}

function assertExactEnvironment(label, environment, expectedKeys, allowEmpty = false) {
  const keys = Object.keys(environment).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    Object.values(environment).some(
      (value) => typeof value !== 'string' || (!allowEmpty && value.length === 0),
    )
  ) {
    throw new Error(`Handmark E2E ${label} environment must match its explicit synthetic set.`);
  }
}

module.exports = {
  createE2EBuildEnvironment,
  createE2EReleaseBuildEnvironment,
  createE2EServerEnvironment,
  E2E_BUILD_ENVIRONMENT_KEYS,
  E2E_RELEASE_BUILD_ENVIRONMENT_KEYS,
  E2E_SERVER_ENVIRONMENT_KEYS,
};

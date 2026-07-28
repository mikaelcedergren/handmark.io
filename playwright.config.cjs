const { defineConfig, devices } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

const PORT = 4231;
const baseURL = `http://127.0.0.1:${PORT}`;
const dataDir =
  process.env.HANDMARK_E2E_DATA_DIR || path.join(os.tmpdir(), `handmark-e2e-${process.pid}`);
const password = process.env.HANDMARK_TEST_PASSWORD || 'handmark-dev-password';

process.env.HANDMARK_BASE_URL = baseURL;
process.env.HANDMARK_E2E_DATA_DIR = dataDir;
process.env.HANDMARK_TEST_PASSWORD = password;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm start',
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HANDMARK_PASSWORD: password,
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      PORT: String(PORT),
      SESSION_SECRET: 'handmark-e2e-session-secret-not-for-production',
      SITE_BROWSER_DIR: 'dist/browser',
    },
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

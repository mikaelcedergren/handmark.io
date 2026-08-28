import { defineConfig } from '@playwright/test';
import {
  createHermeticPlaywrightUse,
  validateOwnedE2ERuntime,
} from '@mikaelcedergren/cx-framework/platform/e2e-runner';
import path from 'node:path';

const RUNTIME = validateOwnedE2ERuntime({ productId: 'handmark' });

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: path.join(RUNTIME.root, 'playwright-output'),
  forbidOnly: process.env.CI === '1',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: createHermeticPlaywrightUse(RUNTIME, {
    trace: 'retain-on-failure',
  }),
  projects: [{ name: 'chromium' }],
});

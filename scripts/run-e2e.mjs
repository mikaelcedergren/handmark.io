#!/usr/bin/env node

import {
  createE2EControllerEnvironment,
  runHermeticE2E,
} from '@mikaelcedergren/cx-framework/platform/e2e-runner';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.exitCode = await runHermeticE2E({
    configure(context) {
      const dataDir = path.join(context.runtime.root, 'data');
      return {
        configPath: path.join(repoRoot, 'playwright.config.mjs'),
        controller: {
          environment: createE2EControllerEnvironment({
            pathValue: context.pathValue,
            pnpmCliPath: context.pnpmCliPath,
            proxyUrl: context.proxyUrl,
            runtime: context.runtime,
          }),
          scriptPath: path.join(repoRoot, 'scripts', 'e2e-server.mjs'),
        },
        playwrightEnvironment: {
          HANDMARK_BASE_URL: context.baseUrl,
          HANDMARK_E2E_DATA_DIR: dataDir,
          HANDMARK_E2E_DB_PATH: path.join(dataDir, 'handmark.sqlite'),
          HANDMARK_E2E_RUNTIME_ROOT: context.runtime.root,
          HANDMARK_E2E_SCREENSHOT_DIR: path.join(context.runtime.root, 'screenshots'),
          HANDMARK_TEST_PASSWORD: 'handmark-e2e-gate-password',
        },
        testDirectory: path.join(repoRoot, 'tests', 'e2e'),
      };
    },
    productId: 'handmark',
    repoRoot,
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

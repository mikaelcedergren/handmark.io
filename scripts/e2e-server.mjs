#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  createHermeticE2EChildEnvironment,
  validateOwnedE2ERuntime,
} from '@mikaelcedergren/cx-framework/platform/e2e-runner';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  createE2EBuildEnvironment,
  createE2EReleaseBuildEnvironment,
  createE2EServerEnvironment,
} = require('../tests/e2e/web-server-environment.cjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pathValue = requiredEnvironment('PATH');
const pnpmCli = requiredEnvironment('CX_E2E_PNPM_CLI_PATH');
const runtime = validateOwnedE2ERuntime({ productId: 'handmark' });
const browserOutputRoot = path.join(runtime.root, 'browser-output');
const entrypoint = path.join(repoRoot, 'server', 'dist', 'index.js');
let activeChild;
let shuttingDown = false;

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.once(signal, () => void shutdown(signal, signalExitCode(signal)));
}

try {
  await runPackageScript(
    'build:server',
    createE2EBuildEnvironment({ pathValue, runtimeTemp: runtime.runtimeTemp }),
  );
  await runPackageScript(
    'build:release',
    createE2EReleaseBuildEnvironment({
      pathValue,
      releaseDirectory: browserOutputRoot,
      runtimeTemp: runtime.runtimeTemp,
    }),
  );
  const server = spawn(process.execPath, [entrypoint], {
    cwd: runtime.root,
    detached: false,
    env: createHermeticE2EChildEnvironment(
      createE2EServerEnvironment({
        pathValue,
        port: runtime.port,
        runtimeRoot: runtime.root,
        runtimeTemp: runtime.runtimeTemp,
      }),
      { targetServer: true },
    ),
    stdio: 'inherit',
  });
  activeChild = server;
  server.once('error', (error) => {
    console.error(error);
    void shutdown('SIGTERM', 1);
  });
  server.once('exit', (code) => void shutdown('SIGTERM', code ?? 1));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function runPackageScript(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmCli, script], {
      cwd: repoRoot,
      detached: false,
      env: createHermeticE2EChildEnvironment(environment),
      stdio: 'inherit',
    });
    activeChild = child;
    child.once('error', (error) => {
      if (activeChild === child) activeChild = undefined;
      reject(error);
    });
    child.once('exit', (code) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${script} failed with exit code ${code ?? 'unknown'}.`));
    });
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for isolated Handmark E2E.`);
  return value;
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const child = activeChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill(signal);
    await exited;
  }
  process.exit(exitCode);
}

function signalExitCode(signal) {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] ?? 1;
}

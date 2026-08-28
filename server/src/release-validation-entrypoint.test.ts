import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEVELOPMENT_PASSWORD = 'handmark-local-development-password';
const MAX_OUTPUT_BYTES = 256 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPILED_ENTRYPOINT = path.join(REPO_ROOT, 'server', 'dist', 'index.js');

interface RunningServer {
  readonly baseUrl: string;
  readonly child: ChildProcess;
  readonly output: () => string;
}

test('compiled release-validation web entrypoint is secretless, ready, and denies the development credential', async () => {
  assert.equal(fs.lstatSync(COMPILED_ENTRYPOINT).isFile(), true);
  const root = temporaryRoot();
  const identityFile = writeIdentity(root);
  const port = await availablePort();
  const environment: NodeJS.ProcessEnv = {
    APP_BASE_URL: 'http://127.0.0.1',
    CX_RELEASE_VALIDATION: '1',
    CX_RUNTIME_ROOT: root,
    CX_SERVER_RELEASE_IDENTITY_FILE: identityFile,
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    PORT: String(port),
    TMPDIR: root,
  };
  for (const privateKey of ['HANDMARK_PASSWORD', 'SESSION_SECRET']) {
    assert.equal(Object.hasOwn(environment, privateKey), false, privateKey);
  }

  const server = spawnServer(root, port, environment);
  try {
    const health = await waitForHealth(server);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { app: 'handmark', ok: true, port });

    const denied = await fetch(`${server.baseUrl}/login`, {
      body: new URLSearchParams({ password: DEVELOPMENT_PASSWORD }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.get('location'), '/login?error=1');
    assert.equal(denied.headers.get('set-cookie'), null);

    const denialPage = await fetch(`${server.baseUrl}/login?error=1`);
    assert.equal(denialPage.status, 200);
    const denialBody = await denialPage.text();
    assert.match(denialBody, /Incorrect password/);
    assert.doesNotMatch(denialBody, new RegExp(DEVELOPMENT_PASSWORD));

    await stopServer(server);
    assert.doesNotMatch(server.output(), new RegExp(DEVELOPMENT_PASSWORD));
  } finally {
    await forceStop(server);
    removeTemporaryRoot(root);
  }
});

function temporaryRoot(): string {
  const canonicalTemp = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(canonicalTemp, 'handmark-release-validation-entrypoint-')),
  );
  fs.chmodSync(root, 0o700);
  assert.equal(path.dirname(root), canonicalTemp);
  return root;
}

function writeIdentity(root: string): string {
  const artifactDigest = 'a'.repeat(64);
  const identityFile = path.join(root, 'server-release.json');
  fs.writeFileSync(
    identityFile,
    `${JSON.stringify({
      artifactBytes: 1,
      artifactDigest,
      artifactFiles: 1,
      createdAt: '2026-08-27T00:00:00.000Z',
      entrypoint: 'server/dist/index.js',
      nodeMajor: 26,
      releaseId: 'handmark-secretless-validation-test',
      revision: 'b'.repeat(40),
      schemaVersion: 1,
      serverBuildId: `server-${artifactDigest}`,
      sourceDirty: true,
      sourceFingerprint: 'c'.repeat(64),
      workers: [],
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return identityFile;
}

function spawnServer(root: string, port: number, environment: NodeJS.ProcessEnv): RunningServer {
  let output = '';
  const child = spawn(process.execPath, [COMPILED_ENTRYPOINT], {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
    if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES && child.exitCode === null) {
      child.kill('SIGKILL');
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    child,
    output: () => output,
  };
}

async function waitForHealth(server: RunningServer): Promise<Response> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Handmark exited before release-validation readiness.\n${server.output()}`);
    }
    try {
      const response = await fetch(`${server.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return response;
    } catch {
      // The owned child has not bound its loopback socket yet.
    }
    await delay(50);
  }
  throw new Error(`Handmark release validation did not become ready.\n${server.output()}`);
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
  }
  const result = await waitForExit(server);
  assert.equal(result.signal, null, server.output());
  assert.equal(result.code, 0, server.output());
}

async function forceStop(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGKILL');
  await waitForExit(server);
}

async function waitForExit(
  server: RunningServer,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return { code: server.child.exitCode, signal: server.child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL');
      reject(new Error(`Handmark release-validation child did not exit.\n${server.output()}`));
    }, 10_000);
    server.child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function availablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') {
    probe.close();
    throw new Error('Could not reserve a loopback port for Handmark release validation.');
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function removeTemporaryRoot(root: string): void {
  const canonicalTemp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(fs.realpathSync(root)), canonicalTemp);
  assert.match(path.basename(root), /^handmark-release-validation-entrypoint-[A-Za-z0-9]+$/);
  fs.rmSync(root, { force: false, recursive: true });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { loadHandmarkEnvironmentFile } from './environment-files.js';

test('target environment loading delegates private file I/O to the framework before runtime import', () => {
  const loaderSource = fs.readFileSync(new URL('./environment-files.ts', import.meta.url), 'utf8');
  assert.match(loaderSource, /@mikaelcedergren\/cx-framework\/server\/private-environment/);
  assert.doesNotMatch(loaderSource, /\b(?:dotenv|fstatSync|openSync|readSync)\b/);

  const entrypointSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const loadPosition = entrypointSource.indexOf('loadHandmarkEnvironmentFile();');
  const runtimePosition = entrypointSource.indexOf("await import('./runtime.js')");
  assert.notEqual(loadPosition, -1);
  assert.ok(
    runtimePosition > loadPosition,
    'The runtime import must happen only after private environment loading.',
  );
  assert.doesNotMatch(entrypointSource, /import\s+\{\s*startHandmarkServer\s*\}\s+from/);
});

test('target loads only its private web file and ignores legacy .env', (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(
    path.join(root, '.env.web'),
    'HANDMARK_PASSWORD=synthetic-password\nSESSION_SECRET=synthetic-session-secret\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(root, '.env'),
    'HANDMARK_PASSWORD=legacy-password\nSESSION_SECRET=legacy-session-secret\nAPP_BASE_URL=https://legacy.invalid\n',
    { mode: 0o600 },
  );

  const environment: NodeJS.ProcessEnv = {};
  loadHandmarkEnvironmentFile(environment);
  assert.deepEqual(environment, {
    HANDMARK_PASSWORD: 'synthetic-password',
    SESSION_SECRET: 'synthetic-session-secret',
  });
});

test('production requires .env.web and lets only that file define private values', (t) => {
  const root = temporaryRoot(t);
  const environment: NodeJS.ProcessEnv = {
    HANDMARK_PASSWORD: 'ambient-must-be-replaced',
    NODE_ENV: 'production',
    SESSION_SECRET: 'ambient-must-be-cleared',
    UNRELATED: 'preserved',
  };

  assert.throws(
    () => loadHandmarkEnvironmentFile(environment),
    /Required private environment file \.env\.web is absent/,
  );
  assert.equal(environment['HANDMARK_PASSWORD'], 'ambient-must-be-replaced');

  fs.writeFileSync(path.join(root, '.env.web'), 'HANDMARK_PASSWORD=file-authority\n', {
    mode: 0o600,
  });
  loadHandmarkEnvironmentFile(environment);
  assert.deepEqual(environment, {
    HANDMARK_PASSWORD: 'file-authority',
    NODE_ENV: 'production',
    UNRELATED: 'preserved',
  });

  assert.throws(
    () =>
      loadHandmarkEnvironmentFile({
        HANDMARK_LOAD_ENV_FILE: 'false',
        NODE_ENV: 'production',
      }),
    /cannot disable the required production private environment file/,
  );
});

test('target private file rejects unsupported values, public modes, and links', (t) => {
  const root = temporaryRoot(t);
  const webFile = path.join(root, '.env.web');

  fs.writeFileSync(webFile, 'APP_BASE_URL=https://outside-allowlist.invalid\n', { mode: 0o600 });
  assert.throws(
    () => loadHandmarkEnvironmentFile({}),
    /outside its private allowlist: APP_BASE_URL/,
  );

  fs.writeFileSync(webFile, 'HANDMARK_PASSWORD=synthetic-password\n', { mode: 0o600 });
  fs.chmodSync(webFile, 0o644);
  assert.throws(() => loadHandmarkEnvironmentFile({}), /mode-0600 regular file/);

  fs.rmSync(webFile);
  const target = path.join(root, 'target.env');
  fs.writeFileSync(target, 'HANDMARK_PASSWORD=synthetic-password\n', { mode: 0o600 });
  fs.symlinkSync(target, webFile);
  assert.throws(() => loadHandmarkEnvironmentFile({}), /mode-0600 regular file/);

  fs.rmSync(webFile);
  fs.rmSync(target);
  fs.symlinkSync(target, webFile);
  assert.throws(() => loadHandmarkEnvironmentFile({}), /mode-0600 regular file/);

  fs.rmSync(webFile);
  fs.writeFileSync(target, 'SESSION_SECRET=synthetic-session-secret\n', { mode: 0o600 });
  fs.linkSync(target, webFile);
  assert.throws(() => loadHandmarkEnvironmentFile({}), /mode-0600 regular file/);
});

test('target private-file reads reject oversized, growing, and invalid UTF-8 input', (t) => {
  const root = temporaryRoot(t);
  const webFile = path.join(root, '.env.web');
  fs.writeFileSync(webFile, Buffer.alloc(64 * 1024 + 1, 0x41), { mode: 0o600 });
  assert.throws(() => loadHandmarkEnvironmentFile({}), /exceeds 64 KiB/);

  fs.writeFileSync(webFile, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
  assert.throws(() => loadHandmarkEnvironmentFile({}), /must be valid UTF-8/);

  fs.writeFileSync(webFile, 'SESSION_SECRET=synthetic-session-secret\n', { mode: 0o600 });
  const originalReadSync = fs.readSync;
  let grew = false;
  const growingRead = ((
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number => {
    if (!grew) {
      grew = true;
      fs.appendFileSync(webFile, Buffer.alloc(70 * 1024, 0x42));
    }
    return originalReadSync(descriptor, buffer, offset, length, position);
  }) as typeof fs.readSync;
  t.mock.method(fs, 'readSync', growingRead);
  assert.throws(() => loadHandmarkEnvironmentFile({}), /exceeds 64 KiB/);
});

test('test, explicit disable, and release validation never read private or legacy files', (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(
    path.join(root, '.env.web'),
    'APP_BASE_URL=https://outside-allowlist.invalid\n',
    {
      mode: 0o600,
    },
  );
  fs.writeFileSync(path.join(root, '.env'), 'HANDMARK_PASSWORD=legacy-password\n', { mode: 0o600 });

  const bypassedEnvironments: NodeJS.ProcessEnv[] = [
    { NODE_ENV: 'test' },
    { HANDMARK_LOAD_ENV_FILE: 'false' },
    {
      CX_RELEASE_VALIDATION: '1',
      CX_RUNTIME_ROOT: root,
      HANDMARK_PASSWORD: 'ambient-must-be-removed',
      NODE_ENV: 'production',
      SESSION_SECRET: 'ambient-must-be-removed',
    },
  ];
  for (const environment of bypassedEnvironments) {
    loadHandmarkEnvironmentFile(environment);
    assert.equal(environment['HANDMARK_PASSWORD'], undefined);
    assert.equal(environment['SESSION_SECRET'], undefined);
  }

  assert.throws(
    () => loadHandmarkEnvironmentFile({ CX_RELEASE_VALIDATION: 'true' }),
    /CX_RELEASE_VALIDATION must be exactly 1 when it is set/,
  );
  assert.throws(
    () => loadHandmarkEnvironmentFile({ HANDMARK_LOAD_ENV_FILE: 'false', NODE_ENV: 'Production' }),
    /NODE_ENV must be exactly development, test, or production/,
  );
  assert.throws(
    () => loadHandmarkEnvironmentFile({ HANDMARK_LOAD_ENV_FILE: 'False' }),
    /HANDMARK_LOAD_ENV_FILE must be exactly false/,
  );
});

function temporaryRoot(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-env-files-')));
  fs.chmodSync(root, 0o700);
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(root, { force: true, recursive: true });
  });
  return root;
}

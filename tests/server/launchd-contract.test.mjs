import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installer = path.join(repoRoot, 'bin', 'install-server-daemon');
const label = 'com.handmark.server';
const legacyTemplate = path.join(repoRoot, 'launchd', `${label}.plist`);
const targetTemplate = path.join(repoRoot, 'launchd', `${label}.target.plist`);

test('target LaunchDaemon selects the immutable server without embedding secrets', () => {
  const source = readFileSync(targetTemplate, 'utf8');
  assert.match(
    source,
    /\/\.run\/site-releases\/server\/current-server\/artifact\/server\/dist\/index\.js</,
  );
  assert.match(source, /current-server\/server-release\.json</);
  assert.match(source, /<key>HOST<\/key>\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(source, /<key>PORT<\/key>\s*<string>3000<\/string>/);
  assert.match(source, /<key>DB_PATH<\/key>\s*<string>data\/handmark\.sqlite<\/string>/);
  assert.doesNotMatch(source, /<key>(?:HANDMARK_PASSWORD|SESSION_SECRET)<\/key>/);
});

test('daemon installer is check-first, copy-safe, definition-only, and cutover-gated', (t) => {
  const source = readFileSync(installer, 'utf8');
  assert.match(source, /readonly INSTALL_ROOT="\/Users\/cortex\/Development\/handmark\.io"/);
  assert.match(source, /MODE="check"/);
  assert.match(source, /current-server\/server-release\.json/);
  assert.match(source, /current-server\/artifact\/server\/dist\/index\.js/);
  assert.match(source, /\.env\.web/);
  assert.match(source, /data\/handmark\.sqlite/);
  assert.match(source, /launchctl print/);
  assert.match(source, /launchctl_status/);
  assert.match(source, /\[\[ "\$launchctl_status" -ne 113 \]\]/);
  assert.match(source, /id -u cortex/);
  assert.match(source, /"\$EUID" -ne "\$EXPECTED_OPERATOR_UID"/);
  assert.match(source, /metadata\.st_uid != expected_uid/);
  assert.match(source, /server-ops\/bin\/install-launchdaemon-definitions\.mjs/);
  assert.match(source, /server-ops\/bin\/server-release\.mjs/);
  assert.match(source, /--site handmark --status/);
  assert.match(source, /status: handmark running-unknown/);
  assert.match(source, /selection: activation generation verified/);
  assert.match(source, /--check/);
  assert.match(source, /--apply/);
  assert.match(source, /mktemp -d/);
  assert.match(source, /validate_definitions "\$LEGACY_TEMPLATE" "\$STAGED_TEMPLATE"/);
  assert.match(source, /trap cleanup_staging EXIT/);
  assert.match(source, /installation and staged-definition cleanup both failed/);
  assert.match(source, /--definition "\$LABEL=\$STAGED_TEMPLATE"/);
  assert.doesNotMatch(source, /sudo install|\/usr\/bin\/install/);
  assert.doesNotMatch(source, /\b(?:bootout|bootstrap|kickstart)\b/);

  if (process.platform !== 'darwin') {
    t.diagnostic('Mac-only installer execution is covered by source contract on this platform.');
    return;
  }

  const direct = execFileSync(installer, [], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(
    direct,
    /VALID: selected Handmark legacy definition and future immutable-server definition/,
  );
  assert.match(direct, /No service definition was installed/);
  const explicit = execFileSync(installer, ['--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(explicit, direct);

  const copiedRoot = makeCopiedInstaller(t);
  const copiedInstaller = path.join(copiedRoot, 'bin', 'install-server-daemon');
  const copiedCheck = execFileSync(copiedInstaller, ['--check'], {
    cwd: copiedRoot,
    encoding: 'utf8',
  });
  assert.equal(copiedCheck, direct);
  assert.throws(
    () =>
      execFileSync(copiedInstaller, ['--apply'], {
        cwd: copiedRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    (error) =>
      error instanceof Error &&
      /--apply is allowed only from the canonical production checkout/.test(
        'stderr' in error ? String(error.stderr) : error.message,
      ),
  );
});

test('daemon check rejects a copied target definition whose semantics drift', (t) => {
  if (process.platform !== 'darwin') {
    t.diagnostic('Mac-only installer execution is covered by source contract on this platform.');
    return;
  }

  const copiedRoot = makeCopiedInstaller(t);
  const copiedInstaller = path.join(copiedRoot, 'bin', 'install-server-daemon');
  const copiedTarget = path.join(copiedRoot, 'launchd', `${label}.target.plist`);
  writeFileSync(
    copiedTarget,
    readFileSync(copiedTarget, 'utf8').replace(
      '<string>127.0.0.1</string>',
      '<string>0.0.0.0</string>',
    ),
  );
  assert.throws(
    () =>
      execFileSync(copiedInstaller, ['--check'], {
        cwd: copiedRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    (error) =>
      error instanceof Error &&
      /target LaunchDaemon EnvironmentVariables contract is invalid/.test(
        'stderr' in error ? String(error.stderr) : error.message,
      ),
  );
});

function makeCopiedInstaller(t) {
  const copiedRoot = mkdtempSync(path.join(os.tmpdir(), 'handmark-daemon-check-'));
  t.after(() => rmSync(copiedRoot, { force: true, recursive: true }));
  mkdirSync(path.join(copiedRoot, 'bin'));
  mkdirSync(path.join(copiedRoot, 'launchd'));
  const copiedInstaller = path.join(copiedRoot, 'bin', 'install-server-daemon');
  copyFileSync(installer, copiedInstaller);
  chmodSync(copiedInstaller, 0o755);
  copyFileSync(legacyTemplate, path.join(copiedRoot, 'launchd', `${label}.plist`));
  copyFileSync(targetTemplate, path.join(copiedRoot, 'launchd', `${label}.target.plist`));
  return copiedRoot;
}

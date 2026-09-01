import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installer = path.join(repoRoot, 'bin', 'install-server-daemon');
const label = 'com.handmark.server';
const template = path.join(repoRoot, 'launchd', `${label}.plist`);

test('LaunchDaemon selects the immutable server without embedding secrets', () => {
  const source = readFileSync(template, 'utf8');
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

test('daemon installer is a thin delegate and never activates the service', () => {
  const source = readFileSync(installer, 'utf8');
  assert.match(source, /install-site-service-definitions\.mjs/);
  assert.match(source, /--site handmark/);
  assert.match(source, /--repo "\$repo" "\$@"/);
  assert.doesNotMatch(source, /\blaunchctl\b/);
  assert.doesNotMatch(source, /\bsudo\b/);
  assert.doesNotMatch(source, /\.env\.|data\/|server\/dist/);

  const direct = execFileSync(installer, [], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(direct, /VALID: handmark 1 registered LaunchDaemon definition\./);
  assert.match(direct, /No service definition was installed/);
  assert.equal(execFileSync(installer, ['--check'], { cwd: repoRoot, encoding: 'utf8' }), direct);
});

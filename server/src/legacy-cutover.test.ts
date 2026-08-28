import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { APPLICATION_MAX_CANONICAL_BYTES } from './constants.js';
import { openLegacyApplicationSourceProof } from './legacy-cutover.js';

function fixtureRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-legacy-cutover-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test('legacy source proof is absent only when the exact path is absent', (t) => {
  const root = fixtureRoot(t);
  assert.equal(
    openLegacyApplicationSourceProof({
      operationalRoot: root,
      sourcePath: path.join(root, 'applications.jsonl'),
    }),
    undefined,
  );

  const target = path.join(root, 'target.jsonl');
  const linked = path.join(root, 'applications.jsonl');
  fs.writeFileSync(target, '{}\n');
  fs.symlinkSync(target, linked);
  assert.throws(
    () => openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath: linked }),
    /single-link regular file/,
  );
  fs.unlinkSync(linked);
  fs.linkSync(target, linked);
  assert.throws(
    () => openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath: linked }),
    /single-link regular file/,
  );
});

test('legacy source proof rejects linked parents and detects parent replacement', (t) => {
  const root = fixtureRoot(t);
  const outside = fixtureRoot(t);
  const dataDirectory = path.join(root, 'data');
  const movedDirectory = path.join(root, 'data-original');
  const sourcePath = path.join(dataDirectory, 'applications.jsonl');
  fs.writeFileSync(path.join(outside, 'applications.jsonl'), '{}\n', { mode: 0o600 });

  fs.symlinkSync(outside, dataDirectory);
  assert.throws(
    () => openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath }),
    /directory component is unsafe/,
  );
  fs.unlinkSync(dataDirectory);

  fs.mkdirSync(dataDirectory, { mode: 0o700 });
  fs.writeFileSync(sourcePath, '{}\n', { mode: 0o600 });
  const proof = openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath });
  assert.ok(proof);
  fs.renameSync(dataDirectory, movedDirectory);
  fs.symlinkSync(outside, dataDirectory);
  assert.throws(
    () => proof.assertUnchanged(),
    /source directory changed during receipt verification/,
  );
  proof.close();
});

test('legacy source proof rejects paths outside the operational root', (t) => {
  const root = fixtureRoot(t);
  const outside = fixtureRoot(t);
  const sourcePath = path.join(outside, 'applications.jsonl');
  fs.writeFileSync(sourcePath, '{}\n', { mode: 0o600 });
  assert.throws(
    () => openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath }),
    /must remain inside its operational root/,
  );
});

test('legacy source proof pins exact bytes and detects later mutation or replacement', (t) => {
  const root = fixtureRoot(t);
  const sourcePath = path.join(root, 'applications.jsonl');
  const bytes = Buffer.from('{"id":"HM-00000001"}\n', 'utf8');
  fs.writeFileSync(sourcePath, bytes, { mode: 0o600 });
  const proof = openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath });
  assert.ok(proof);
  assert.equal(proof.sourceBytes, bytes.byteLength);
  assert.equal(proof.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.doesNotThrow(() => proof.assertUnchanged());

  fs.appendFileSync(sourcePath, '{}\n');
  assert.throws(() => proof.assertUnchanged(), /changed while its import receipt was verified/);
  proof.close();
  assert.doesNotThrow(() => proof.close());
  assert.throws(() => proof.assertUnchanged(), /already closed/);
});

test('legacy source proof rejects oversized sparse input before reading it', (t) => {
  const root = fixtureRoot(t);
  const sourcePath = path.join(root, 'applications.jsonl');
  fs.writeFileSync(sourcePath, '');
  fs.truncateSync(sourcePath, APPLICATION_MAX_CANONICAL_BYTES + 1);
  assert.throws(
    () => openLegacyApplicationSourceProof({ operationalRoot: root, sourcePath }),
    /exceeds the 100 MiB intake ceiling/,
  );
});

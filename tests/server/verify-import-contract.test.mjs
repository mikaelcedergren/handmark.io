import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  CURRENT_RECORD,
  HISTORICAL_RECORD,
  jsonlBytes,
} from '../fixtures/application-import/records.mjs';
import {
  assertFileSnapshot,
  captureFile,
  discoverImporter,
  expectedEmptyAuthorityReceipt,
  expectedReceipt,
  setupImportFixture,
  targetSidecarPaths,
  writeSource,
} from './import-contract-support.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const COMPILED_VERIFIER_PATH = path.join(
  REPO_ROOT,
  'server',
  'dist',
  'verify-application-import.js',
);
const importerDiscovery = await discoverImporter();
let verifier;
let verifierError;
try {
  verifier = await import(pathToFileURL(COMPILED_VERIFIER_PATH).href);
} catch (error) {
  verifierError = error;
}
const CONTRACT_SKIP =
  importerDiscovery.error || verifierError
    ? `compiled import proof unavailable: ${String(importerDiscovery.error || verifierError)}`
    : false;

function contractTest(name, handler) {
  return test(name, { skip: CONTRACT_SKIP }, handler);
}

contractTest(
  'read-only verifier proves JSONL import without changing private storage',
  async (t) => {
    const { databasePath, directory, sourcePath } = setupImportFixture(t);
    const sourceBytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
    writeSource(sourcePath, sourceBytes);
    const receipt = await importerDiscovery.module.importApplicationsJsonl({
      databasePath,
      operationalRoot: directory,
      sourcePath,
    });
    assert.deepEqual(receipt, expectedReceipt(sourceBytes, [CURRENT_RECORD, HISTORICAL_RECORD]));
    const receiptPath = writeReceipt(directory, receipt);
    const databaseBefore = captureFile(databasePath);
    const directoryBefore = captureDirectory(directory);

    assert.deepEqual(
      verifier.verifyApplicationImportEvidence([
        '--database',
        databasePath,
        '--receipt',
        receiptPath,
      ]),
      receipt,
    );
    const child = spawnSync(
      process.execPath,
      [COMPILED_VERIFIER_PATH, '--database', databasePath, '--receipt', receiptPath],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, `${JSON.stringify(receipt)}\n`);
    assert.doesNotMatch(child.stdout, /Ada Example|ada@example\.com|Historical maker/u);

    assertFileSnapshot(databasePath, databaseBefore);
    assert.deepEqual(captureDirectory(directory), directoryBefore);
    for (const sidecarPath of targetSidecarPaths(databasePath)) {
      assert.equal(fs.existsSync(sidecarPath), false);
    }
  },
);

contractTest('read-only verifier proves sealed empty-absence authority', async (t) => {
  const { databasePath, directory, sourcePath } = setupImportFixture(t);
  const receipt = await importerDiscovery.module.importEmptyApplicationsAuthority({
    databasePath,
    operationalRoot: directory,
    sourcePath,
  });
  assert.deepEqual(receipt, expectedEmptyAuthorityReceipt());
  const receiptPath = writeReceipt(directory, receipt);
  const databaseBefore = captureFile(databasePath);
  const directoryBefore = captureDirectory(directory);

  assert.deepEqual(
    verifier.verifyApplicationImportEvidence([
      '--database',
      databasePath,
      '--receipt',
      receiptPath,
    ]),
    receipt,
  );
  assertFileSnapshot(databasePath, databaseBefore);
  assert.deepEqual(captureDirectory(directory), directoryBefore);
  assert.equal(fs.existsSync(sourcePath), false);
});

contractTest('read-only verifier rejects mismatched evidence and SQLite sidecars', async (t) => {
  const { databasePath, directory, sourcePath } = setupImportFixture(t);
  const sourceBytes = jsonlBytes([CURRENT_RECORD]);
  writeSource(sourcePath, sourceBytes);
  const receipt = await importerDiscovery.module.importApplicationsJsonl({
    databasePath,
    operationalRoot: directory,
    sourcePath,
  });
  const receiptPath = writeReceipt(directory, {
    ...receipt,
    orderedRecordsSha256: '0'.repeat(64),
  });
  const databaseBefore = captureFile(databasePath);
  assert.throws(
    () =>
      verifier.verifyApplicationImportEvidence([
        '--database',
        databasePath,
        '--receipt',
        receiptPath,
      ]),
    /receipt|aggregate/u,
  );
  assertFileSnapshot(databasePath, databaseBefore);

  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.chmodSync(receiptPath, 0o600);
  for (const suffix of ['-wal', '-WAL']) {
    const sidecarPath = `${databasePath}${suffix}`;
    fs.writeFileSync(sidecarPath, 'synthetic sidecar evidence', { mode: 0o600 });
    const sidecarBefore = captureFile(sidecarPath);
    assert.throws(
      () =>
        verifier.verifyApplicationImportEvidence([
          '--database',
          databasePath,
          '--receipt',
          receiptPath,
        ]),
      /SQLite sidecar is present/u,
    );
    assertFileSnapshot(databasePath, databaseBefore);
    assertFileSnapshot(sidecarPath, sidecarBefore);
    fs.unlinkSync(sidecarPath);
  }
});

contractTest(
  'read-only verifier rejects semantic tampering and unsafe database identity',
  async (t) => {
    const { databasePath, directory, sourcePath } = setupImportFixture(t);
    const sourceBytes = jsonlBytes([CURRENT_RECORD]);
    writeSource(sourcePath, sourceBytes);
    const receipt = await importerDiscovery.module.importApplicationsJsonl({
      databasePath,
      operationalRoot: directory,
      sourcePath,
    });
    const receiptPath = writeReceipt(directory, receipt);
    const linkedPath = path.join(directory, 'linked-handmark.sqlite');
    fs.linkSync(databasePath, linkedPath);
    assert.throws(
      () =>
        verifier.verifyApplicationImportEvidence([
          '--database',
          databasePath,
          '--receipt',
          receiptPath,
        ]),
      /single-link database/u,
    );
    fs.unlinkSync(linkedPath);

    fs.chmodSync(directory, 0o750);
    assert.throws(
      () =>
        verifier.verifyApplicationImportEvidence([
          '--database',
          databasePath,
          '--receipt',
          receiptPath,
        ]),
      /mode-0700 real parent/u,
    );
    fs.chmodSync(directory, 0o700);

    tamperRecordHashWithoutChangingSchema(databasePath);
    const databaseBefore = captureFile(databasePath);
    assert.throws(
      () =>
        verifier.verifyApplicationImportEvidence([
          '--database',
          databasePath,
          '--receipt',
          receiptPath,
        ]),
      /metadata does not match its canonical record/u,
    );
    const child = spawnSync(
      process.execPath,
      [COMPILED_VERIFIER_PATH, '--database', databasePath, '--receipt', receiptPath],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /metadata does not match its canonical record/u);
    assert.doesNotMatch(child.stderr, /Ada Example|ada@example\.com|Ada Workshop/u);
    assertFileSnapshot(databasePath, databaseBefore);
  },
);

function writeReceipt(directory, receipt) {
  const receiptPath = path.join(directory, 'import-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.chmodSync(receiptPath, 0o600);
  return receiptPath;
}

function captureDirectory(directory) {
  const stats = fs.lstatSync(directory, { bigint: true });
  return {
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    gid: stats.gid,
    ino: stats.ino,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    names: fs.readdirSync(directory).toSorted(),
    uid: stats.uid,
  };
}

function tamperRecordHashWithoutChangingSchema(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const trigger = database
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'applications_immutable_update'")
      .get();
    assert.equal(typeof trigger?.sql, 'string');
    database.exec('DROP TRIGGER applications_immutable_update');
    database
      .prepare('UPDATE applications SET record_hash = ? WHERE intake_sequence = 1')
      .run('0'.repeat(64));
    database.exec(trigger.sql);
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
}

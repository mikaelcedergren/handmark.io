import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  EMPTY_APPLICATION_AUTHORITY_SHA256,
  EMPTY_APPLICATION_RECORDS_SHA256,
} from './application-schema.js';
import {
  parseApplicationImportVerificationArguments,
  readApplicationImportReceiptEvidence,
} from './verify-application-import.js';
import {
  assertSqliteSidecarsAbsent,
  boundedCutoverDirectoryInventory,
  CUTOVER_DIRECTORY_MAX_ENTRIES,
} from './cutover-filesystem.js';

const VALID_RECEIPT = Object.freeze({
  authorityKind: 'legacy_jsonl_v1' as const,
  formatVersion: 1,
  orderedRecordsSha256: 'b'.repeat(64),
  recordCount: 2,
  sourceBytes: 1_024,
  sourceSha256: 'a'.repeat(64),
});

test('application import verifier requires one explicit receipt and database path', () => {
  assert.deepEqual(
    parseApplicationImportVerificationArguments([
      '--database',
      'restore/handmark.sqlite',
      '--receipt',
      'evidence/import-receipt.json',
    ]),
    {
      databasePath: path.resolve('restore/handmark.sqlite'),
      receiptPath: path.resolve('evidence/import-receipt.json'),
    },
  );
  assert.throws(
    () => parseApplicationImportVerificationArguments(['--database', 'restore/handmark.sqlite']),
    /explicit --database and --receipt/,
  );
  assert.throws(
    () =>
      parseApplicationImportVerificationArguments([
        '--database',
        'first.sqlite',
        '--database',
        'second.sqlite',
        '--receipt',
        'receipt.json',
      ]),
    /Usage:/,
  );
});

test('application import verifier accepts only canonical bounded receipt evidence', (t) => {
  const directory = privateTempDirectory(t);
  const receiptPath = path.join(directory, 'receipt.json');
  writeReceipt(receiptPath, VALID_RECEIPT);
  assert.deepEqual(readApplicationImportReceiptEvidence(receiptPath), VALID_RECEIPT);

  writeReceipt(receiptPath, { ...VALID_RECEIPT, unexpected: true });
  assert.throws(() => readApplicationImportReceiptEvidence(receiptPath), /unexpected shape/);

  writeReceipt(receiptPath, { ...VALID_RECEIPT, sourceSha256: 'not-a-hash' });
  assert.throws(() => readApplicationImportReceiptEvidence(receiptPath), /invalid aggregate hash/);

  fs.writeFileSync(receiptPath, `${JSON.stringify(VALID_RECEIPT)}  \n`, { mode: 0o600 });
  assert.throws(
    () => readApplicationImportReceiptEvidence(receiptPath),
    /canonical importer output/,
  );
});

test('application import verifier enforces the sealed empty-absence receipt', (t) => {
  const directory = privateTempDirectory(t);
  const receiptPath = path.join(directory, 'receipt.json');
  const emptyReceipt = Object.freeze({
    authorityKind: 'legacy_empty_absence_v1' as const,
    formatVersion: 1,
    orderedRecordsSha256: EMPTY_APPLICATION_RECORDS_SHA256,
    recordCount: 0,
    sourceBytes: 0,
    sourceSha256: EMPTY_APPLICATION_AUTHORITY_SHA256,
  });
  writeReceipt(receiptPath, emptyReceipt);
  assert.deepEqual(readApplicationImportReceiptEvidence(receiptPath), emptyReceipt);

  writeReceipt(receiptPath, { ...emptyReceipt, sourceSha256: 'a'.repeat(64) });
  assert.throws(() => readApplicationImportReceiptEvidence(receiptPath), /empty-authority values/);
});

test('application import verifier refuses linked or permissive receipt evidence', (t) => {
  const directory = privateTempDirectory(t);
  const receiptPath = path.join(directory, 'receipt.json');
  const linkedPath = path.join(directory, 'linked-receipt.json');
  writeReceipt(receiptPath, VALID_RECEIPT);
  fs.symlinkSync(receiptPath, linkedPath);
  assert.throws(() => readApplicationImportReceiptEvidence(linkedPath), /canonical absolute path/);
  fs.unlinkSync(linkedPath);

  fs.linkSync(receiptPath, linkedPath);
  assert.throws(() => readApplicationImportReceiptEvidence(receiptPath), /single-link file/);
  fs.unlinkSync(linkedPath);

  fs.chmodSync(receiptPath, 0o640);
  assert.throws(() => readApplicationImportReceiptEvidence(receiptPath), /mode-0600/);
  fs.chmodSync(receiptPath, 0o600);

  fs.chmodSync(directory, 0o750);
  assert.throws(() => readApplicationImportReceiptEvidence(receiptPath), /mode-0700 real parent/);
});

test('cutover inventory rejects every case variant of SQLite sidecar evidence', (t) => {
  const directory = privateTempDirectory(t);
  const databasePath = path.join(directory, 'handmark.sqlite');
  fs.writeFileSync(databasePath, 'synthetic database', { mode: 0o600 });

  for (const suffix of ['-JOURNAL', '-SHM', '-WAL']) {
    const sidecarPath = `${databasePath}${suffix}`;
    fs.writeFileSync(sidecarPath, 'synthetic sidecar', { mode: 0o600 });
    const inventory = boundedCutoverDirectoryInventory(directory, 'Synthetic cutover directory');
    assert.throws(
      () => assertSqliteSidecarsAbsent(databasePath, inventory, 'Synthetic SQLite proof'),
      /SQLite sidecar is present/,
    );
    fs.unlinkSync(sidecarPath);
  }
});

test('cutover directory inventory enforces entry and name-byte ceilings', (t) => {
  const directory = privateTempDirectory(t);
  const entryOverflow = path.join(directory, 'entry-overflow');
  fs.mkdirSync(entryOverflow, { mode: 0o700 });
  for (let index = 0; index <= CUTOVER_DIRECTORY_MAX_ENTRIES; index += 1) {
    fs.writeFileSync(path.join(entryOverflow, `entry-${String(index).padStart(3, '0')}`), '');
  }
  assert.throws(
    () => boundedCutoverDirectoryInventory(entryOverflow, 'Synthetic cutover directory'),
    /bounded entry ceiling/,
  );

  const nameOverflow = path.join(directory, 'name-overflow');
  fs.mkdirSync(nameOverflow, { mode: 0o700 });
  for (let index = 0; index < 150; index += 1) {
    const name = `${'n'.repeat(220)}${String(index).padStart(4, '0')}`;
    fs.writeFileSync(path.join(nameOverflow, name), '');
  }
  assert.throws(
    () => boundedCutoverDirectoryInventory(nameOverflow, 'Synthetic cutover directory'),
    /bounded name-byte ceiling/,
  );
});

function privateTempDirectory(t: TestContext): string {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-import-verifier-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function writeReceipt(receiptPath: string, receipt: Readonly<Record<string, unknown>>): void {
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.chmodSync(receiptPath, 0o600);
}

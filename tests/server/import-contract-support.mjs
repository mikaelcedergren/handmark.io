import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { APPLICATION_FIELDS } from '../fixtures/application-import/records.mjs';

export const EXPECTED_CHECKPOINTS = Object.freeze([
  'source_opened',
  'source_validated',
  'temporary_created',
  'target_transaction_started',
  'record_inserted',
  'before_commit',
  'target_reopened',
  'marker_durable',
  'before_publish',
  'target_linked',
  'target_published',
  'final_source_verified',
  'replay_pinned',
]);

export const EXPECTED_LIMITS = Object.freeze({
  maxRecordBytes: 512 * 1024,
  // Fail-closed migration safety gates. Historical writers had no aggregate bounds, so exceeding
  // either value blocks cutover rather than making any source record invalid or skippable.
  maxRecords: 10_000,
  maxSourceBytes: 100 * 1024 * 1024,
});

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
export const COMPILED_IMPORTER_PATH = path.join(
  REPO_ROOT,
  'server',
  'dist',
  'application-import.js',
);

export function stagingDirectoryPath(databasePath) {
  return path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.import-stage`);
}

export function targetSidecarPaths(databasePath) {
  return [`${databasePath}-journal`, `${databasePath}-shm`, `${databasePath}-wal`];
}

export async function discoverImporter() {
  try {
    const module = await import(pathToFileURL(COMPILED_IMPORTER_PATH).href);
    const missing = [
      'APPLICATION_IMPORT_CHECKPOINTS',
      'APPLICATION_IMPORT_MAX_RECORD_BYTES',
      'APPLICATION_IMPORT_MAX_RECORDS',
      'APPLICATION_IMPORT_MAX_SOURCE_BYTES',
      'importApplicationsJsonl',
      'importApplicationsJsonlForTest',
    ].filter((name) => module[name] === undefined);
    if (missing.length > 0) {
      return {
        error: new Error(`Compiled importer is missing exports: ${missing.join(', ')}`),
        module: undefined,
      };
    }
    return { error: undefined, module };
  } catch (error) {
    return { error, module: undefined };
  }
}

export function setupImportFixture(t, { sourceName = 'applications.jsonl' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-import-contract-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return {
    databasePath: path.join(directory, 'handmark.sqlite'),
    directory,
    sourcePath: path.join(directory, sourceName),
  };
}

export function writeSource(sourcePath, bytes, mode = 0o640) {
  fs.writeFileSync(sourcePath, bytes, { mode });
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalRecordBytes(record) {
  return Buffer.from(
    JSON.stringify(Object.fromEntries(APPLICATION_FIELDS.map((field) => [field, record[field]]))),
    'utf8',
  );
}

export function recordHash(record) {
  return sha256(canonicalRecordBytes(record));
}

export function orderedRecordHash(records) {
  const hash = createHash('sha256');
  for (const record of records) hash.update(`${recordHash(record)}\n`, 'ascii');
  return hash.digest('hex');
}

export function expectedReceipt(sourceBytes, records) {
  return {
    formatVersion: 1,
    orderedRecordsSha256: orderedRecordHash(records),
    recordCount: records.length,
    sourceBytes: sourceBytes.byteLength,
    sourceSha256: sha256(sourceBytes),
  };
}

export function captureFile(filePath, { includeBytes = true } = {}) {
  const stats = fs.lstatSync(filePath);
  return {
    bytes: includeBytes ? fs.readFileSync(filePath) : undefined,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode & 0o777,
    nlink: stats.nlink,
    size: stats.size,
  };
}

export function assertPrivateOwnedRegularFile(filePath) {
  const stats = fs.lstatSync(filePath);
  assert.equal(stats.isFile(), true, `${filePath} is not a regular file`);
  assert.equal(stats.uid, process.getuid(), `${filePath} is not owned by the current user`);
  assert.equal(stats.mode & 0o777, 0o600, `${filePath} is not mode 0600`);
  assert.equal(stats.nlink, 1, `${filePath} is not a single-link file`);
}

export function assertPrivateOwnedDirectory(directoryPath) {
  const stats = fs.lstatSync(directoryPath);
  assert.equal(stats.isDirectory(), true, `${directoryPath} is not a directory`);
  assert.equal(stats.uid, process.getuid(), `${directoryPath} is not owned by the current user`);
  assert.equal(stats.mode & 0o777, 0o700, `${directoryPath} is not mode 0700`);
}

export function assertFileSnapshot(filePath, snapshot) {
  const current = captureFile(filePath, { includeBytes: snapshot.bytes !== undefined });
  assert.equal(current.dev, snapshot.dev, 'device changed');
  assert.equal(current.ino, snapshot.ino, 'inode changed');
  assert.equal(current.mode, snapshot.mode, 'mode changed');
  assert.equal(current.nlink, snapshot.nlink, 'link count changed');
  assert.equal(current.size, snapshot.size, 'byte length changed');
  if (snapshot.bytes !== undefined)
    assert.deepEqual(current.bytes, snapshot.bytes, 'bytes changed');
}

export function readImportedTarget(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const applications = queryImportedApplications(database);
    const receipt = database
      .prepare(
        `SELECT
           format_version AS formatVersion,
           source_bytes AS sourceBytes,
           source_sha256 AS sourceSha256,
           record_count AS recordCount,
           ordered_records_sha256 AS orderedRecordsSha256
         FROM application_import_receipts
         WHERE receipt_key = 'legacy_jsonl_v1'`,
      )
      .get();
    const integrity = database.prepare('PRAGMA integrity_check').get();
    return {
      applications,
      integrity: integrity && { ...integrity },
      receipt: receipt && { ...receipt },
    };
  } finally {
    database.close();
  }
}

export function readImportedApplications(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return queryImportedApplications(database);
  } finally {
    database.close();
  }
}

function queryImportedApplications(database) {
  const rows = database
    .prepare(
      `SELECT
         intake_sequence AS intakeSequence,
         id,
         created_at AS createdAt,
         created_at_ms AS createdAtMs,
         plan,
         billing_cycle AS billingCycle,
         name,
         email,
         contact_preference AS contactPreference,
         brand,
         website,
         category,
         craft_summary AS craftSummary,
         proof_links AS proofLinks,
         walkthrough_preference AS walkthroughPreference,
         payment_preference AS paymentPreference,
         record_hash AS recordHash,
         record_json AS recordJson
       FROM applications
       ORDER BY intake_sequence`,
    )
    .all();
  return rows.map((row) => {
    assert.ok(row.recordJson instanceof Uint8Array, 'record_json must be an authoritative BLOB');
    const canonicalBytes = Buffer.from(row.recordJson);
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(canonicalBytes));
    assert.deepEqual(Object.keys(record), APPLICATION_FIELDS);
    assert.deepEqual(canonicalBytes, canonicalRecordBytes(record));
    assert.equal(row.recordHash, sha256(canonicalBytes));
    for (const field of APPLICATION_FIELDS) {
      // SQLite TEXT replaces an unpaired UTF-16 surrogate with U+FFFD. The canonical BLOB remains
      // authoritative and reversible; every ordinary projection must otherwise be exact.
      assert.equal(row[field], Buffer.from(record[field], 'utf8').toString('utf8'), field);
    }
    return {
      intakeSequence: row.intakeSequence,
      ...record,
      createdAtMs: row.createdAtMs,
      recordHash: row.recordHash,
    };
  });
}

export function expectedRows(records) {
  return records.map((record, index) => ({
    intakeSequence: index + 1,
    ...record,
    createdAtMs: Date.parse(record.createdAt),
    recordHash: recordHash(record),
  }));
}

export function assertImportedTarget(databasePath, sourceBytes, records) {
  assertSuccessfulImportResidueAbsent(databasePath);
  assertPrivateOwnedRegularFile(databasePath);
  const target = readImportedTarget(databasePath);
  assert.deepEqual(target.applications, expectedRows(records));
  assert.deepEqual(target.receipt, expectedReceipt(sourceBytes, records));
  assert.deepEqual(target.integrity, { integrity_check: 'ok' });
  assertPrivateOwnedRegularFile(databasePath);
  assertSuccessfulImportResidueAbsent(databasePath);
  return target;
}

function assertSuccessfulImportResidueAbsent(databasePath) {
  assert.equal(
    fs.existsSync(stagingDirectoryPath(databasePath)),
    false,
    'successful import left a staging directory',
  );
  for (const sidecarPath of targetSidecarPaths(databasePath)) {
    assert.equal(fs.existsSync(sidecarPath), false, `successful import left ${sidecarPath}`);
  }
}

export async function expectImportError(action, code, details = {}) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.name, 'ApplicationImportError');
    assert.equal(error?.code, code);
    if (details.line !== undefined) assert.equal(error?.line, details.line);
    if (details.field !== undefined) assert.equal(error?.field, details.field);
    return true;
  });
}

export function assertNoTargetArtifacts(directory, databasePath, allowedNames = []) {
  assert.equal(fs.existsSync(databasePath), false, 'target database unexpectedly exists');
  const allowed = new Set(allowedNames);
  const unexpected = fs
    .readdirSync(directory)
    .filter((name) => !allowed.has(name))
    .filter((name) => name !== path.basename(databasePath) && !name.startsWith('.DS_Store'));
  assert.deepEqual(unexpected, [], `unexpected import artifacts: ${unexpected.join(', ')}`);
}

export function applicationLineAtBytes(record, targetBytes) {
  const seed = { ...record, craftSummary: 'x' };
  const baseBytes = Buffer.byteLength(JSON.stringify(seed));
  const padding = targetBytes - baseBytes;
  assert.ok(padding >= 0, 'target line size is smaller than the fixture record');
  const candidate = { ...seed, craftSummary: `x${'p'.repeat(padding)}` };
  assert.equal(Buffer.byteLength(JSON.stringify(candidate)), targetBytes);
  return candidate;
}

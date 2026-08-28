import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, type TestContext } from 'node:test';

import { createPreparedSyncSqliteAdapter } from '@mikaelcedergren/cx-framework/server/sqlite';

import type { ApplicationRecord } from './application-record.js';
import {
  appendApplication,
  EMPTY_APPLICATION_AUTHORITY_SHA256,
  EMPTY_APPLICATION_RECORDS_SHA256,
  insertApplicationImportReceipt,
} from './application-schema.js';
import { APPLICATION_RETENTION_MS } from './constants.js';
import {
  openApplicationRepository,
  type OpenApplicationRepositoryOptions,
} from './application-repository.js';

const fixtureRoots = new Set<string>();

after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { force: true, recursive: true });
});

function fixtureRoot(_t: TestContext): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'handmark-repository-')),
  );
  fixtureRoots.add(root);
  return root;
}

function application(id: string, createdAt: number): ApplicationRecord {
  return Object.freeze({
    id,
    createdAt: new Date(createdAt).toISOString(),
    plan: 'verification',
    billingCycle: 'monthly',
    name: 'Repository maker',
    email: 'repository@example.com',
    contactPreference: 'Email',
    brand: 'Repository studio',
    website: 'https://example.com',
    category: 'Furniture',
    craftSummary: 'Made by a person.',
    proofLinks: 'https://example.com/proof',
    walkthroughPreference: '',
    paymentPreference: 'after-approval',
  });
}

test('repository creates only real contained directories and rejects linked storage paths', (t) => {
  const fixture = fixtureRoot(t);
  const operationalRoot = path.join(fixture, 'root');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(operationalRoot);
  fs.mkdirSync(outside);

  const nestedDatabase = path.join(operationalRoot, 'data', 'nested', 'handmark.sqlite');
  const repository = openApplicationRepository({
    databasePath: nestedDatabase,
    operationalRoot,
  });
  repository.close();
  assert.ok(fs.lstatSync(path.dirname(nestedDatabase)).isDirectory());

  const linkedParent = path.join(operationalRoot, 'linked-data');
  fs.symlinkSync(outside, linkedParent);
  const escapedDatabase = path.join(linkedParent, 'escaped.sqlite');
  assert.throws(() =>
    openApplicationRepository({ databasePath: escapedDatabase, operationalRoot }),
  );
  assert.equal(fs.existsSync(path.join(outside, 'escaped.sqlite')), false);

  const linkedDatabase = path.join(operationalRoot, 'linked.sqlite');
  const linkTarget = path.join(outside, 'target.sqlite');
  fs.writeFileSync(linkTarget, 'not a database');
  fs.symlinkSync(linkTarget, linkedDatabase);
  assert.throws(() => openApplicationRepository({ databasePath: linkedDatabase, operationalRoot }));

  const hardlinkedDatabase = path.join(operationalRoot, 'hardlinked.sqlite');
  const secondLink = path.join(operationalRoot, 'hardlinked-copy.sqlite');
  fs.writeFileSync(hardlinkedDatabase, 'not a database');
  fs.linkSync(hardlinkedDatabase, secondLink);
  assert.throws(() =>
    openApplicationRepository({ databasePath: hardlinkedDatabase, operationalRoot }),
  );
});

test('health fails closed when the essential application schema disappears after startup', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  const repository = openApplicationRepository({ databasePath, operationalRoot });
  t.after(() => repository.close());
  assert.equal(repository.isReady(), true);

  const external = new DatabaseSync(databasePath);
  external.exec('DROP TABLE applications');
  external.close();
  assert.equal(repository.isReady(), false);
});

test('legacy source proof requires an exact sealed receipt before writable startup', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  const source = Object.freeze({
    kind: 'present_jsonl' as const,
    sourceBytes: 17,
    sourceSha256: 'a'.repeat(64),
  });

  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requiredLegacyImportAuthority: source,
      }),
    /must be imported.*before startup/,
  );
  assert.equal(fs.existsSync(databasePath), false);
  assert.equal(fs.existsSync(path.dirname(databasePath)), false);

  const initial = openApplicationRepository({ databasePath, operationalRoot });
  initial.close();
  const unsealedStorage = storageDirectorySnapshot(path.dirname(databasePath));
  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requiredLegacyImportAuthority: source,
      }),
    /does not contain a sealed legacy import receipt/,
  );
  assert.deepEqual(storageDirectorySnapshot(path.dirname(databasePath)), unsealedStorage);

  const native = new DatabaseSync(databasePath);
  insertApplicationImportReceipt(createPreparedSyncSqliteAdapter(native), {
    authorityKind: 'legacy_jsonl_v1',
    formatVersion: 1,
    orderedRecordsSha256: 'b'.repeat(64),
    recordCount: 0,
    ...source,
  });
  native.close();

  const repository = openApplicationRepository({
    databasePath,
    operationalRoot,
    requiredLegacyImportAuthority: source,
  });
  repository.close();
  const sealedStorage = storageDirectorySnapshot(path.dirname(databasePath));
  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requiredLegacyImportAuthority: { ...source, sourceSha256: 'c'.repeat(64) },
      }),
    /does not prove an exact import/,
  );
  assert.deepEqual(storageDirectorySnapshot(path.dirname(databasePath)), sealedStorage);
});

test('production rejects missing JSONL evidence even when its JSONL receipt is sealed', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');

  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requireLegacyImportReceipt: true,
      }),
    /must be imported.*before startup/,
  );
  assert.equal(fs.existsSync(databasePath), false);
  assert.equal(fs.existsSync(path.dirname(databasePath)), false);

  const initial = openApplicationRepository({ databasePath, operationalRoot });
  initial.close();
  const unsealedStorage = storageDirectorySnapshot(path.dirname(databasePath));
  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requireLegacyImportReceipt: true,
      }),
    /does not contain a sealed legacy import receipt/,
  );
  assert.deepEqual(storageDirectorySnapshot(path.dirname(databasePath)), unsealedStorage);

  const native = new DatabaseSync(databasePath);
  insertApplicationImportReceipt(createPreparedSyncSqliteAdapter(native), {
    authorityKind: 'legacy_jsonl_v1',
    formatVersion: 1,
    orderedRecordsSha256: 'd'.repeat(64),
    recordCount: 0,
    sourceBytes: 0,
    sourceSha256: 'e'.repeat(64),
  });
  native.close();

  const sealedStorage = storageDirectorySnapshot(path.dirname(databasePath));
  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requireLegacyImportReceipt: true,
        requiredLegacyImportAuthority: { kind: 'absent' },
      }),
    /does not prove an exact import/,
  );
  assert.deepEqual(storageDirectorySnapshot(path.dirname(databasePath)), sealedStorage);
});

test('absent startup authority accepts only a sealed receipt and keeps empty authority distinct', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  const initial = openApplicationRepository({ databasePath, operationalRoot });
  initial.close();
  const native = new DatabaseSync(databasePath);
  insertApplicationImportReceipt(createPreparedSyncSqliteAdapter(native), {
    authorityKind: 'legacy_empty_absence_v1',
    formatVersion: 1,
    orderedRecordsSha256: EMPTY_APPLICATION_RECORDS_SHA256,
    recordCount: 0,
    sourceBytes: 0,
    sourceSha256: EMPTY_APPLICATION_AUTHORITY_SHA256,
  });
  native.close();

  const checkpoints: string[] = [];
  const absent = openApplicationRepository({
    databasePath,
    onOpenCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    operationalRoot,
    requiredLegacyImportAuthority: { kind: 'absent' },
  });
  assert.ok(checkpoints.indexOf('writable_opened') < checkpoints.indexOf('receipt_verified'));
  assert.ok(checkpoints.indexOf('receipt_verified') < checkpoints.indexOf('before_write_verified'));
  assert.ok(checkpoints.indexOf('before_write_verified') < checkpoints.indexOf('configured'));
  absent.close();

  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requiredLegacyImportAuthority: {
          kind: 'present_jsonl',
          sourceBytes: 0,
          sourceSha256: EMPTY_APPLICATION_AUTHORITY_SHA256,
        },
      }),
    /does not prove an exact import/,
  );
  assert.throws(
    () =>
      openApplicationRepository({
        databasePath,
        operationalRoot,
        requiredLegacyImportAuthority: {
          kind: 'absent',
          unexpected: true,
        } as never,
      }),
    /must contain only its kind/,
  );
});

test('an open repository fails closed if its selected database path is replaced', (t) => {
  const operationalRoot = fixtureRoot(t);
  const dataDirectory = path.join(operationalRoot, 'data');
  const databasePath = path.join(dataDirectory, 'handmark.sqlite');
  const replacementPath = path.join(dataDirectory, 'replacement.sqlite');
  const displacedPath = path.join(dataDirectory, 'handmark-original.sqlite');
  const repository = openApplicationRepository({ databasePath, operationalRoot });
  createSealedDatabase(operationalRoot, replacementPath, 'e');
  fs.renameSync(databasePath, displacedPath);
  fs.renameSync(replacementPath, databasePath);

  assert.equal(repository.isReady(), false);
  assert.throws(() => repository.pruneExpired(Date.now()), /Application retention failed/);
  assert.throws(
    () => repository.close(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (nested: unknown) => nested instanceof Error && /path changed/iu.test(nested.message),
      ),
  );
});

test('repository accepts pinned existing WAL recovery files without replacing them', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  createSealedDatabase(operationalRoot, databasePath, '3');
  const external = new DatabaseSync(databasePath);
  t.after(() => external.close());
  external.exec('PRAGMA journal_mode=WAL');
  appendApplication(
    createPreparedSyncSqliteAdapter(external),
    application('HM-00000009', Date.parse('2026-01-01T00:00:00.000Z')),
  );
  const writeAheadLogPath = `${databasePath}-wal`;
  const sharedMemoryPath = `${databasePath}-shm`;
  assert.ok(fs.statSync(writeAheadLogPath).size > 0);
  const writeAheadLogIdentity = fs.statSync(writeAheadLogPath, { bigint: true });
  const sharedMemoryIdentity = fs.statSync(sharedMemoryPath, { bigint: true });

  const repository = openApplicationRepository({
    databasePath,
    operationalRoot,
    requireLegacyImportReceipt: true,
  });
  assert.equal(repository.isReady(), true);
  assert.equal(fs.statSync(writeAheadLogPath, { bigint: true }).ino, writeAheadLogIdentity.ino);
  assert.equal(fs.statSync(sharedMemoryPath, { bigint: true }).ino, sharedMemoryIdentity.ino);
  repository.close();
});

test('idle maintenance expires records at 90 days and stops cleanly', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  const acceptedAt = Date.parse('2026-01-01T00:00:00.000Z');
  let now = acceptedAt;
  let scheduled:
    | {
        cancelled: boolean;
        callback: () => void;
        delayMs: number;
        unrefCalled: boolean;
        unref(): void;
      }
    | undefined;
  const timerOptions: Pick<
    OpenApplicationRepositoryOptions,
    'cancelTimer' | 'clock' | 'scheduleTimer'
  > = {
    cancelTimer(timer) {
      if (scheduled && timer === scheduled) scheduled.cancelled = true;
    },
    clock: () => now,
    scheduleTimer(callback, delayMs) {
      scheduled = {
        callback,
        cancelled: false,
        delayMs,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      return scheduled;
    },
  };
  const repository = openApplicationRepository({
    databasePath,
    operationalRoot,
    ...timerOptions,
  });
  t.after(() => repository.close());
  repository.startMaintenance();
  assert.equal(repository.append(application('HM-00000001', acceptedAt), acceptedAt), 1);
  assert.ok(scheduled);
  assert.equal(scheduled.unrefCalled, true);
  assert.ok(scheduled.delayMs > 0);

  now = acceptedAt + APPLICATION_RETENTION_MS;
  const expiryCallback = scheduled.callback;
  expiryCallback();
  assert.equal(applicationCount(databasePath), 0);

  const newerAt = now;
  assert.equal(repository.append(application('HM-00000002', newerAt), newerAt), 2);
  assert.ok(scheduled);
  const stoppedCallback = scheduled.callback;
  repository.stopMaintenance();
  assert.equal(scheduled.cancelled, true);
  now = newerAt + APPLICATION_RETENTION_MS;
  stoppedCallback();
  assert.equal(applicationCount(databasePath), 1);
});

test('maintenance remains retryable when its error reporter throws', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  const acceptedAt = Date.parse('2026-01-01T00:00:00.000Z');
  let now = acceptedAt;
  let callback: (() => void) | undefined;
  let reports = 0;
  let schedules = 0;
  const repository = openApplicationRepository({
    cancelTimer: () => undefined,
    clock: () => now,
    databasePath,
    onMaintenanceError() {
      reports += 1;
      throw new Error('reporter unavailable');
    },
    operationalRoot,
    scheduleTimer(scheduled) {
      schedules += 1;
      callback = scheduled;
      return { unref: () => undefined };
    },
  });
  t.after(() => repository.close());
  repository.startMaintenance();
  repository.append(application('HM-00000001', acceptedAt), acceptedAt);
  const maintenance = callback;
  assert.ok(maintenance);

  const external = new DatabaseSync(databasePath);
  external.exec('DROP TABLE applications');
  external.close();
  now = acceptedAt + APPLICATION_RETENTION_MS;
  assert.doesNotThrow(maintenance);
  assert.equal(reports, 1);
  assert.equal(schedules, 2);
});

test('close releases SQLite and every path proof even when timer cancellation fails', (t) => {
  const operationalRoot = fixtureRoot(t);
  const databasePath = path.join(operationalRoot, 'data', 'handmark.sqlite');
  const acceptedAt = Date.parse('2026-01-01T00:00:00.000Z');
  let cancellationCalls = 0;
  const repository = openApplicationRepository({
    cancelTimer() {
      cancellationCalls += 1;
      throw new Error('timer cancellation failed');
    },
    clock: () => acceptedAt,
    databasePath,
    operationalRoot,
    scheduleTimer() {
      return { unref: () => undefined };
    },
  });
  repository.startMaintenance();
  repository.append(application('HM-00000010', acceptedAt), acceptedAt);

  assert.throws(() => repository.close(), /timer cancellation failed/);
  assert.equal(cancellationCalls, 1);
  assert.equal(repository.isReady(), false);
  assert.throws(
    () => repository.append(application('HM-00000011', acceptedAt), acceptedAt),
    /database is closed/,
  );
  assert.doesNotThrow(() => repository.close());
  assert.equal(fs.existsSync(`${databasePath}-wal`), false);
  assert.equal(fs.existsSync(`${databasePath}-shm`), false);
});

function applicationCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM applications').get() as {
      count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
}

function createSealedDatabase(
  operationalRoot: string,
  databasePath: string,
  hashCharacter: string,
): void {
  const repository = openApplicationRepository({ databasePath, operationalRoot });
  repository.close();
  const database = new DatabaseSync(databasePath);
  try {
    insertApplicationImportReceipt(createPreparedSyncSqliteAdapter(database), {
      authorityKind: 'legacy_jsonl_v1',
      formatVersion: 1,
      orderedRecordsSha256: hashCharacter.repeat(64),
      recordCount: 0,
      sourceBytes: 0,
      sourceSha256: hashCharacter.repeat(64),
    });
  } finally {
    database.close();
  }
}

function storageDirectorySnapshot(directory: string) {
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const filePath = path.join(directory, name);
      const stats = fs.lstatSync(filePath, { bigint: true });
      return Object.freeze({
        bytes: stats.isFile() ? fs.readFileSync(filePath) : undefined,
        changedAtNs: stats.ctimeNs,
        device: stats.dev,
        inode: stats.ino,
        links: stats.nlink,
        mode: stats.mode,
        modifiedAtNs: stats.mtimeNs,
        name,
        size: stats.size,
      });
    });
}

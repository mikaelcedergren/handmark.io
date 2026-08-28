import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import {
  applySqliteMigrations,
  configureSqlite,
  createPreparedSyncSqliteAdapter,
  type SqliteMigration,
} from '@mikaelcedergren/cx-framework/server/sqlite';

import type { ApplicationRecord } from './application-record.js';
import {
  appendApplication,
  deleteApplicationsAtOrBefore,
  HANDMARK_APPLICATION_MIGRATIONS,
  hasVerifiedLegacyApplicationImportReceipt,
  insertApplicationImportReceipt,
  migrateApplicationSchema,
  migrateApplicationSchemaWithLegacyReceipt,
  readMigrationSafeLegacyApplicationImportReceipt,
  readVerifiedLegacyApplicationImportReceipt,
} from './application-schema.js';

function databaseFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-schema-runtime-'));
  const native = new DatabaseSync(path.join(root, 'handmark.sqlite'));
  t.after(() => {
    native.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  const database = createPreparedSyncSqliteAdapter(native);
  configureSqlite(database, { busyTimeoutMs: 5_000, journalMode: 'delete' });
  migrateApplicationSchema(database, () => '2026-08-25T00:00:00.000Z');
  return database;
}

function application(id: string, createdAt = '2026-08-25T00:00:00.000Z'): ApplicationRecord {
  return Object.freeze({
    id,
    createdAt,
    plan: 'verification',
    billingCycle: 'monthly',
    name: 'Runtime maker',
    email: 'runtime@example.com',
    contactPreference: 'Email',
    brand: 'Runtime studio',
    website: 'https://example.com',
    category: 'Furniture',
    craftSummary: 'Made by a person.',
    proofLinks: 'https://example.com/proof',
    walkthroughPreference: '',
    paymentPreference: 'after-approval',
  });
}

test('runtime append returns monotonic sequence and exposes only id collisions', (t) => {
  const database = databaseFixture(t);
  assert.equal(appendApplication(database, application('HM-00000001')), 1);
  assert.equal(
    appendApplication(database, {
      ...application('HM-00000001'),
      email: 'different@example.com',
    }),
    undefined,
  );
  assert.deepEqual(database.get("SELECT seq FROM sqlite_sequence WHERE name = 'applications'"), {
    seq: 1,
  });
  assert.equal(appendApplication(database, application('HM-00000002')), 2);
  assert.throws(() =>
    appendApplication(database, {
      ...application('HM-00000003'),
      plan: 'invalid',
    }),
  );
});

test('legacy import receipt interlock is read-only and proves the sealed canonical row', (t) => {
  const database = databaseFixture(t);
  assert.equal(hasVerifiedLegacyApplicationImportReceipt(database), false);
  assert.equal(readVerifiedLegacyApplicationImportReceipt(database), undefined);
  const receipt = {
    authorityKind: 'legacy_jsonl_v1',
    formatVersion: 1,
    orderedRecordsSha256: '1'.repeat(64),
    recordCount: 0,
    sourceBytes: 0,
    sourceSha256: '2'.repeat(64),
  } as const;
  insertApplicationImportReceipt(database, receipt);
  assert.equal(hasVerifiedLegacyApplicationImportReceipt(database), true);
  assert.deepEqual(readVerifiedLegacyApplicationImportReceipt(database), receipt);
});

test('sealed receipt proof accepts a canonical migration prefix before an upgrade', (t) => {
  const database = databaseFixture(t);
  const receipt = {
    authorityKind: 'legacy_jsonl_v1',
    formatVersion: 1,
    orderedRecordsSha256: '3'.repeat(64),
    recordCount: 0,
    sourceBytes: 0,
    sourceSha256: '4'.repeat(64),
  } as const;
  insertApplicationImportReceipt(database, receipt);
  const futureMigration = Object.freeze({
    version: 3,
    name: 'future_upgrade_fixture',
    statements: Object.freeze([
      'CREATE TABLE future_upgrade_fixture (id INTEGER PRIMARY KEY) STRICT',
    ]),
  } as const satisfies SqliteMigration);

  assert.deepEqual(
    readMigrationSafeLegacyApplicationImportReceipt(database, [
      ...HANDMARK_APPLICATION_MIGRATIONS,
      futureMigration,
    ]),
    receipt,
  );
  assert.doesNotThrow(() =>
    migrateApplicationSchemaWithLegacyReceipt(database, receipt, () => '2026-08-25T00:00:01.000Z'),
  );
  assert.deepEqual(readVerifiedLegacyApplicationImportReceipt(database), receipt);
});

test('authority migration adopts an existing sealed v1 receipt as JSONL evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-schema-v1-'));
  const native = new DatabaseSync(path.join(root, 'handmark.sqlite'));
  t.after(() => {
    native.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  const database = createPreparedSyncSqliteAdapter(native);
  configureSqlite(database, { busyTimeoutMs: 5_000, journalMode: 'delete' });
  applySqliteMigrations(database, HANDMARK_APPLICATION_MIGRATIONS.slice(0, 1), {
    fingerprint: (canonicalSource) => createHash('sha256').update(canonicalSource).digest('hex'),
    now: () => '2026-08-25T00:00:00.000Z',
  });
  const receipt = {
    authorityKind: 'legacy_jsonl_v1',
    formatVersion: 1,
    orderedRecordsSha256: '5'.repeat(64),
    recordCount: 0,
    sourceBytes: 0,
    sourceSha256: '6'.repeat(64),
  } as const;
  assert.equal(
    database.run(
      `INSERT INTO application_import_receipts (
         receipt_key, format_version, source_bytes, source_sha256, record_count,
         ordered_records_sha256
       ) VALUES ('legacy_jsonl_v1', ?, ?, ?, ?, ?)`,
      [
        receipt.formatVersion,
        receipt.sourceBytes,
        receipt.sourceSha256,
        receipt.recordCount,
        receipt.orderedRecordsSha256,
      ],
    ).changes,
    1,
  );

  assert.deepEqual(
    database.all('SELECT version, name FROM cx_schema_migrations ORDER BY version'),
    [{ name: 'create_application_intake', version: 1 }],
  );
  assert.deepEqual(readMigrationSafeLegacyApplicationImportReceipt(database), receipt);
  migrateApplicationSchemaWithLegacyReceipt(database, receipt, () => '2026-08-25T00:00:01.000Z');
  assert.deepEqual(readVerifiedLegacyApplicationImportReceipt(database), receipt);
  assert.deepEqual(
    database.all('SELECT version, name FROM cx_schema_migrations ORDER BY version'),
    [
      { name: 'create_application_intake', version: 1 },
      { name: 'seal_legacy_import_authority', version: 2 },
    ],
  );
  assert.deepEqual(
    database.get(
      `SELECT authority_key, receipt_key, authority_kind
       FROM application_import_authorities`,
    ),
    {
      authority_key: 'legacy_cutover_v1',
      authority_kind: 'legacy_jsonl_v1',
      receipt_key: 'legacy_jsonl_v1',
    },
  );
});

test('runtime retention deletes at and before the cutoff only', (t) => {
  const database = databaseFixture(t);
  const cutoff = Date.parse('2026-05-27T00:00:00.000Z');
  assert.equal(
    appendApplication(database, application('HM-00000001', new Date(cutoff - 1).toISOString())),
    1,
  );
  assert.equal(
    appendApplication(database, application('HM-00000002', new Date(cutoff).toISOString())),
    2,
  );
  assert.equal(
    appendApplication(database, application('HM-00000003', new Date(cutoff + 1).toISOString())),
    3,
  );
  assert.equal(deleteApplicationsAtOrBefore(database, cutoff), 2);
  assert.deepEqual(database.all('SELECT id FROM applications ORDER BY intake_sequence'), [
    { id: 'HM-00000003' },
  ]);
});

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
} from '@mikaelcedergren/cx-framework/server/sqlite';

import type { ApplicationRecord } from './application-record.js';
import {
  appendApplication,
  deleteApplicationsAtOrBefore,
  HANDMARK_APPLICATION_MIGRATIONS,
  migrateApplicationSchema,
  verifyApplicationSchema,
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
  return { database, native };
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

test('fresh schema contains only current application storage', (t) => {
  const { database } = databaseFixture(t);
  migrateApplicationSchema(database, () => '2026-08-25T00:00:00.000Z');
  assert.doesNotThrow(() => verifyApplicationSchema(database));
  assert.deepEqual(
    database.all('SELECT version, name FROM cx_schema_migrations ORDER BY version'),
    [
      { name: 'create_application_intake', version: 1 },
      { name: 'seal_legacy_import_authority', version: 2 },
      { name: 'retire_import_evidence', version: 3 },
    ],
  );
  assert.deepEqual(
    database.all(
      "SELECT name FROM sqlite_schema WHERE name LIKE 'application_import_%' ORDER BY name",
    ),
    [],
  );
});

test('the forward migration preserves applications and removes closed import evidence', (t) => {
  const { database } = databaseFixture(t);
  applySqliteMigrations(database, HANDMARK_APPLICATION_MIGRATIONS.slice(0, 2), {
    fingerprint: (canonicalSource) => createHash('sha256').update(canonicalSource).digest('hex'),
    now: () => '2026-08-25T00:00:00.000Z',
  });
  const record = application('HM-00000001');
  assert.equal(appendApplication(database, record), 1);
  assert.equal(
    database.run(
      `INSERT INTO application_import_receipts (
         receipt_key, format_version, source_bytes, source_sha256, record_count,
         ordered_records_sha256
       ) VALUES ('legacy_jsonl_v1', 1, 0, ?, 1, ?)`,
      ['a'.repeat(64), 'b'.repeat(64)],
    ).changes,
    1,
  );
  assert.equal(
    database.run(
      `INSERT INTO application_import_authorities (
         authority_key, receipt_key, authority_kind
       ) VALUES ('legacy_cutover_v1', 'legacy_jsonl_v1', 'legacy_jsonl_v1')`,
    ).changes,
    1,
  );

  migrateApplicationSchema(database, () => '2026-08-25T00:00:01.000Z');

  const preserved = database.get<{
    readonly id: string;
    readonly intake_sequence: number;
    readonly record_hash: string;
  }>('SELECT intake_sequence, id, record_hash FROM applications');
  assert.equal(preserved?.id, record.id);
  assert.equal(preserved?.intake_sequence, 1);
  assert.match(preserved?.record_hash ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(
    database.all(
      "SELECT name FROM sqlite_schema WHERE name LIKE 'application_import_%' ORDER BY name",
    ),
    [],
  );
  assert.doesNotThrow(() => verifyApplicationSchema(database));
});

test('runtime append is monotonic and exposes only id collisions', (t) => {
  const { database } = databaseFixture(t);
  migrateApplicationSchema(database, () => '2026-08-25T00:00:00.000Z');
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

test('runtime retention deletes at and before the cutoff only', (t) => {
  const { database } = databaseFixture(t);
  migrateApplicationSchema(database, () => '2026-08-25T00:00:00.000Z');
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

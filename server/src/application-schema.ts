import {
  SQLITE_MIGRATION_LEDGER_TABLE,
  applySqliteMigrations,
  withImmediateTransaction,
  type ReadonlySyncSqliteDatabase,
  type SqliteMigration,
  type SqliteRow,
  type SqliteValue,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';
import { sha256Hex } from '@mikaelcedergren/cx-framework/server/signing';

import {
  applicationRecordHash,
  canonicalApplicationRecordBytes,
  sqliteTextProjection,
  type ApplicationRecord,
} from './application-record.js';

const APPLICATIONS_TABLE = 'applications';
const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  'applications',
  'applications_created_at_ms_idx',
  'applications_immutable_update',
] as const);
const RECEIPT_SCHEMA_OBJECTS = Object.freeze([
  'application_import_receipts',
  'application_import_receipts_sealed_delete',
  'application_import_receipts_sealed_insert',
  'application_import_receipts_sealed_update',
] as const);
const AUTHORITY_SCHEMA_OBJECTS = Object.freeze([
  'application_import_authorities',
  'application_import_authorities_sealed_delete',
  'application_import_authorities_sealed_insert',
  'application_import_authorities_sealed_update',
] as const);
const EXPECTED_SCHEMA_OBJECT_NAMES = Object.freeze(
  [
    ...REQUIRED_SCHEMA_OBJECTS,
    SQLITE_MIGRATION_LEDGER_TABLE,
    'sqlite_autoindex_applications_1',
    'sqlite_autoindex_cx_schema_migrations_1',
    'sqlite_sequence',
  ].toSorted(),
);

const MIGRATION_LEDGER_TABLE_SQL = `CREATE TABLE cx_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`;

const APPLICATIONS_TABLE_SQL = `CREATE TABLE applications (
  intake_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE
    CHECK(length(id) = 11 AND substr(id, 1, 3) = 'HM-'
      AND substr(id, 4) NOT GLOB '*[^0-9A-F]*'),
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms) = 'integer'),
  plan TEXT NOT NULL CHECK(plan = 'verification'),
  billing_cycle TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact_preference TEXT NOT NULL,
  brand TEXT NOT NULL,
  website TEXT NOT NULL,
  category TEXT NOT NULL,
  craft_summary TEXT NOT NULL,
  proof_links TEXT NOT NULL,
  walkthrough_preference TEXT NOT NULL,
  payment_preference TEXT NOT NULL,
  record_json BLOB NOT NULL CHECK(typeof(record_json) = 'blob'),
  record_hash TEXT NOT NULL
    CHECK(length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*')
) STRICT`;

const APPLICATIONS_CREATED_AT_INDEX_SQL =
  'CREATE INDEX applications_created_at_ms_idx ON applications(created_at_ms, intake_sequence)';

const APPLICATION_VALUE_COLUMNS_SQL = `id, created_at, created_at_ms, plan, billing_cycle, name,
  email, contact_preference, brand, website, category, craft_summary, proof_links,
  walkthrough_preference, payment_preference, record_json, record_hash`;

const APPLICATION_ROW_COLUMNS_SQL = `intake_sequence, ${APPLICATION_VALUE_COLUMNS_SQL}`;

const APPLICATION_APPEND_SQL = `INSERT INTO ${APPLICATIONS_TABLE} (
  ${APPLICATION_VALUE_COLUMNS_SQL}
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING
RETURNING ${APPLICATION_ROW_COLUMNS_SQL}`;

const APPLICATION_ID_COLLISION = Object.freeze({ kind: 'application_id_collision' });

// Versions 1 and 2 are immutable migration history. Their import-evidence objects are created with
// their original bytes so existing databases keep verifiable ledger fingerprints, then version 3
// removes them permanently. No current runtime path reads or depends on those objects.
const IMPORT_RECEIPTS_TABLE_SQL = `CREATE TABLE application_import_receipts (
  receipt_key TEXT PRIMARY KEY CHECK(receipt_key = 'legacy_jsonl_v1'),
  format_version INTEGER NOT NULL CHECK(format_version = 1),
  source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
  source_sha256 TEXT NOT NULL
    CHECK(length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_count INTEGER NOT NULL CHECK(record_count >= 0),
  ordered_records_sha256 TEXT NOT NULL
    CHECK(length(ordered_records_sha256) = 64
      AND ordered_records_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT`;

const RECEIPT_SEALED_INSERT_TRIGGER_SQL = `CREATE TRIGGER application_import_receipts_sealed_insert
BEFORE INSERT ON application_import_receipts
WHEN NEW.receipt_key <> 'legacy_jsonl_v1'
  OR EXISTS (SELECT 1 FROM application_import_receipts)
BEGIN
  SELECT RAISE(ABORT, 'application import receipts are sealed and immutable');
END`;

const RECEIPT_SEALED_UPDATE_TRIGGER_SQL = `CREATE TRIGGER application_import_receipts_sealed_update
BEFORE UPDATE ON application_import_receipts
BEGIN
  SELECT RAISE(ABORT, 'application import receipts are sealed and immutable');
END`;

const RECEIPT_SEALED_DELETE_TRIGGER_SQL = `CREATE TRIGGER application_import_receipts_sealed_delete
BEFORE DELETE ON application_import_receipts
BEGIN
  SELECT RAISE(ABORT, 'application import receipts are sealed and immutable');
END`;

const IMPORT_AUTHORITIES_TABLE_SQL = `CREATE TABLE application_import_authorities (
  authority_key TEXT PRIMARY KEY CHECK(authority_key = 'legacy_cutover_v1'),
  receipt_key TEXT NOT NULL UNIQUE CHECK(receipt_key = 'legacy_jsonl_v1')
    REFERENCES application_import_receipts(receipt_key),
  authority_kind TEXT NOT NULL
    CHECK(authority_kind IN ('legacy_jsonl_v1', 'legacy_empty_absence_v1'))
) STRICT`;

const AUTHORITY_SEALED_INSERT_TRIGGER_SQL = `CREATE TRIGGER application_import_authorities_sealed_insert
BEFORE INSERT ON application_import_authorities
WHEN NEW.authority_key <> 'legacy_cutover_v1'
  OR NEW.receipt_key <> 'legacy_jsonl_v1'
  OR EXISTS (SELECT 1 FROM application_import_authorities)
BEGIN
  SELECT RAISE(ABORT, 'application import authorities are sealed and immutable');
END`;

const AUTHORITY_SEALED_UPDATE_TRIGGER_SQL = `CREATE TRIGGER application_import_authorities_sealed_update
BEFORE UPDATE ON application_import_authorities
BEGIN
  SELECT RAISE(ABORT, 'application import authorities are sealed and immutable');
END`;

const AUTHORITY_SEALED_DELETE_TRIGGER_SQL = `CREATE TRIGGER application_import_authorities_sealed_delete
BEFORE DELETE ON application_import_authorities
BEGIN
  SELECT RAISE(ABORT, 'application import authorities are sealed and immutable');
END`;

const ADOPT_JSONL_AUTHORITY_SQL = `INSERT INTO application_import_authorities (
  authority_key, receipt_key, authority_kind
)
SELECT 'legacy_cutover_v1', receipt_key, 'legacy_jsonl_v1'
FROM application_import_receipts
WHERE receipt_key = 'legacy_jsonl_v1'`;

const APPLICATION_IMMUTABLE_UPDATE_TRIGGER_SQL = `CREATE TRIGGER applications_immutable_update
BEFORE UPDATE ON applications
BEGIN
  SELECT RAISE(ABORT, 'application records are immutable');
END`;

export const HANDMARK_APPLICATION_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'create_application_intake',
    statements: Object.freeze([
      APPLICATIONS_TABLE_SQL,
      APPLICATIONS_CREATED_AT_INDEX_SQL,
      IMPORT_RECEIPTS_TABLE_SQL,
      RECEIPT_SEALED_INSERT_TRIGGER_SQL,
      RECEIPT_SEALED_UPDATE_TRIGGER_SQL,
      RECEIPT_SEALED_DELETE_TRIGGER_SQL,
      APPLICATION_IMMUTABLE_UPDATE_TRIGGER_SQL,
    ] as const),
  }),
  Object.freeze({
    version: 2,
    name: 'seal_legacy_import_authority',
    statements: Object.freeze([
      IMPORT_AUTHORITIES_TABLE_SQL,
      AUTHORITY_SEALED_INSERT_TRIGGER_SQL,
      AUTHORITY_SEALED_UPDATE_TRIGGER_SQL,
      AUTHORITY_SEALED_DELETE_TRIGGER_SQL,
      ADOPT_JSONL_AUTHORITY_SQL,
    ] as const),
  }),
  Object.freeze({
    version: 3,
    name: 'retire_import_evidence',
    statements: Object.freeze([
      'DROP TRIGGER application_import_authorities_sealed_delete',
      'DROP TRIGGER application_import_authorities_sealed_update',
      'DROP TRIGGER application_import_authorities_sealed_insert',
      'DROP TABLE application_import_authorities',
      'DROP TRIGGER application_import_receipts_sealed_delete',
      'DROP TRIGGER application_import_receipts_sealed_update',
      'DROP TRIGGER application_import_receipts_sealed_insert',
      'DROP TABLE application_import_receipts',
    ] as const),
  }),
] as const satisfies readonly SqliteMigration[]);

export function migrateApplicationSchema(
  database: SyncSqliteDatabase,
  now: () => string = () => new Date().toISOString(),
): void {
  const result = applySqliteMigrations(database, HANDMARK_APPLICATION_MIGRATIONS, {
    fingerprint: sha256Hex,
    now,
  });
  if (result.currentVersion !== HANDMARK_APPLICATION_MIGRATIONS.length) {
    throw new Error('Handmark application schema did not reach its canonical migration version.');
  }
  verifyApplicationSchema(database);
}

/** Append one canonical record. Undefined means only that its generated id already exists. */
export function appendApplication(
  database: SyncSqliteDatabase,
  record: ApplicationRecord,
): number | undefined {
  try {
    return withImmediateTransaction(database, () => {
      const row = database.get<ApplicationRow>(
        APPLICATION_APPEND_SQL,
        applicationRecordSqlValues(record),
      );
      if (!row) throw APPLICATION_ID_COLLISION;
      const intakeSequence = safeInteger(row.intake_sequence, 'Application intake sequence');
      if (intakeSequence < 1) {
        throw new Error('Application intake sequence must be a positive safe integer.');
      }
      assertApplicationRow(row, record, intakeSequence);
      return intakeSequence;
    });
  } catch (error) {
    if (error === APPLICATION_ID_COLLISION) return undefined;
    throw error;
  }
}

/** Delete every application whose retention boundary has been reached, including the cutoff. */
export function deleteApplicationsAtOrBefore(
  database: SyncSqliteDatabase,
  cutoffEpochMs: number,
): number {
  const cutoff = safeInteger(cutoffEpochMs, 'Application retention cutoff');
  return database.run(`DELETE FROM ${APPLICATIONS_TABLE} WHERE created_at_ms <= ?`, [cutoff])
    .changes;
}

export function verifyApplicationSchema(database: ReadonlySyncSqliteDatabase): void {
  verifyApplicationMigrationLedger(database, true);
  verifyCurrentSchemaObjects(database);
}

/**
 * Read-only ownership proof required before an existing database can be opened writable. It accepts
 * only a byte-authentic prefix of this product's migration ledger and the exact schema for that
 * prefix. Pending migrations remain the sole writer after this check.
 */
export function verifyApplicationDatabaseBeforeWrite(database: ReadonlySyncSqliteDatabase): void {
  const applied = verifyApplicationMigrationLedger(database, false);
  if (applied === HANDMARK_APPLICATION_MIGRATIONS.length) {
    verifyCurrentSchemaObjects(database);
    return;
  }
  if (applied < 1 || applied > 2) {
    throw new Error('Handmark database has no supported schema prefix.');
  }

  const required = [
    ...REQUIRED_SCHEMA_OBJECTS,
    ...RECEIPT_SCHEMA_OBJECTS,
    ...(applied === 2 ? AUTHORITY_SCHEMA_OBJECTS : []),
  ];
  const expectedNames = [
    ...required,
    SQLITE_MIGRATION_LEDGER_TABLE,
    'sqlite_autoindex_application_import_receipts_1',
    ...(applied === 2
      ? [
          'sqlite_autoindex_application_import_authorities_1',
          'sqlite_autoindex_application_import_authorities_2',
        ]
      : []),
    'sqlite_autoindex_applications_1',
    'sqlite_autoindex_cx_schema_migrations_1',
    'sqlite_sequence',
  ].toSorted();
  assertExactSchemaNames(database, expectedNames);

  const schemaRows = database.all<SchemaRow>(
    `SELECT type, name, sql
     FROM sqlite_schema
     WHERE name IN (${required.map(() => '?').join(', ')})
     ORDER BY name`,
    required,
  );
  const schema = new Map(schemaRows.map((row) => [row.name, row]));
  assertCurrentApplicationSchema(schema);
  assertSchemaObject(schema, 'application_import_receipts', 'table', IMPORT_RECEIPTS_TABLE_SQL);
  assertSchemaObject(
    schema,
    'application_import_receipts_sealed_insert',
    'trigger',
    RECEIPT_SEALED_INSERT_TRIGGER_SQL,
  );
  assertSchemaObject(
    schema,
    'application_import_receipts_sealed_update',
    'trigger',
    RECEIPT_SEALED_UPDATE_TRIGGER_SQL,
  );
  assertSchemaObject(
    schema,
    'application_import_receipts_sealed_delete',
    'trigger',
    RECEIPT_SEALED_DELETE_TRIGGER_SQL,
  );
  if (applied === 2) assertAuthoritySchema(schema);
}

function verifyCurrentSchemaObjects(database: ReadonlySyncSqliteDatabase): void {
  assertExactSchemaNames(database, EXPECTED_SCHEMA_OBJECT_NAMES);

  const schemaRows = database.all<SchemaRow>(
    `SELECT type, name, sql
     FROM sqlite_schema
     WHERE name IN (${REQUIRED_SCHEMA_OBJECTS.map(() => '?').join(', ')})
     ORDER BY name`,
    REQUIRED_SCHEMA_OBJECTS,
  );
  const schema = new Map(schemaRows.map((row) => [row.name, row]));
  assertCurrentApplicationSchema(schema);
}

function assertCurrentApplicationSchema(schema: ReadonlyMap<string, SchemaRow>): void {
  assertSchemaObject(schema, 'applications', 'table', APPLICATIONS_TABLE_SQL);
  assertSchemaObject(
    schema,
    'applications_created_at_ms_idx',
    'index',
    APPLICATIONS_CREATED_AT_INDEX_SQL,
  );
  assertSchemaObject(
    schema,
    'applications_immutable_update',
    'trigger',
    APPLICATION_IMMUTABLE_UPDATE_TRIGGER_SQL,
  );
}

function assertAuthoritySchema(schema: ReadonlyMap<string, SchemaRow>): void {
  assertSchemaObject(
    schema,
    'application_import_authorities',
    'table',
    IMPORT_AUTHORITIES_TABLE_SQL,
  );
  assertSchemaObject(
    schema,
    'application_import_authorities_sealed_insert',
    'trigger',
    AUTHORITY_SEALED_INSERT_TRIGGER_SQL,
  );
  assertSchemaObject(
    schema,
    'application_import_authorities_sealed_update',
    'trigger',
    AUTHORITY_SEALED_UPDATE_TRIGGER_SQL,
  );
  assertSchemaObject(
    schema,
    'application_import_authorities_sealed_delete',
    'trigger',
    AUTHORITY_SEALED_DELETE_TRIGGER_SQL,
  );
}

function verifyApplicationMigrationLedger(
  database: ReadonlySyncSqliteDatabase,
  requireCurrent: boolean,
): number {
  const ledger = database.all<MigrationLedgerRow>(
    `SELECT version, name, fingerprint, applied_at
     FROM ${SQLITE_MIGRATION_LEDGER_TABLE}
     ORDER BY version`,
  );
  if (
    ledger.length > HANDMARK_APPLICATION_MIGRATIONS.length ||
    (requireCurrent && ledger.length !== HANDMARK_APPLICATION_MIGRATIONS.length)
  ) {
    throw new Error('Handmark canonical SQLite migration ledger has an unexpected length.');
  }
  for (const [index, row] of ledger.entries()) {
    const migration = HANDMARK_APPLICATION_MIGRATIONS[index];
    if (
      !migration ||
      safeInteger(row.version, 'Migration version') !== migration.version ||
      row.name !== migration.name ||
      row.fingerprint !== migrationFingerprint(migration) ||
      typeof row.applied_at !== 'string' ||
      !isCanonicalTimestamp(row.applied_at)
    ) {
      throw new Error(`Handmark migration ledger row ${String(index + 1)} does not match source.`);
    }
  }
  const ledgerSchema = database.get<SchemaRow>(
    'SELECT type, name, sql FROM sqlite_schema WHERE name = ?',
    [SQLITE_MIGRATION_LEDGER_TABLE],
  );
  if (
    !ledgerSchema ||
    ledgerSchema.type !== 'table' ||
    typeof ledgerSchema.sql !== 'string' ||
    normalizeSql(ledgerSchema.sql) !== normalizeSql(MIGRATION_LEDGER_TABLE_SQL)
  ) {
    throw new Error('Handmark canonical SQLite migration ledger schema does not match.');
  }
  return ledger.length;
}

interface MigrationLedgerRow extends SqliteRow {
  readonly version: number | bigint;
  readonly name: string;
  readonly fingerprint: string;
  readonly applied_at: string;
}

interface SchemaRow extends SqliteRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

interface SchemaNameRow extends SqliteRow {
  readonly name: string;
}

interface ApplicationRow extends SqliteRow {
  readonly intake_sequence: number | bigint;
  readonly id: string;
  readonly created_at: string;
  readonly created_at_ms: number | bigint;
  readonly plan: string;
  readonly billing_cycle: string;
  readonly name: string;
  readonly email: string;
  readonly contact_preference: string;
  readonly brand: string;
  readonly website: string;
  readonly category: string;
  readonly craft_summary: string;
  readonly proof_links: string;
  readonly walkthrough_preference: string;
  readonly payment_preference: string;
  readonly record_json: Uint8Array;
  readonly record_hash: string;
}

function applicationRecordSqlValues(record: ApplicationRecord): readonly SqliteValue[] {
  return [
    sqliteTextProjection(record.id),
    sqliteTextProjection(record.createdAt),
    Date.parse(record.createdAt),
    sqliteTextProjection(record.plan),
    sqliteTextProjection(record.billingCycle),
    sqliteTextProjection(record.name),
    sqliteTextProjection(record.email),
    sqliteTextProjection(record.contactPreference),
    sqliteTextProjection(record.brand),
    sqliteTextProjection(record.website),
    sqliteTextProjection(record.category),
    sqliteTextProjection(record.craftSummary),
    sqliteTextProjection(record.proofLinks),
    sqliteTextProjection(record.walkthroughPreference),
    sqliteTextProjection(record.paymentPreference),
    canonicalApplicationRecordBytes(record),
    applicationRecordHash(record),
  ];
}

function assertApplicationRow(
  row: ApplicationRow,
  expected: ApplicationRecord,
  intakeSequence: number,
): void {
  const canonicalBytes = canonicalApplicationRecordBytes(expected);
  const storedBytes = Buffer.from(
    row.record_json.buffer,
    row.record_json.byteOffset,
    row.record_json.byteLength,
  );
  if (!storedBytes.equals(canonicalBytes)) {
    throw new Error('Application canonical record bytes do not match.');
  }

  const expectedProjection = {
    id: sqliteTextProjection(expected.id),
    created_at: sqliteTextProjection(expected.createdAt),
    plan: sqliteTextProjection(expected.plan),
    billing_cycle: sqliteTextProjection(expected.billingCycle),
    name: sqliteTextProjection(expected.name),
    email: sqliteTextProjection(expected.email),
    contact_preference: sqliteTextProjection(expected.contactPreference),
    brand: sqliteTextProjection(expected.brand),
    website: sqliteTextProjection(expected.website),
    category: sqliteTextProjection(expected.category),
    craft_summary: sqliteTextProjection(expected.craftSummary),
    proof_links: sqliteTextProjection(expected.proofLinks),
    walkthrough_preference: sqliteTextProjection(expected.walkthroughPreference),
    payment_preference: sqliteTextProjection(expected.paymentPreference),
  } as const;
  for (const [column, value] of Object.entries(expectedProjection)) {
    if (row[column] !== value) {
      throw new Error(`Application projection ${column} does not match.`);
    }
  }

  if (
    safeInteger(row.intake_sequence, 'Application intake sequence') !== intakeSequence ||
    safeInteger(row.created_at_ms, 'Application created-at milliseconds') !==
      Date.parse(expected.createdAt) ||
    row.record_hash !== applicationRecordHash(expected)
  ) {
    throw new Error('Application metadata does not match its canonical record.');
  }
}

function assertSchemaObject(
  schema: ReadonlyMap<string, SchemaRow>,
  name: string,
  type: string,
  sql: string,
): void {
  const row = schema.get(name);
  if (
    !row ||
    row.type !== type ||
    typeof row.sql !== 'string' ||
    normalizeSql(row.sql) !== normalizeSql(sql)
  ) {
    throw new Error(`Handmark schema object ${name} does not match its canonical definition.`);
  }
}

function assertExactSchemaNames(
  database: ReadonlySyncSqliteDatabase,
  expected: readonly string[],
): void {
  const names = database
    .all<SchemaNameRow>('SELECT name FROM sqlite_schema ORDER BY name')
    .map((row) => row.name);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('Handmark database contains an unexpected or missing schema object.');
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function migrationFingerprint(migration: SqliteMigration): string {
  return sha256Hex(
    JSON.stringify({
      name: migration.name,
      statements: migration.statements,
      version: migration.version,
    }),
  );
}

function safeInteger(value: number | bigint | undefined, label: string): number {
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || BigInt(number) !== value) {
      throw new Error(`${label} exceeds the safe integer range.`);
    }
    return number;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer.`);
  }
  return value;
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

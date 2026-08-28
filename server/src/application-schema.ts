import {
  SQLITE_MIGRATION_LEDGER_TABLE,
  applySqliteMigrations,
  applySqliteMigrationsAtomically,
  verifySqliteIntegrity,
  withImmediateTransaction,
  type ReadonlySyncSqliteDatabase,
  type SqliteMigration,
  type SqliteRow,
  type SqliteValue,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';
import { sha256Hex } from '@mikaelcedergren/cx-framework/server/signing';
import {
  APPLICATION_RECORD_FIELDS,
  applicationRecordHash,
  canonicalApplicationRecordBytes,
  parseHistoricalApplicationRecord,
  sqliteTextProjection,
  type ApplicationRecord,
} from './application-record.js';

export const APPLICATION_IMPORT_RECEIPT_KEY = 'legacy_jsonl_v1';
export const APPLICATION_IMPORT_FORMAT_VERSION = 1;

export interface ApplicationImportReceipt {
  readonly formatVersion: number;
  readonly orderedRecordsSha256: string;
  readonly recordCount: number;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
}

const APPLICATIONS_TABLE = 'applications';
const IMPORT_RECEIPTS_TABLE = 'application_import_receipts';
const RECEIPT_SCHEMA_OBJECTS = Object.freeze([
  'application_import_receipts',
  'application_import_receipts_sealed_delete',
  'application_import_receipts_sealed_insert',
  'application_import_receipts_sealed_update',
] as const);
const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  'applications',
  'applications_created_at_ms_idx',
  'applications_immutable_update',
  'application_import_receipts',
  'application_import_receipts_sealed_delete',
  'application_import_receipts_sealed_insert',
  'application_import_receipts_sealed_update',
] as const);
const EXPECTED_SCHEMA_OBJECT_NAMES = Object.freeze(
  [
    ...REQUIRED_SCHEMA_OBJECTS,
    SQLITE_MIGRATION_LEDGER_TABLE,
    'sqlite_autoindex_application_import_receipts_1',
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

const IMPORTED_APPLICATION_INSERT_SQL = `INSERT INTO ${APPLICATIONS_TABLE} (
  intake_sequence, ${APPLICATION_VALUE_COLUMNS_SQL}
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const APPLICATION_APPEND_SQL = `INSERT INTO ${APPLICATIONS_TABLE} (
  ${APPLICATION_VALUE_COLUMNS_SQL}
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING
RETURNING ${APPLICATION_ROW_COLUMNS_SQL}`;

const APPLICATION_ID_COLLISION = Object.freeze({ kind: 'application_id_collision' });

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

// Application records are append-only. Retention may delete expired rows later, but no submitted
// or imported record may be rewritten in place after its canonical bytes have been recorded.
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

export function migrateApplicationSchemaWithLegacyReceipt(
  database: SyncSqliteDatabase,
  expectedReceipt: ApplicationImportReceipt,
  now: () => string = () => new Date().toISOString(),
): void {
  const result = applySqliteMigrationsAtomically(database, HANDMARK_APPLICATION_MIGRATIONS, {
    captureState(transaction) {
      const receipt = readMigrationSafeLegacyApplicationImportReceipt(transaction);
      if (!receipt) {
        throw new Error('Handmark legacy application import receipt is missing before migration.');
      }
      assertSameApplicationImportReceipt(receipt, expectedReceipt);
      return receipt;
    },
    fingerprint: sha256Hex,
    now,
    verifyFinalState(transaction, receipt) {
      verifyApplicationSchema(transaction);
      const migratedReceipt = readVerifiedLegacyApplicationImportReceipt(transaction);
      if (!migratedReceipt) {
        throw new Error('Handmark legacy application import receipt is missing after migration.');
      }
      assertSameApplicationImportReceipt(migratedReceipt, receipt);
    },
  });
  if (result.currentVersion !== HANDMARK_APPLICATION_MIGRATIONS.length) {
    throw new Error('Handmark application schema did not reach its canonical migration version.');
  }
}

export function insertImportedApplication(
  database: SyncSqliteDatabase,
  record: ApplicationRecord,
  intakeSequence: number,
): void {
  if (!Number.isSafeInteger(intakeSequence) || intakeSequence < 1) {
    throw new Error('Imported application intake sequence must be a positive safe integer.');
  }
  const result = database.run(IMPORTED_APPLICATION_INSERT_SQL, [
    intakeSequence,
    ...applicationRecordSqlValues(record),
  ]);
  if (result.changes !== 1) {
    throw new Error('Imported application was not inserted exactly once.');
  }
}

/**
 * Append one canonical runtime record. An undefined result means only that its id already exists;
 * every other constraint or storage failure still throws.
 */
export function appendApplication(
  database: SyncSqliteDatabase,
  record: ApplicationRecord,
): number | undefined {
  const canonicalRecord = parseHistoricalApplicationRecord(
    canonicalApplicationRecordBytes(record).toString('utf8'),
  );
  try {
    return withImmediateTransaction(database, () => {
      const row = database.get<ApplicationRow>(
        APPLICATION_APPEND_SQL,
        applicationRecordSqlValues(canonicalRecord),
      );
      // ON CONFLICT advances sqlite_sequence unless the whole transaction rolls back. A private
      // identity sentinel keeps the driver-specific collision detail out of runtime code while
      // preserving a gap-free sequence for an ID retry.
      if (!row) throw APPLICATION_ID_COLLISION;
      const intakeSequence = safeInteger(row.intake_sequence, 'Application intake sequence');
      if (intakeSequence < 1) {
        throw new Error('Application intake sequence must be a positive safe integer.');
      }
      assertApplicationRow(row, canonicalRecord, intakeSequence);
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

export function insertApplicationImportReceipt(
  database: SyncSqliteDatabase,
  receipt: ApplicationImportReceipt,
): void {
  const result = database.run(
    `INSERT INTO ${IMPORT_RECEIPTS_TABLE} (
       receipt_key, format_version, source_bytes, source_sha256, record_count,
       ordered_records_sha256
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      APPLICATION_IMPORT_RECEIPT_KEY,
      receipt.formatVersion,
      receipt.sourceBytes,
      receipt.sourceSha256,
      receipt.recordCount,
      receipt.orderedRecordsSha256,
    ],
  );
  if (result.changes !== 1) {
    throw new Error('The application import receipt was not inserted exactly once.');
  }
}

/**
 * Read-only cutover proof. Undefined means the canonical schema exists but its one sealed legacy
 * import receipt does not; malformed, noncanonical, or ambiguous database state throws.
 */
export function readVerifiedLegacyApplicationImportReceipt(
  database: SyncSqliteDatabase,
): ApplicationImportReceipt | undefined {
  verifyApplicationSchema(database);
  return readStoredLegacyApplicationImportReceipt(database);
}

/**
 * Verify only the immutable cutover foundation needed before pending migrations can run. The
 * applied ledger must be an exact prefix of the code's migration list, while the receipt table and
 * all three sealing triggers remain byte-for-byte schema invariants.
 */
export function readMigrationSafeLegacyApplicationImportReceipt(
  database: ReadonlySyncSqliteDatabase,
  migrations: readonly SqliteMigration[] = HANDMARK_APPLICATION_MIGRATIONS,
): ApplicationImportReceipt | undefined {
  if (verifyApplicationMigrationLedger(database, migrations, false) === 0) {
    throw new Error('Handmark receipt foundation has no canonical migration ledger entry.');
  }
  const schemaRows = database.all<SchemaRow>(
    `SELECT type, name, sql
     FROM sqlite_schema
     WHERE name IN (${RECEIPT_SCHEMA_OBJECTS.map(() => '?').join(', ')})
     ORDER BY name`,
    RECEIPT_SCHEMA_OBJECTS,
  );
  const schema = new Map(schemaRows.map((row) => [row.name, row]));
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
  return readStoredLegacyApplicationImportReceipt(database);
}

function readStoredLegacyApplicationImportReceipt(
  database: ReadonlySyncSqliteDatabase,
): ApplicationImportReceipt | undefined {
  const rows = database.all<ReceiptRow>(
    `SELECT
       receipt_key, format_version, source_bytes, source_sha256, record_count,
       ordered_records_sha256
     FROM ${IMPORT_RECEIPTS_TABLE}
     ORDER BY receipt_key`,
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error('Handmark database has an ambiguous legacy application import receipt.');
  }
  const receipt = rows[0];
  if (!receipt) throw new Error('Handmark legacy application import receipt is missing.');
  assertStoredReceiptShape(receipt);
  return Object.freeze({
    formatVersion: safeInteger(receipt.format_version, 'Receipt format version'),
    orderedRecordsSha256: receipt.ordered_records_sha256,
    recordCount: safeInteger(receipt.record_count, 'Receipt record count'),
    sourceBytes: safeInteger(receipt.source_bytes, 'Receipt source bytes'),
    sourceSha256: receipt.source_sha256,
  });
}

export function hasVerifiedLegacyApplicationImportReceipt(database: SyncSqliteDatabase): boolean {
  return readVerifiedLegacyApplicationImportReceipt(database) !== undefined;
}

export function verifyImportedApplicationDatabase(
  database: SyncSqliteDatabase,
  receipt: ApplicationImportReceipt,
  records: readonly ApplicationRecord[],
): void {
  verifyApplicationSchema(database);
  verifySqliteIntegrity(database);

  const receiptRows = database.all<ReceiptRow>(
    `SELECT
       receipt_key, format_version, source_bytes, source_sha256, record_count,
       ordered_records_sha256
     FROM ${IMPORT_RECEIPTS_TABLE}
     ORDER BY receipt_key`,
  );
  if (receiptRows.length !== 1) {
    throw new Error('Handmark application import must contain exactly one receipt.');
  }
  const storedReceipt = receiptRows[0];
  if (!storedReceipt) throw new Error('Handmark application import receipt is missing.');
  assertReceipt(storedReceipt, receipt);

  const rows = database.all<ApplicationRow>(
    `SELECT ${APPLICATION_ROW_COLUMNS_SQL}
     FROM ${APPLICATIONS_TABLE}
     ORDER BY intake_sequence`,
  );
  if (rows.length !== records.length) {
    throw new Error(
      `Imported application count mismatch: expected ${records.length}, received ${rows.length}.`,
    );
  }

  for (const [index, expected] of records.entries()) {
    const row = rows[index];
    if (!row) throw new Error(`Imported application row ${index + 1} is missing.`);
    assertApplicationRow(row, expected, index + 1);
  }

  const sequence = database.get<SequenceRow>(
    "SELECT seq FROM sqlite_sequence WHERE name = 'applications'",
  );
  if (records.length === 0) {
    if (sequence !== undefined) {
      throw new Error('An empty application import unexpectedly advanced its intake sequence.');
    }
  } else if (safeInteger(sequence?.seq, 'Application intake sequence') !== records.length) {
    throw new Error('Application intake sequence does not match the imported physical order.');
  }
}

export function verifyApplicationSchema(database: SyncSqliteDatabase): void {
  verifyApplicationMigrationLedger(database, HANDMARK_APPLICATION_MIGRATIONS, true);

  const schemaNames = database
    .all<SchemaNameRow>('SELECT name FROM sqlite_schema ORDER BY name')
    .map((row) => row.name);
  if (
    schemaNames.length !== EXPECTED_SCHEMA_OBJECT_NAMES.length ||
    schemaNames.some((name, index) => name !== EXPECTED_SCHEMA_OBJECT_NAMES[index])
  ) {
    throw new Error('Handmark database contains an unexpected or missing schema object.');
  }

  const schemaRows = database.all<SchemaRow>(
    `SELECT type, name, sql
     FROM sqlite_schema
     WHERE name IN (${REQUIRED_SCHEMA_OBJECTS.map(() => '?').join(', ')})
     ORDER BY name`,
    REQUIRED_SCHEMA_OBJECTS,
  );
  const schema = new Map(schemaRows.map((row) => [row.name, row]));
  assertSchemaObject(schema, 'applications', 'table', APPLICATIONS_TABLE_SQL);
  assertSchemaObject(
    schema,
    'applications_created_at_ms_idx',
    'index',
    APPLICATIONS_CREATED_AT_INDEX_SQL,
  );
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
  assertSchemaObject(
    schema,
    'applications_immutable_update',
    'trigger',
    APPLICATION_IMMUTABLE_UPDATE_TRIGGER_SQL,
  );
}

function verifyApplicationMigrationLedger(
  database: ReadonlySyncSqliteDatabase,
  migrations: readonly SqliteMigration[],
  requireCurrent: boolean,
): number {
  const ledger = database.all<MigrationLedgerRow>(
    `SELECT version, name, fingerprint, applied_at
     FROM ${SQLITE_MIGRATION_LEDGER_TABLE}
     ORDER BY version`,
  );
  if (
    ledger.length > migrations.length ||
    (requireCurrent && ledger.length !== migrations.length)
  ) {
    throw new Error('Handmark canonical SQLite migration ledger has an unexpected length.');
  }
  for (const [index, row] of ledger.entries()) {
    const migration = migrations[index];
    if (!migration) {
      throw new Error(`Handmark migration ledger row ${index + 1} has no source definition.`);
    }
    const expectedFingerprint = migrationFingerprint(migration);
    if (
      safeInteger(row.version, 'Migration version') !== migration.version ||
      row.name !== migration.name ||
      row.fingerprint !== expectedFingerprint ||
      typeof row.applied_at !== 'string' ||
      !isCanonicalTimestamp(row.applied_at)
    ) {
      throw new Error(`Handmark migration ledger row ${migration.version} does not match source.`);
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

interface ReceiptRow extends SqliteRow {
  readonly receipt_key: string;
  readonly format_version: number | bigint;
  readonly source_bytes: number | bigint;
  readonly source_sha256: string;
  readonly record_count: number | bigint;
  readonly ordered_records_sha256: string;
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

interface SequenceRow extends SqliteRow {
  readonly seq: number | bigint;
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

function assertReceipt(row: ReceiptRow, expected: ApplicationImportReceipt): void {
  assertStoredReceiptShape(row);
  if (
    row.receipt_key !== APPLICATION_IMPORT_RECEIPT_KEY ||
    safeInteger(row.format_version, 'Receipt format version') !== expected.formatVersion ||
    safeInteger(row.source_bytes, 'Receipt source bytes') !== expected.sourceBytes ||
    row.source_sha256 !== expected.sourceSha256 ||
    safeInteger(row.record_count, 'Receipt record count') !== expected.recordCount ||
    row.ordered_records_sha256 !== expected.orderedRecordsSha256
  ) {
    throw new Error('Handmark application import receipt does not match its source.');
  }
}

function assertSameApplicationImportReceipt(
  actual: ApplicationImportReceipt,
  expected: ApplicationImportReceipt,
): void {
  if (
    actual.formatVersion !== expected.formatVersion ||
    actual.sourceBytes !== expected.sourceBytes ||
    actual.sourceSha256 !== expected.sourceSha256 ||
    actual.recordCount !== expected.recordCount ||
    actual.orderedRecordsSha256 !== expected.orderedRecordsSha256
  ) {
    throw new Error('Handmark application import receipt changed during schema migration.');
  }
}

function assertStoredReceiptShape(row: ReceiptRow): void {
  if (
    row.receipt_key !== APPLICATION_IMPORT_RECEIPT_KEY ||
    safeInteger(row.format_version, 'Receipt format version') !==
      APPLICATION_IMPORT_FORMAT_VERSION ||
    safeInteger(row.source_bytes, 'Receipt source bytes') < 0 ||
    typeof row.source_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.source_sha256) ||
    safeInteger(row.record_count, 'Receipt record count') < 0 ||
    typeof row.ordered_records_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.ordered_records_sha256)
  ) {
    throw new Error('Handmark legacy application import receipt is invalid.');
  }
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

  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(storedBytes);
  const authoritative = parseHistoricalApplicationRecord(decoded);
  for (const field of APPLICATION_RECORD_FIELDS) {
    if (authoritative[field] !== expected[field]) {
      throw new Error(`Application authoritative field ${field} does not match.`);
    }
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

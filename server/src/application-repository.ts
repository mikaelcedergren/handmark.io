import {
  openOwnedSqliteDatabase,
  type OwnedSqliteDatabase,
  type OwnedSqliteOpenCheckpoint,
  type SqliteRow,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';

import {
  APPLICATION_DATABASE_JOURNAL_MAX_BYTES,
  APPLICATION_DATABASE_MAX_BYTES,
  APPLICATION_MAX_CANONICAL_BYTES,
  APPLICATION_MAX_RECORDS,
  APPLICATION_RETENTION_MS,
} from './constants.js';
import { canonicalApplicationRecordBytes, type ApplicationRecord } from './application-record.js';
import {
  appendApplication,
  deleteApplicationsAtOrBefore,
  HANDMARK_APPLICATION_MIGRATIONS,
  migrateApplicationSchema,
  verifyApplicationDatabaseBeforeWrite,
  verifyApplicationSchema,
} from './application-schema.js';

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface CapacityRow extends SqliteRow {
  readonly canonical_bytes: number | bigint;
  readonly records: number | bigint;
}

interface HealthRow extends SqliteRow {
  readonly application_count: number | bigint;
  readonly schema_version: number | bigint;
}

interface RetentionRow extends SqliteRow {
  readonly earliest_created_at_ms: number | bigint | null;
}

interface MaintenanceTimer {
  unref(): unknown;
}

export type ApplicationRepositoryOpenCheckpoint = OwnedSqliteOpenCheckpoint;

export interface OpenApplicationRepositoryOptions {
  readonly cancelTimer?: (timer: MaintenanceTimer) => void;
  readonly clock?: () => number;
  readonly databasePath: string;
  readonly onOpenCheckpoint?: (checkpoint: ApplicationRepositoryOpenCheckpoint) => void;
  readonly onMaintenanceError?: (error: unknown) => void;
  readonly operationalRoot: string;
  readonly requireExisting?: boolean;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => MaintenanceTimer;
}

export interface ApplicationRepository {
  append(record: ApplicationRecord, acceptedAt: number): number | undefined;
  close(): void;
  isReady(): boolean;
  pruneExpired(now: number): number;
  startMaintenance(): void;
  stopMaintenance(): void;
}

export class ApplicationStorageCapacityError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'ApplicationStorageCapacityError';
  }
}

export class ApplicationStorageError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'ApplicationStorageError';
  }
}

export function openApplicationRepository({
  cancelTimer = (timer) => clearTimeout(timer as NodeJS.Timeout),
  clock = Date.now,
  databasePath,
  onOpenCheckpoint = () => undefined,
  onMaintenanceError = (error) => console.error('[handmark] application retention failed', error),
  operationalRoot,
  requireExisting = false,
  scheduleTimer = (callback, delayMs) => setTimeout(callback, delayMs),
}: OpenApplicationRepositoryOptions): ApplicationRepository {
  if (
    typeof clock !== 'function' ||
    typeof onMaintenanceError !== 'function' ||
    typeof onOpenCheckpoint !== 'function'
  ) {
    throw new Error('Application repository callbacks must be functions.');
  }
  let owned: OwnedSqliteDatabase;
  const storageOptions = {
    configuration: {
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      journalMode: 'wal',
    },
    databasePath,
    operationalRoot,
    onOpenCheckpoint,
  } as const;
  owned = requireExisting
    ? openOwnedSqliteDatabase({
        ...storageOptions,
        beforeWrite: verifyApplicationDatabaseBeforeWrite,
        requireExisting: true,
      })
    : openOwnedSqliteDatabase(storageOptions);
  const database = owned.database;
  let closed = false;
  let maintenanceStarted = false;
  let maintenanceTimer: MaintenanceTimer | undefined;
  try {
    migrateApplicationSchema(database);
    configureDatabaseStorage(database);
    owned.verifyStorage();
    verifyApplicationSchema(database);
  } catch (error) {
    try {
      owned.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Application repository opening failed and SQLite could not be closed.',
      );
    }
    throw error;
  }

  function requireOpen(): void {
    if (closed) throw new ApplicationStorageError('Application database is closed.');
  }

  return Object.freeze({
    append(record: ApplicationRecord, acceptedAt: number) {
      requireOpen();
      assertEpochMilliseconds(acceptedAt, 'Application acceptance time');
      try {
        owned.verifyStorage();
        const cutoff = retentionCutoff(acceptedAt);
        if (cutoff !== undefined) deleteApplicationsAtOrBefore(database, cutoff);
        enforceLogicalCapacity(database, canonicalApplicationRecordBytes(record).byteLength + 1);
        const sequence = appendApplication(database, record);
        owned.verifyStorage();
        scheduleMaintenanceIfStarted();
        return sequence;
      } catch (error) {
        if (error instanceof ApplicationStorageCapacityError) throw error;
        if (isSqliteFull(error)) {
          throw new ApplicationStorageCapacityError('Application database is full.', {
            cause: error,
          });
        }
        throw new ApplicationStorageError('Application database rejected a write.', {
          cause: error,
        });
      }
    },
    close() {
      if (closed) return;
      maintenanceStarted = false;
      closed = true;
      const closeErrors: unknown[] = [];
      try {
        clearMaintenanceTimer();
      } catch (error) {
        closeErrors.push(error);
      }
      try {
        owned.close();
      } catch (error) {
        closeErrors.push(error);
      }
      if (closeErrors.length === 1) {
        throw closeErrors[0];
      }
      if (closeErrors.length > 1) {
        throw new AggregateError(
          closeErrors,
          'Application repository encountered multiple errors while closing.',
        );
      }
    },
    isReady() {
      if (closed) return false;
      try {
        owned.verifyStorage();
        verifyApplicationSchema(database);
        const row = database.get<HealthRow>(
          `SELECT
             (SELECT MAX(version) FROM cx_schema_migrations) AS schema_version,
             COUNT(*) AS application_count
           FROM applications`,
        );
        const ready =
          safeInteger(row?.schema_version) ===
            (HANDMARK_APPLICATION_MIGRATIONS.at(-1)?.version ?? 0) &&
          safeInteger(row?.application_count) !== undefined;
        owned.verifyStorage();
        return ready;
      } catch {
        return false;
      }
    },
    pruneExpired(now: number) {
      requireOpen();
      assertEpochMilliseconds(now, 'Application retention time');
      try {
        owned.verifyStorage();
        const cutoff = retentionCutoff(now);
        const removed = cutoff === undefined ? 0 : deleteApplicationsAtOrBefore(database, cutoff);
        owned.verifyStorage();
        scheduleMaintenanceIfStarted();
        return removed;
      } catch (error) {
        throw new ApplicationStorageError('Application retention failed.', { cause: error });
      }
    },
    startMaintenance() {
      requireOpen();
      if (maintenanceStarted) return;
      maintenanceStarted = true;
      scheduleMaintenanceIfStarted();
    },
    stopMaintenance() {
      maintenanceStarted = false;
      clearMaintenanceTimer();
    },
  });

  function scheduleMaintenanceIfStarted(): void {
    if (!maintenanceStarted) return;
    try {
      scheduleMaintenance();
    } catch (error) {
      try {
        onMaintenanceError(error);
      } catch {
        // Maintenance reporting must not turn an already committed intake into a false failure.
      }
      scheduleMaintenanceRetry();
    }
  }

  function scheduleMaintenance(): void {
    clearMaintenanceTimer();
    if (!maintenanceStarted || closed) return;
    owned.verifyStorage();
    const timestamp = maintenanceClock();
    const nextExpiry = nextRetentionAt(database);
    if (nextExpiry === undefined) return;
    const delay = Math.max(1, Math.min(2_147_483_647, nextExpiry - timestamp));
    maintenanceTimer = scheduleTimer(runMaintenance, delay);
    maintenanceTimer.unref();
  }

  function runMaintenance(): void {
    maintenanceTimer = undefined;
    if (!maintenanceStarted || closed) return;
    try {
      owned.verifyStorage();
      const cutoff = retentionCutoff(maintenanceClock());
      if (cutoff !== undefined) deleteApplicationsAtOrBefore(database, cutoff);
      owned.verifyStorage();
      scheduleMaintenance();
    } catch (error) {
      try {
        onMaintenanceError(error);
      } catch {
        // Retention stays retryable even if the reporting sink itself is unavailable.
      }
      scheduleMaintenanceRetry();
    }
  }

  function scheduleMaintenanceRetry(): void {
    if (!maintenanceStarted || closed || maintenanceTimer) return;
    try {
      maintenanceTimer = scheduleTimer(runMaintenance, 60_000);
      maintenanceTimer.unref();
    } catch (error) {
      try {
        onMaintenanceError(error);
      } catch {
        // There is no timer to cancel and the failure has already been surfaced as far as possible.
      }
    }
  }

  function clearMaintenanceTimer(): void {
    if (!maintenanceTimer) return;
    const timer = maintenanceTimer;
    maintenanceTimer = undefined;
    cancelTimer(timer);
  }

  function maintenanceClock(): number {
    const timestamp = clock();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error('Application maintenance clock must return non-negative epoch milliseconds.');
    }
    return timestamp;
  }
}

function configureDatabaseStorage(database: SyncSqliteDatabase): void {
  const pageSize = pragmaInteger(database, 'page_size');
  const maximumPages = Math.floor(APPLICATION_DATABASE_MAX_BYTES / pageSize);
  const appliedMaximum = pragmaInteger(database, `max_page_count = ${String(maximumPages)}`);
  const pageCount = pragmaInteger(database, 'page_count');
  if (appliedMaximum > maximumPages || pageCount > maximumPages) {
    throw new Error('Application database exceeds its physical storage ceiling.');
  }
  pragmaInteger(database, `journal_size_limit = ${String(APPLICATION_DATABASE_JOURNAL_MAX_BYTES)}`);
  const checkpointPages = Math.max(
    1,
    Math.min(1_000, Math.floor(APPLICATION_DATABASE_JOURNAL_MAX_BYTES / pageSize)),
  );
  pragmaInteger(database, `wal_autocheckpoint = ${String(checkpointPages)}`);
}

function enforceLogicalCapacity(database: SyncSqliteDatabase, candidateBytes: number): void {
  if (!Number.isSafeInteger(candidateBytes) || candidateBytes < 1) {
    throw new ApplicationStorageError('Application canonical size is invalid.');
  }
  const row = database.get<CapacityRow>(
    `SELECT
       COUNT(*) AS records,
       COALESCE(SUM(length(record_json) + 1), 0) AS canonical_bytes
     FROM applications`,
  );
  const records = safeInteger(row?.records);
  const bytes = safeInteger(row?.canonical_bytes);
  if (records === undefined || bytes === undefined) {
    throw new ApplicationStorageError('Application capacity could not be read.');
  }
  if (records + 1 > APPLICATION_MAX_RECORDS) {
    throw new ApplicationStorageCapacityError(
      `Application storage would exceed ${String(APPLICATION_MAX_RECORDS)} records.`,
    );
  }
  if (bytes + candidateBytes > APPLICATION_MAX_CANONICAL_BYTES) {
    throw new ApplicationStorageCapacityError(
      `Application storage would exceed ${String(APPLICATION_MAX_CANONICAL_BYTES)} canonical bytes.`,
    );
  }
}

function retentionCutoff(now: number): number | undefined {
  const cutoff = now - APPLICATION_RETENTION_MS;
  return cutoff < 0 ? undefined : cutoff;
}

function nextRetentionAt(database: SyncSqliteDatabase): number | undefined {
  const row = database.get<RetentionRow>(
    'SELECT MIN(created_at_ms) AS earliest_created_at_ms FROM applications',
  );
  if (row?.earliest_created_at_ms === null || row?.earliest_created_at_ms === undefined) {
    return undefined;
  }
  const createdAt = safeInteger(row.earliest_created_at_ms);
  if (createdAt === undefined || createdAt < 0) {
    throw new Error('Application retention timestamp is invalid.');
  }
  const expiry = createdAt + APPLICATION_RETENTION_MS;
  if (!Number.isSafeInteger(expiry)) throw new Error('Application retention timestamp overflowed.');
  return expiry;
}

function pragmaInteger(database: SyncSqliteDatabase, pragma: string): number {
  const row = database.get(`PRAGMA ${pragma}`);
  const value = row ? Object.values(row)[0] : undefined;
  const integer = safeInteger(value);
  if (integer === undefined) throw new Error(`SQLite PRAGMA ${pragma} did not return an integer.`);
  return integer;
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value === 'bigint') {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) && BigInt(normalized) === value
      ? normalized
      : undefined;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function assertEpochMilliseconds(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationStorageError(`${label} must be non-negative epoch milliseconds.`);
  }
}

function isSqliteFull(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { readonly errcode?: unknown; readonly errstr?: unknown };
  return candidate.errcode === 13 || candidate.errstr === 'database or disk is full';
}

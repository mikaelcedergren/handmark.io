import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  configureSqlite,
  createPreparedSyncSqliteAdapter,
  withImmediateTransaction,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';
import {
  ApplicationRecordParseError,
  orderedApplicationRecordHash,
  parseHistoricalApplicationRecord,
  type ApplicationRecord,
} from './application-record.js';
import {
  APPLICATION_IMPORT_FORMAT_VERSION,
  insertApplicationImportReceipt,
  insertImportedApplication,
  migrateApplicationSchema,
  verifyImportedApplicationDatabase,
  type ApplicationImportReceipt,
} from './application-schema.js';

// These aggregate values are fail-closed migration safety gates, not historical writer limits.
// Early writers were unbounded across the whole file. A stopped operational source beyond either
// value requires an explicit higher-bound migration design; the importer never splits or skips it.
export const APPLICATION_IMPORT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const APPLICATION_IMPORT_MAX_RECORDS = 10_000;
// Early writers accepted a 64 KiB JSON request whose array/object values could expand more than
// fivefold through String() before JSONL serialization. This fixed offline bound safely contains
// that complete writer union; today's runtime intake keeps its separate, stricter request limits.
export const APPLICATION_IMPORT_MAX_RECORD_BYTES = 512 * 1024;

export const APPLICATION_IMPORT_CHECKPOINTS = Object.freeze([
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
] as const);

type ApplicationImportCheckpoint = (typeof APPLICATION_IMPORT_CHECKPOINTS)[number];
type ApplicationImportCode =
  | 'blank_line'
  | 'cleanup_failed'
  | 'duplicate_id'
  | 'file_too_large'
  | 'import_failed'
  | 'invalid_json'
  | 'invalid_options'
  | 'invalid_record'
  | 'invalid_utf8'
  | 'record_too_large'
  | 'recovery_conflict'
  | 'source_changed'
  | 'source_invalid_type'
  | 'source_missing'
  | 'target_changed'
  | 'target_conflict'
  | 'target_invalid_type'
  | 'too_many_records';

interface ImportOptions {
  readonly sourcePath: string;
  readonly databasePath: string;
}

interface ImportTestOptions {
  readonly onCheckpoint: (
    checkpoint: ApplicationImportCheckpoint,
    details: ImportCheckpointDetails,
  ) => unknown;
}

interface ImportCheckpointDetails {
  readonly databasePath?: string;
  readonly intakeSequence?: number;
  readonly stagingDirectory?: string;
}

interface ResolvedImportOptions extends ImportOptions {
  readonly parentDescriptor: number;
  readonly parentPath: string;
  readonly parentSnapshot: FileSnapshot;
  readonly stagingDirectoryPath: string;
}

interface ValidatedSource {
  readonly fileDescriptor: number;
  readonly filePath: string;
  readonly receipt: ApplicationImportReceipt;
  readonly records: readonly ApplicationRecord[];
  readonly snapshot: FileSnapshot;
}

interface FileSnapshot {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly gid: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly uid: bigint;
}

interface ExistingTarget {
  readonly snapshot: FileSnapshot;
}

interface StableDatabaseProof {
  readonly dev: bigint;
  readonly digest: string;
  readonly gid: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
  readonly uid: bigint;
}

interface ImportStage {
  readonly databaseDescriptor: number;
  readonly databaseIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly databasePath: string;
  readonly directoryDescriptor: number;
  readonly directoryIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly directoryPath: string;
  markerIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }> | undefined;
  readonly markerPath: string;
  readonly role: StageRole;
}

interface StageMarker {
  readonly databaseDev: string;
  readonly databaseIno: string;
  readonly databaseSha256: string;
  readonly databaseSize: string;
  readonly directoryDev: string;
  readonly directoryIno: string;
  readonly formatVersion: 1;
  readonly kind: 'handmark_application_import';
  readonly ownerPid: string;
  readonly parentDev: string;
  readonly parentIno: string;
  readonly role: StageRole;
  readonly sourceCtimeNs: string;
  readonly sourceDev: string;
  readonly sourceGid: string;
  readonly sourceIno: string;
  readonly sourceMode: string;
  readonly sourceMtimeNs: string;
  readonly sourceReceipt: ApplicationImportReceipt;
  readonly sourceSize: string;
  readonly sourceUid: string;
  readonly targetName: string;
}

type StageRole = 'build' | 'replay';

type RecoveryState =
  | Readonly<{
      readonly kind: 'published' | 'replay';
      readonly proof: StableDatabaseProof;
      readonly stage: ImportStage;
    }>
  | Readonly<{
      readonly kind: 'unpublished';
      readonly proof: StableDatabaseProof;
      readonly stage: ImportStage;
    }>;

class ApplicationImportError extends Error {
  readonly code: ApplicationImportCode;
  readonly field: string | undefined;
  readonly line: number | undefined;

  constructor(
    code: ApplicationImportCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly field?: string;
      readonly line?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApplicationImportError';
    this.code = code;
    this.field = options.field;
    this.line = options.line;
  }
}

const NO_FOLLOW = requiredFsConstant(fs.constants.O_NOFOLLOW, 'O_NOFOLLOW');
const DIRECTORY_ONLY = requiredFsConstant(fs.constants.O_DIRECTORY, 'O_DIRECTORY');
const CURRENT_EFFECTIVE_UID = currentEffectiveUserId();
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const STAGE_DATABASE_NAME = 'database.sqlite';
const STAGE_MARKER_NAME = 'operation.json';
const STAGE_MARKER_MAX_BYTES = 4 * 1024;
const EMPTY_CHECKPOINT_DETAILS = Object.freeze({});

export async function importApplicationsJsonl(
  options: ImportOptions,
): Promise<ApplicationImportReceipt> {
  return runImport(options);
}

export async function importApplicationsJsonlForTest(
  options: ImportOptions,
  testOptions: ImportTestOptions,
): Promise<ApplicationImportReceipt> {
  if (
    !testOptions ||
    typeof testOptions !== 'object' ||
    Array.isArray(testOptions) ||
    Object.keys(testOptions).length !== 1 ||
    typeof testOptions.onCheckpoint !== 'function'
  ) {
    throw new ApplicationImportError(
      'invalid_options',
      'Application importer test options must contain only onCheckpoint.',
    );
  }
  return runImport(options, testOptions.onCheckpoint);
}

async function runImport(
  rawOptions: ImportOptions,
  onCheckpoint?: ImportTestOptions['onCheckpoint'],
): Promise<ApplicationImportReceipt> {
  let options: ResolvedImportOptions | undefined;
  let source: ValidatedSource | undefined;
  let stage: ImportStage | undefined;
  let stageCanBeCleaned = false;
  let publishedTarget: StableDatabaseProof | undefined;
  let result: ApplicationImportReceipt | undefined;
  let primaryError: unknown;

  const checkpoint = (
    name: ApplicationImportCheckpoint,
    details: ImportCheckpointDetails = EMPTY_CHECKPOINT_DETAILS,
  ): void => {
    if (!onCheckpoint) return;
    const result = onCheckpoint(name, details);
    if (isPromiseLike(result)) {
      throw new Error('Application import checkpoint hooks must be synchronous.');
    }
  };

  try {
    options = validateOptions(rawOptions);
    source = openAndValidateSource(options.sourcePath, checkpoint);
    assertParentStable(options, 'target_changed');

    const recovery = recoverInterruptedOperation(options, source);
    if (recovery) {
      stage = recovery.stage;
      stageCanBeCleaned = true;
      if (recovery.kind === 'unpublished') {
        checkpoint('before_publish', stageCheckpointDetails(stage));
        publishedTarget = linkStageToTarget(options, stage, recovery.proof);
        syncParentDirectory(options);
        checkpoint('target_linked', stageCheckpointDetails(stage));
        finalizePublishedTarget(options, stage, publishedTarget, source, checkpoint, false);
        stage = undefined;
        result = source.receipt;
      } else if (recovery.kind === 'published') {
        publishedTarget = recovery.proof;
        finalizePublishedTarget(options, stage, publishedTarget, source, checkpoint, false);
        stage = undefined;
        result = source.receipt;
      } else {
        finalizeExactReplay(options, stage, recovery.proof, source);
        stage = undefined;
        result = source.receipt;
      }
    }

    if (result) {
      // Recovery already completed the exact operation.
    } else {
      const target = inspectExistingTarget(options.databasePath);
      if (target) {
        assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
        stage = createReplayStage(options, source, target);
        stageCanBeCleaned = true;
        checkpoint('replay_pinned', stageCheckpointDetails(stage));
        const replayProof = verifyExactReplay(options, stage, target, source);
        sealStageMarker(options, stage, source, replayProof);
        finalizeExactReplay(options, stage, replayProof, source);
        stage = undefined;
        result = source.receipt;
      } else {
        assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
        stage = createNewStage(options);
        stageCanBeCleaned = true;
        checkpoint('temporary_created', stageCheckpointDetails(stage));
        assertParentStable(options, 'target_changed');
        assertStageReadyForOpen(options, stage, 1n);

        buildImportedDatabase(options, stage, source, checkpoint);
        syncStageDatabase(options, stage, 1n);
        const proof = verifyStageDatabase(options, stage, source, 1n);
        checkpoint('target_reopened', stageCheckpointDetails(stage));
        sealStageMarker(options, stage, source, proof);
        checkpoint('marker_durable', stageCheckpointDetails(stage));
        assertSourceUnchanged(source);
        assertTargetSidecarsAbsent(options.databasePath, 'target_changed');

        checkpoint('before_publish', stageCheckpointDetails(stage));
        assertSourceUnchanged(source);
        assertParentStable(options, 'target_changed');
        assertTargetAbsent(options.databasePath);
        assertTargetSidecarsAbsent(options.databasePath, 'target_changed');

        publishedTarget = linkStageToTarget(options, stage, proof);
        syncParentDirectory(options);
        checkpoint('target_linked', stageCheckpointDetails(stage));
        finalizePublishedTarget(options, stage, publishedTarget, source, checkpoint, true);
        stage = undefined;
        result = source.receipt;
      }
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: ApplicationImportError[] = [];
  if (primaryError !== undefined && publishedTarget && options) {
    captureCleanupError(cleanupErrors, 'published target rollback', () => {
      rollbackPublishedTarget(options, publishedTarget);
    });
  }
  if (stage && stageCanBeCleaned && options) {
    captureCleanupError(cleanupErrors, 'staging cleanup', () => cleanupStage(options, stage));
  }
  if (source) {
    captureCleanupError(cleanupErrors, 'source descriptor close', () =>
      closeFileDescriptor(source.fileDescriptor),
    );
  }
  if (options) {
    captureCleanupError(cleanupErrors, 'parent descriptor close', () =>
      closeFileDescriptor(options.parentDescriptor),
    );
  }

  if (primaryError !== undefined || cleanupErrors.length > 0) {
    throwCombinedImportFailure(primaryError, cleanupErrors);
  }
  if (!result)
    throw new ApplicationImportError('import_failed', 'Application import produced no result.');
  return result;
}

function validateOptions(options: ImportOptions): ResolvedImportOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ApplicationImportError('invalid_options', 'Application import options are required.');
  }
  if (
    typeof options.sourcePath !== 'string' ||
    options.sourcePath.length === 0 ||
    typeof options.databasePath !== 'string' ||
    options.databasePath.length === 0
  ) {
    throw new ApplicationImportError(
      'invalid_options',
      'Application import paths must be non-empty strings.',
    );
  }
  const sourcePath = path.resolve(options.sourcePath);
  const databasePath = path.resolve(options.databasePath);
  if (sourcePath === databasePath) {
    throw new ApplicationImportError(
      'invalid_options',
      'Application source and database paths must be different.',
    );
  }
  const databaseDirectory = path.dirname(databasePath);
  let directoryStats: fs.BigIntStats;
  try {
    directoryStats = fs.lstatSync(databaseDirectory, { bigint: true });
  } catch (error) {
    throw new ApplicationImportError(
      'invalid_options',
      'Application database directory must already exist.',
      { cause: error },
    );
  }
  if (!directoryStats.isDirectory()) {
    throw new ApplicationImportError(
      'invalid_options',
      'Application database parent must be a directory.',
    );
  }
  let parentDescriptor: number | undefined;
  try {
    parentDescriptor = fs.openSync(
      databaseDirectory,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const parentSnapshot = fileSnapshot(fs.fstatSync(parentDescriptor, { bigint: true }));
    if (!sameSnapshot(parentSnapshot, fileSnapshot(directoryStats))) {
      throw new Error('Application database parent changed while it was opened.');
    }
    return Object.freeze({
      databasePath,
      parentDescriptor,
      parentPath: databaseDirectory,
      parentSnapshot,
      sourcePath,
      stagingDirectoryPath: path.join(
        databaseDirectory,
        `.${path.basename(databasePath)}.import-stage`,
      ),
    });
  } catch (error) {
    if (parentDescriptor !== undefined) closeFileDescriptor(parentDescriptor);
    throw new ApplicationImportError(
      'invalid_options',
      'Application database parent could not be pinned safely.',
      { cause: error },
    );
  }
}

function openAndValidateSource(
  sourcePath: string,
  checkpoint: (name: ApplicationImportCheckpoint) => void,
): ValidatedSource {
  let pathStats: fs.BigIntStats;
  try {
    pathStats = fs.lstatSync(sourcePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new ApplicationImportError('source_missing', 'Application JSONL source is missing.');
    }
    throw new ApplicationImportError(
      'import_failed',
      'Application source could not be inspected.',
      {
        cause: error,
      },
    );
  }
  if (!pathStats.isFile() || pathStats.nlink !== 1n) {
    throw new ApplicationImportError(
      'source_invalid_type',
      'Application JSONL source must be a single-link regular file.',
    );
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    throw new ApplicationImportError(
      'source_changed',
      'Application JSONL source changed while it was being opened.',
      { cause: error },
    );
  }

  try {
    const snapshot = fileSnapshot(fs.fstatSync(fileDescriptor, { bigint: true }));
    if (!sameSnapshot(snapshot, fileSnapshot(pathStats)) || snapshot.nlink !== 1n) {
      throw new ApplicationImportError(
        'source_changed',
        'Application JSONL source changed while it was being opened.',
      );
    }
    checkpoint('source_opened');
    if (snapshot.size > BigInt(APPLICATION_IMPORT_MAX_SOURCE_BYTES)) {
      throw new ApplicationImportError(
        'file_too_large',
        `Application JSONL source exceeds ${APPLICATION_IMPORT_MAX_SOURCE_BYTES} bytes.`,
      );
    }

    const bytes = readExactFile(fileDescriptor, Number(snapshot.size), 'source_changed');
    if (!sameSnapshot(snapshot, fileSnapshot(fs.fstatSync(fileDescriptor, { bigint: true })))) {
      throw new ApplicationImportError(
        'source_changed',
        'Application JSONL source changed while it was being read.',
      );
    }
    const records = parseSourceRecords(bytes);
    const receipt = Object.freeze({
      formatVersion: APPLICATION_IMPORT_FORMAT_VERSION,
      orderedRecordsSha256: orderedApplicationRecordHash(records),
      recordCount: records.length,
      sourceBytes: bytes.byteLength,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const source = Object.freeze({
      fileDescriptor,
      filePath: sourcePath,
      receipt,
      records,
      snapshot,
    });
    assertSourceUnchanged(source);
    checkpoint('source_validated');
    assertSourceUnchanged(source);
    return source;
  } catch (error) {
    closeFileDescriptor(fileDescriptor);
    throw error;
  }
}

function parseSourceRecords(bytes: Buffer): readonly ApplicationRecord[] {
  const records: ApplicationRecord[] = [];
  const ids = new Set<string>();
  let lineStart = 0;
  let lineNumber = 1;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    let lineEnd = index;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd -= 1;
    parseSourceLine(bytes.subarray(lineStart, lineEnd), lineNumber, records, ids);
    lineStart = index + 1;
    lineNumber += 1;
  }
  if (lineStart < bytes.length) {
    parseSourceLine(bytes.subarray(lineStart), lineNumber, records, ids);
  }
  return Object.freeze(records);
}

function parseSourceLine(
  lineBytes: Buffer,
  line: number,
  records: ApplicationRecord[],
  ids: Set<string>,
): void {
  if (lineBytes.byteLength === 0) {
    throw new ApplicationImportError('blank_line', 'Application JSONL contains a blank line.', {
      line,
    });
  }
  if (records.length >= APPLICATION_IMPORT_MAX_RECORDS) {
    throw new ApplicationImportError(
      'too_many_records',
      `Application JSONL exceeds ${APPLICATION_IMPORT_MAX_RECORDS} records.`,
      { line },
    );
  }
  if (lineBytes.byteLength > APPLICATION_IMPORT_MAX_RECORD_BYTES) {
    throw new ApplicationImportError(
      'record_too_large',
      `Application JSONL record exceeds ${APPLICATION_IMPORT_MAX_RECORD_BYTES} bytes.`,
      { line },
    );
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(lineBytes);
  } catch (error) {
    throw new ApplicationImportError('invalid_utf8', 'Application JSONL is not valid UTF-8.', {
      cause: error,
      line,
    });
  }

  let record: ApplicationRecord;
  try {
    record = parseHistoricalApplicationRecord(source);
  } catch (error) {
    if (error instanceof ApplicationRecordParseError) {
      throw new ApplicationImportError(error.code, error.message, {
        cause: error,
        ...(error.field === undefined ? {} : { field: error.field }),
        line,
      });
    }
    throw error;
  }
  if (ids.has(record.id)) {
    throw new ApplicationImportError(
      'duplicate_id',
      'Application JSONL contains a duplicate application id.',
      { field: 'id', line },
    );
  }
  ids.add(record.id);
  records.push(record);
}

function assertSourceUnchanged(source: ValidatedSource): void {
  let reopened: number | undefined;
  try {
    const descriptorSnapshot = fileSnapshot(fs.fstatSync(source.fileDescriptor, { bigint: true }));
    if (!sameSnapshot(descriptorSnapshot, source.snapshot)) throw new Error('descriptor changed');

    const pathSnapshot = fileSnapshot(fs.lstatSync(source.filePath, { bigint: true }));
    if (!sameSnapshot(pathSnapshot, source.snapshot) || pathSnapshot.nlink !== 1n) {
      throw new Error('path changed');
    }

    reopened = fs.openSync(source.filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const reopenedBefore = fileSnapshot(fs.fstatSync(reopened, { bigint: true }));
    if (!sameSnapshot(reopenedBefore, source.snapshot)) throw new Error('reopened source changed');
    const digest = hashFileDescriptor(reopened, Number(source.snapshot.size));
    const reopenedAfter = fileSnapshot(fs.fstatSync(reopened, { bigint: true }));
    if (!sameSnapshot(reopenedAfter, source.snapshot)) throw new Error('source changed while read');
    if (digest !== source.receipt.sourceSha256) throw new Error('source bytes changed');
    closeFileDescriptor(reopened);
    reopened = undefined;

    const finalPathSnapshot = fileSnapshot(fs.lstatSync(source.filePath, { bigint: true }));
    if (!sameSnapshot(finalPathSnapshot, source.snapshot)) throw new Error('source path changed');
  } catch (error) {
    if (reopened !== undefined) closeFileDescriptor(reopened);
    throw new ApplicationImportError(
      'source_changed',
      'Application JSONL source changed during import.',
      { cause: error },
    );
  }
}

function inspectExistingTarget(databasePath: string): ExistingTarget | undefined {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(databasePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new ApplicationImportError('import_failed', 'Database target could not be inspected.', {
      cause: error,
    });
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new ApplicationImportError(
      'target_invalid_type',
      'Application database target must be a single-link regular file.',
    );
  }
  const snapshot = fileSnapshot(stats);
  if (snapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApplicationImportError(
      'target_conflict',
      'Application database target exceeds the verifiable size range.',
    );
  }
  return Object.freeze({ snapshot });
}

function recoverInterruptedOperation(
  options: ResolvedImportOptions,
  source: ValidatedSource,
): RecoveryState | undefined {
  assertParentStable(options, 'recovery_conflict');
  let directoryStats: fs.BigIntStats;
  try {
    directoryStats = fs.lstatSync(options.stagingDirectoryPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw recoveryConflict('Interrupted import staging could not be inspected.', error);
  }
  if (!isPrivateOwnedDirectory(directoryStats)) {
    throw recoveryConflict('Interrupted import staging is not an owned private directory.');
  }

  let directoryDescriptor: number | undefined;
  let databaseDescriptor: number | undefined;
  try {
    directoryDescriptor = fs.openSync(
      options.stagingDirectoryPath,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const directorySnapshot = fileSnapshot(fs.fstatSync(directoryDescriptor, { bigint: true }));
    if (!sameDirectoryIdentity(directorySnapshot, fileSnapshot(directoryStats))) {
      throw new Error('Interrupted staging directory changed while being opened.');
    }
    const entries = fs.readdirSync(options.stagingDirectoryPath).toSorted();
    if (entries.length === 0) {
      throw new Error('Interrupted staging has no durable ownership marker.');
    }

    const markerPath = path.join(options.stagingDirectoryPath, STAGE_MARKER_NAME);
    if (!entries.includes(STAGE_MARKER_NAME)) {
      throw new Error('Interrupted staging has no durable operation marker.');
    }
    for (const entry of entries) {
      if (!stageEntryNames().has(entry)) {
        throw new Error('Interrupted staging contains an unknown entry.');
      }
    }
    if (stageSidecarPaths(options.stagingDirectoryPath).some(pathExists)) {
      throw new Error('Interrupted staging contains unresolved SQLite sidecars.');
    }

    const loadedMarker = readStageMarker(markerPath);
    const marker = loadedMarker.marker;
    assertMarkerMatchesOperation(marker, options, source, directorySnapshot);
    assertMarkerOwnerStopped(marker);

    const databasePath = path.join(options.stagingDirectoryPath, STAGE_DATABASE_NAME);
    const targetSnapshot = inspectRecoveryTarget(options.databasePath);
    const expectedIdentity = Object.freeze({
      dev: BigInt(marker.databaseDev),
      ino: BigInt(marker.databaseIno),
    });
    const databaseExists = pathExists(databasePath);

    if (databaseExists) {
      databaseDescriptor = fs.openSync(databasePath, fs.constants.O_RDONLY | NO_FOLLOW);
    } else {
      if (!targetSnapshot || !sameFileIdentity(targetSnapshot, expectedIdentity)) {
        throw new Error('Interrupted staging lost its verified database inode.');
      }
      databaseDescriptor = fs.openSync(options.databasePath, fs.constants.O_RDONLY | NO_FOLLOW);
      const openedTarget = fileSnapshot(fs.fstatSync(databaseDescriptor, { bigint: true }));
      if (!sameFileIdentity(openedTarget, expectedIdentity)) {
        throw new Error('Interrupted target changed before it could be repinned.');
      }
      assertTargetSidecarsAbsent(options.databasePath, 'recovery_conflict');
      fs.linkSync(options.databasePath, databasePath);
      fs.fsyncSync(directoryDescriptor);
      fs.fsyncSync(options.parentDescriptor);
    }

    const databaseSnapshot = fileSnapshot(fs.fstatSync(databaseDescriptor, { bigint: true }));
    if (
      !isPrivateOwnedFile(databaseSnapshot) ||
      !sameFileIdentity(databaseSnapshot, expectedIdentity)
    ) {
      throw new Error('Interrupted staging database identity is invalid.');
    }

    const stage: ImportStage = {
      databaseDescriptor,
      databaseIdentity: expectedIdentity,
      databasePath,
      directoryDescriptor,
      directoryIdentity: Object.freeze({
        dev: directorySnapshot.dev,
        ino: directorySnapshot.ino,
      }),
      directoryPath: options.stagingDirectoryPath,
      markerIdentity: loadedMarker.identity,
      markerPath,
      role: marker.role,
    };

    const stagedSnapshot = assertStageDatabaseIdentity(options, stage, targetSnapshot ? 2n : 1n);
    const durableProof = proofFromDescriptor(stage.databaseDescriptor);
    if (
      durableProof.digest !== marker.databaseSha256 ||
      durableProof.size.toString() !== marker.databaseSize
    ) {
      throw new Error('Interrupted staging database does not match its durable marker.');
    }

    if (!targetSnapshot) {
      if (marker.role !== 'build' || stagedSnapshot.nlink !== 1n) {
        throw new Error('Interrupted replay cannot be recovered without its public target.');
      }
      const proof = verifyStageDatabase(options, stage, source, 1n);
      assertProofEqual(proof, durableProof);
      databaseDescriptor = undefined;
      directoryDescriptor = undefined;
      return Object.freeze({ kind: 'unpublished', proof, stage });
    }

    if (
      !sameFileIdentity(targetSnapshot, expectedIdentity) ||
      targetSnapshot.nlink !== 2n ||
      stagedSnapshot.nlink !== 2n
    ) {
      throw new Error('Interrupted target and staging links are ambiguous.');
    }
    assertTargetSidecarsAbsent(options.databasePath, 'recovery_conflict');
    const proof = verifyStageDatabase(options, stage, source, 2n, 'recovery_conflict');
    assertProofEqual(proof, durableProof);
    assertTargetMatchesProof(options.databasePath, proof, 2n, 'recovery_conflict');
    databaseDescriptor = undefined;
    directoryDescriptor = undefined;
    return Object.freeze({
      kind: marker.role === 'build' ? 'published' : 'replay',
      proof,
      stage,
    });
  } catch (error) {
    if (databaseDescriptor !== undefined) closeFileDescriptor(databaseDescriptor);
    if (directoryDescriptor !== undefined) closeFileDescriptor(directoryDescriptor);
    if (error instanceof ApplicationImportError && error.code === 'recovery_conflict') throw error;
    throw recoveryConflict('Interrupted application import is ambiguous and was preserved.', error);
  }
}

function createNewStage(options: ResolvedImportOptions): ImportStage {
  const directory = createOwnedStageDirectory(options);
  const databasePath = path.join(directory.path, STAGE_DATABASE_NAME);
  let databaseDescriptor: number | undefined;
  let databaseIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }> | undefined;
  try {
    databaseDescriptor = fs.openSync(
      databasePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.fsyncSync(databaseDescriptor);
    const databaseSnapshot = fileSnapshot(fs.fstatSync(databaseDescriptor, { bigint: true }));
    if (!isPrivateOwnedFile(databaseSnapshot) || databaseSnapshot.nlink !== 1n) {
      throw new Error('New staging database is not a private single-link regular file.');
    }
    databaseIdentity = Object.freeze({ dev: databaseSnapshot.dev, ino: databaseSnapshot.ino });
    const pathSnapshot = inspectRegularFile(databasePath);
    if (!sameSnapshot(databaseSnapshot, pathSnapshot)) {
      throw new Error('New staging database changed while it was created.');
    }
    fs.fsyncSync(directory.descriptor);
    syncParentDirectory(options);
    return {
      databaseDescriptor,
      databaseIdentity,
      databasePath,
      directoryDescriptor: directory.descriptor,
      directoryIdentity: directory.identity,
      directoryPath: directory.path,
      markerIdentity: undefined,
      markerPath: path.join(directory.path, STAGE_MARKER_NAME),
      role: 'build',
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (databaseDescriptor !== undefined) {
      try {
        closeFileDescriptor(databaseDescriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      removeExactStageAlias(databasePath, databaseIdentity);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      removeOwnedEmptyStageDirectory(options, directory);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      closeFileDescriptor(directory.descriptor);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Staging creation and cleanup failed.');
    }
    throw error;
  }
}

function createReplayStage(
  options: ResolvedImportOptions,
  source: ValidatedSource,
  target: ExistingTarget,
): ImportStage {
  if (!isPrivateOwnedFile(target.snapshot)) {
    throw new ApplicationImportError(
      'target_conflict',
      'Existing application database is not a private owned target.',
    );
  }
  assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
  let targetDescriptor: number | undefined;
  let directory:
    | Readonly<{
        descriptor: number;
        identity: Readonly<{ dev: bigint; ino: bigint }>;
        path: string;
      }>
    | undefined;
  let linked = false;
  let targetIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }> | undefined;
  try {
    targetDescriptor = fs.openSync(options.databasePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fileSnapshot(fs.fstatSync(targetDescriptor, { bigint: true }));
    if (!sameSnapshot(opened, target.snapshot)) {
      throw new ApplicationImportError(
        'target_changed',
        'Existing application database changed before it could be pinned.',
      );
    }
    targetIdentity = Object.freeze({ dev: opened.dev, ino: opened.ino });
    directory = createOwnedStageDirectory(options);
    const databasePath = path.join(directory.path, STAGE_DATABASE_NAME);
    fs.linkSync(options.databasePath, databasePath);
    linked = true;
    fs.fsyncSync(directory.descriptor);
    fs.fsyncSync(options.parentDescriptor);
    const stage: ImportStage = {
      databaseDescriptor: targetDescriptor,
      databaseIdentity: targetIdentity,
      databasePath,
      directoryDescriptor: directory.descriptor,
      directoryIdentity: directory.identity,
      directoryPath: directory.path,
      markerIdentity: undefined,
      markerPath: path.join(directory.path, STAGE_MARKER_NAME),
      role: 'replay',
    };
    assertStageDatabaseIdentity(options, stage, 2n);
    assertTargetMatchesSnapshot(options.databasePath, target.snapshot, 2n, 'target_changed');
    assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
    targetDescriptor = undefined;
    directory = undefined;
    return stage;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (targetDescriptor !== undefined) {
      try {
        closeFileDescriptor(targetDescriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (directory) {
      const databasePath = path.join(directory.path, STAGE_DATABASE_NAME);
      if (linked) {
        try {
          removeExactStageAlias(databasePath, targetIdentity);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        removeOwnedEmptyStageDirectory(options, directory);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        closeFileDescriptor(directory.descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new ApplicationImportError(
        error instanceof ApplicationImportError ? error.code : 'target_conflict',
        'Existing target pinning failed and staging cleanup was incomplete.',
        { cause: new AggregateError([error, ...cleanupErrors]) },
      );
    }
    throw error;
  }
}

function createOwnedStageDirectory(options: ResolvedImportOptions): Readonly<{
  readonly descriptor: number;
  readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly path: string;
}> {
  assertParentStable(options, 'target_changed');
  try {
    fs.mkdirSync(options.stagingDirectoryPath, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw recoveryConflict('An application import staging operation already exists.', error);
    }
    throw error;
  }
  let descriptor: number | undefined;
  let identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }> | undefined;
  try {
    descriptor = fs.openSync(
      options.stagingDirectoryPath,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const descriptorSnapshot = fileSnapshot(fs.fstatSync(descriptor, { bigint: true }));
    const pathStats = fs.lstatSync(options.stagingDirectoryPath, { bigint: true });
    if (
      !isPrivateOwnedDirectory(pathStats) ||
      !sameDirectoryIdentity(descriptorSnapshot, fileSnapshot(pathStats))
    ) {
      throw new Error('Application import staging directory identity is invalid.');
    }
    identity = Object.freeze({ dev: descriptorSnapshot.dev, ino: descriptorSnapshot.ino });
    assertParentStable(options, 'target_changed');
    fs.fsyncSync(descriptor);
    fs.fsyncSync(options.parentDescriptor);
    return Object.freeze({
      descriptor,
      identity,
      path: options.stagingDirectoryPath,
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== undefined && identity) {
      try {
        removeOwnedEmptyStageDirectory(options, {
          descriptor,
          identity,
          path: options.stagingDirectoryPath,
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (descriptor !== undefined) {
      try {
        closeFileDescriptor(descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Staging directory creation and safe cleanup failed.',
      );
    }
    throw error;
  }
}

function removeOwnedEmptyStageDirectory(
  options: ResolvedImportOptions,
  directory: Readonly<{
    readonly descriptor: number;
    readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
    readonly path: string;
  }>,
): void {
  assertParentStable(options, 'cleanup_failed');
  const descriptorStats = fs.fstatSync(directory.descriptor, { bigint: true });
  const pathStats = fs.lstatSync(directory.path, { bigint: true });
  if (
    !isPrivateOwnedDirectory(descriptorStats) ||
    !isPrivateOwnedDirectory(pathStats) ||
    !sameFileIdentity(descriptorStats, directory.identity) ||
    !sameFileIdentity(pathStats, directory.identity)
  ) {
    throw new Error('Application staging directory is no longer safely removable.');
  }
  if (fs.readdirSync(directory.path).length !== 0) {
    throw new Error('Application staging directory is not empty after safe entry cleanup.');
  }
  fs.rmdirSync(directory.path);
  fs.fsyncSync(options.parentDescriptor);
}

function buildImportedDatabase(
  options: ResolvedImportOptions,
  stage: ImportStage,
  source: ValidatedSource,
  checkpoint: (
    name: ApplicationImportCheckpoint,
    details?: Readonly<{ readonly intakeSequence?: number }>,
  ) => void,
): void {
  assertStageReadyForOpen(options, stage, 1n);
  let native: DatabaseSync | undefined;
  let primaryError: unknown;
  const closeErrors: unknown[] = [];
  try {
    native = new DatabaseSync(stage.databasePath);
    // No PRAGMA or SQL may run until the pathname still proves the inode held by this operation.
    assertStageReadyForOpen(options, stage, 1n);
    native.enableDefensive(true);
    const database = createPreparedSyncSqliteAdapter(native);
    configureSqlite(database, {
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      journalMode: 'delete',
    });
    migrateApplicationSchema(database);
    withImmediateTransaction(database, () => {
      checkpoint('target_transaction_started');
      for (const [index, record] of source.records.entries()) {
        const intakeSequence = index + 1;
        insertImportedApplication(database, record, intakeSequence);
        checkpoint('record_inserted', Object.freeze({ intakeSequence }));
      }
      insertApplicationImportReceipt(database, source.receipt);
      checkpoint('before_commit');
    });
    verifyImportedApplicationDatabase(database, source.receipt, source.records);
  } catch (error) {
    primaryError = error;
  } finally {
    if (native) {
      try {
        native.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    try {
      assertStageReadyForOpen(options, stage, 1n);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  throwOperationErrors(primaryError, closeErrors, 'Application database build failed.');
}

function verifyStageDatabase(
  options: ResolvedImportOptions,
  stage: ImportStage,
  source: ValidatedSource,
  expectedLinks: bigint,
  targetSidecarCode?: Extract<
    ApplicationImportCode,
    'recovery_conflict' | 'target_conflict' | 'target_changed'
  >,
): StableDatabaseProof {
  const before = assertStageReadyForOpen(options, stage, expectedLinks);
  if (targetSidecarCode) assertTargetSidecarsAbsent(options.databasePath, targetSidecarCode);
  let native: DatabaseSync | undefined;
  let primaryError: unknown;
  const closeErrors: unknown[] = [];
  try {
    native = new DatabaseSync(stage.databasePath, { readOnly: true });
    // Prove the owned pin immediately after SQLite opens and before any database operation.
    assertStageReadyForOpen(options, stage, expectedLinks);
    if (targetSidecarCode) assertTargetSidecarsAbsent(options.databasePath, targetSidecarCode);
    native.enableDefensive(true);
    const database: SyncSqliteDatabase = createPreparedSyncSqliteAdapter(native);
    verifyImportedApplicationDatabase(database, source.receipt, source.records);
  } catch (error) {
    primaryError = error;
  } finally {
    if (native) {
      try {
        native.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    try {
      const after = assertStageReadyForOpen(options, stage, expectedLinks);
      if (!sameSnapshot(before, after)) {
        throw new Error('Application staging database changed during read-only verification.');
      }
      if (targetSidecarCode) {
        assertTargetSidecarsAbsent(options.databasePath, targetSidecarCode);
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }
  throwOperationErrors(primaryError, closeErrors, 'Application database verification failed.');
  return proofFromDescriptor(stage.databaseDescriptor);
}

function verifyExactReplay(
  options: ResolvedImportOptions,
  stage: ImportStage,
  target: ExistingTarget,
  source: ValidatedSource,
): StableDatabaseProof {
  try {
    assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
    assertTargetMatchesSnapshot(options.databasePath, target.snapshot, 2n, 'target_changed');
    const proof = verifyStageDatabase(options, stage, source, 2n, 'target_conflict');
    assertProofMatchesSnapshot(proof, target.snapshot);
    assertTargetMatchesProof(options.databasePath, proof, 2n, 'target_changed');
    assertSourceUnchanged(source);
    assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
    return proof;
  } catch (error) {
    if (
      error instanceof ApplicationImportError &&
      (error.code === 'target_changed' || error.code === 'target_conflict')
    ) {
      throw error;
    }
    throw new ApplicationImportError(
      'target_conflict',
      'Existing application database is not the exact verified import target.',
      { cause: error },
    );
  }
}

function sealStageMarker(
  options: ResolvedImportOptions,
  stage: ImportStage,
  source: ValidatedSource,
  proof: StableDatabaseProof,
): void {
  if (stage.markerIdentity) throw new Error('Application staging marker is already sealed.');
  assertStageReadyForOpen(options, stage, stage.role === 'build' ? 1n : 2n);
  assertProofEqual(proofFromDescriptor(stage.databaseDescriptor), proof);
  const marker: StageMarker = Object.freeze({
    databaseDev: proof.dev.toString(),
    databaseIno: proof.ino.toString(),
    databaseSha256: proof.digest,
    databaseSize: proof.size.toString(),
    directoryDev: stage.directoryIdentity.dev.toString(),
    directoryIno: stage.directoryIdentity.ino.toString(),
    formatVersion: 1,
    kind: 'handmark_application_import',
    ownerPid: process.pid.toString(),
    parentDev: options.parentSnapshot.dev.toString(),
    parentIno: options.parentSnapshot.ino.toString(),
    role: stage.role,
    sourceCtimeNs: source.snapshot.ctimeNs.toString(),
    sourceDev: source.snapshot.dev.toString(),
    sourceGid: source.snapshot.gid.toString(),
    sourceIno: source.snapshot.ino.toString(),
    sourceMode: source.snapshot.mode.toString(),
    sourceMtimeNs: source.snapshot.mtimeNs.toString(),
    sourceReceipt: Object.freeze({ ...source.receipt }),
    sourceSize: source.snapshot.size.toString(),
    sourceUid: source.snapshot.uid.toString(),
    targetName: path.basename(options.databasePath),
  });
  const bytes = stageMarkerBytes(marker);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      stage.markerPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
    writeExact(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const markerSnapshot = fileSnapshot(fs.fstatSync(descriptor, { bigint: true }));
    if (!isPrivateOwnedFile(markerSnapshot) || markerSnapshot.nlink !== 1n) {
      throw new Error('Application staging marker is not a private single-link file.');
    }
    stage.markerIdentity = Object.freeze({ dev: markerSnapshot.dev, ino: markerSnapshot.ino });
    closeFileDescriptor(descriptor);
    descriptor = undefined;
    fs.fsyncSync(stage.directoryDescriptor);
    syncParentDirectory(options);
    assertStageReadyForOpen(options, stage, stage.role === 'build' ? 1n : 2n);
  } finally {
    if (descriptor !== undefined) closeFileDescriptor(descriptor);
  }
}

function linkStageToTarget(
  options: ResolvedImportOptions,
  stage: ImportStage,
  proof: StableDatabaseProof,
): StableDatabaseProof {
  assertParentStable(options, 'target_changed');
  assertStageReadyForOpen(options, stage, 1n);
  assertProofEqual(proofFromDescriptor(stage.databaseDescriptor), proof);
  assertTargetAbsent(options.databasePath);
  assertTargetSidecarsAbsent(options.databasePath, 'target_changed');
  try {
    fs.linkSync(stage.databasePath, options.databasePath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new ApplicationImportError(
        'target_changed',
        'Application database target appeared during exclusive publication.',
        { cause: error },
      );
    }
    throw error;
  }
  return proof;
}

function finalizePublishedTarget(
  options: ResolvedImportOptions,
  stage: ImportStage,
  proof: StableDatabaseProof,
  source: ValidatedSource,
  checkpoint: (name: ApplicationImportCheckpoint, details?: ImportCheckpointDetails) => void,
  emitCheckpoint: boolean,
): void {
  assertParentStable(options, 'target_changed');
  assertStageReadyForOpen(options, stage, 2n);
  assertTargetMatchesProof(options.databasePath, proof, 2n, 'target_changed');
  assertTargetSidecarsAbsent(options.databasePath, 'target_changed');
  if (emitCheckpoint) checkpoint('target_published', stageCheckpointDetails(stage));

  // Hooks and external processes may create a journal after the durable link. Such a target is not
  // accepted: only our main inode is rolled back, and the unknown sidecar is preserved as evidence.
  assertTargetSidecarsAbsent(options.databasePath, 'target_changed');
  assertTargetMatchesProof(options.databasePath, proof, 2n, 'target_changed');
  assertProofEqual(proofFromDescriptor(stage.databaseDescriptor), proof);
  assertSourceUnchanged(source);
  if (emitCheckpoint) checkpoint('final_source_verified', stageCheckpointDetails(stage));
  assertTargetSidecarsAbsent(options.databasePath, 'target_changed');
  assertParentStable(options, 'target_changed');
  assertTargetMatchesProof(options.databasePath, proof, 2n, 'target_changed');

  cleanupStage(options, stage);
  assertParentStable(options, 'target_changed');
  assertTargetMatchesProof(options.databasePath, proof, 1n, 'target_changed');
  assertTargetSidecarsAbsent(options.databasePath, 'target_changed');
  fs.fsyncSync(options.parentDescriptor);
  assertTargetSidecarsAbsent(options.databasePath, 'target_changed');
}

function finalizeExactReplay(
  options: ResolvedImportOptions,
  stage: ImportStage,
  proof: StableDatabaseProof,
  source: ValidatedSource,
): void {
  assertParentStable(options, 'target_changed');
  assertStageReadyForOpen(options, stage, 2n);
  assertTargetMatchesProof(options.databasePath, proof, 2n, 'target_changed');
  assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
  assertSourceUnchanged(source);
  assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
  assertProofEqual(proofFromDescriptor(stage.databaseDescriptor), proof);

  cleanupStage(options, stage);
  assertParentStable(options, 'target_changed');
  assertTargetMatchesProof(options.databasePath, proof, 1n, 'target_changed');
  assertTargetSidecarsAbsent(options.databasePath, 'target_conflict');
}

function rollbackPublishedTarget(
  options: ResolvedImportOptions,
  target: StableDatabaseProof,
): void {
  assertParentStable(options, 'cleanup_failed');
  try {
    const stats = fs.lstatSync(options.databasePath, { bigint: true });
    if (stats.isFile() && stats.dev === target.dev && stats.ino === target.ino) {
      fs.unlinkSync(options.databasePath);
      fs.fsyncSync(options.parentDescriptor);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function syncStageDatabase(
  options: ResolvedImportOptions,
  stage: ImportStage,
  expectedLinks: bigint,
): void {
  assertStageReadyForOpen(options, stage, expectedLinks);
  fs.fsyncSync(stage.databaseDescriptor);
  fs.fsyncSync(stage.directoryDescriptor);
  assertStageReadyForOpen(options, stage, expectedLinks);
}

function assertStageReadyForOpen(
  options: ResolvedImportOptions,
  stage: ImportStage,
  expectedLinks: bigint,
): FileSnapshot {
  assertParentStable(options, 'target_changed');
  assertStageDirectoryIdentity(stage);
  const entries = fs.readdirSync(stage.directoryPath).toSorted();
  const expected = [STAGE_DATABASE_NAME];
  if (stage.markerIdentity) expected.push(STAGE_MARKER_NAME);
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected.toSorted()[index])
  ) {
    throw new Error('Application staging contains an unexpected or missing entry.');
  }
  if (stageSidecarPaths(stage.directoryPath).some(pathExists)) {
    throw new Error('Application staging has an unexpected SQLite sidecar.');
  }
  if (stage.markerIdentity) assertStageMarkerIdentity(stage);
  const snapshot = assertStageDatabaseIdentity(options, stage, expectedLinks);
  assertStageDirectoryIdentity(stage);
  assertParentStable(options, 'target_changed');
  return snapshot;
}

function assertStageDirectoryIdentity(stage: ImportStage): void {
  const descriptorSnapshot = fileSnapshot(
    fs.fstatSync(stage.directoryDescriptor, { bigint: true }),
  );
  const pathStats = fs.lstatSync(stage.directoryPath, { bigint: true });
  const pathSnapshot = fileSnapshot(pathStats);
  if (
    !isPrivateOwnedDirectory(pathStats) ||
    !sameDirectoryIdentity(descriptorSnapshot, pathSnapshot) ||
    !sameFileIdentity(descriptorSnapshot, stage.directoryIdentity)
  ) {
    throw new Error('Application staging directory changed identity.');
  }
}

function assertStageDatabaseIdentity(
  options: ResolvedImportOptions,
  stage: ImportStage,
  expectedLinks: bigint,
): FileSnapshot {
  assertParentStable(options, 'target_changed');
  const descriptorSnapshot = fileSnapshot(fs.fstatSync(stage.databaseDescriptor, { bigint: true }));
  const pathSnapshot = inspectRegularFile(stage.databasePath);
  if (
    !isPrivateOwnedFile(descriptorSnapshot) ||
    !sameFileIdentity(descriptorSnapshot, stage.databaseIdentity) ||
    !sameFileIdentity(pathSnapshot, stage.databaseIdentity) ||
    pathSnapshot.nlink !== expectedLinks ||
    descriptorSnapshot.nlink !== expectedLinks
  ) {
    throw new Error('Application staging database changed identity or link topology.');
  }
  return pathSnapshot;
}

function assertStageMarkerIdentity(stage: ImportStage): void {
  const identity = stage.markerIdentity;
  if (!identity) throw new Error('Application staging marker identity is missing.');
  const snapshot = inspectRegularFile(stage.markerPath);
  if (
    !isPrivateOwnedFile(snapshot) ||
    snapshot.nlink !== 1n ||
    !sameFileIdentity(snapshot, identity)
  ) {
    throw new Error('Application staging marker changed identity.');
  }
}

function proofFromDescriptor(descriptor: number): StableDatabaseProof {
  const snapshot = fileSnapshot(fs.fstatSync(descriptor, { bigint: true }));
  if (!isPrivateOwnedFile(snapshot) || snapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Application database cannot be proven as a private safe-sized file.');
  }
  const digest = hashFileDescriptor(descriptor, Number(snapshot.size));
  const after = fileSnapshot(fs.fstatSync(descriptor, { bigint: true }));
  if (!sameSnapshot(snapshot, after)) {
    throw new Error('Application database changed while it was hashed.');
  }
  return Object.freeze({
    dev: snapshot.dev,
    digest,
    gid: snapshot.gid,
    ino: snapshot.ino,
    mode: snapshot.mode,
    mtimeNs: snapshot.mtimeNs,
    size: snapshot.size,
    uid: snapshot.uid,
  });
}

function assertProofEqual(left: StableDatabaseProof, right: StableDatabaseProof): void {
  if (
    left.dev !== right.dev ||
    left.digest !== right.digest ||
    left.gid !== right.gid ||
    left.ino !== right.ino ||
    left.mode !== right.mode ||
    left.mtimeNs !== right.mtimeNs ||
    left.size !== right.size ||
    left.uid !== right.uid
  ) {
    throw new Error('Application database proof changed.');
  }
}

function assertProofMatchesSnapshot(proof: StableDatabaseProof, snapshot: FileSnapshot): void {
  if (
    proof.dev !== snapshot.dev ||
    proof.gid !== snapshot.gid ||
    proof.ino !== snapshot.ino ||
    proof.mode !== snapshot.mode ||
    proof.mtimeNs !== snapshot.mtimeNs ||
    proof.size !== snapshot.size ||
    proof.uid !== snapshot.uid
  ) {
    throw new Error('Pinned database does not match the inspected target.');
  }
}

function assertTargetMatchesSnapshot(
  databasePath: string,
  expected: FileSnapshot,
  expectedLinks: bigint,
  code: Extract<ApplicationImportCode, 'recovery_conflict' | 'target_changed'>,
): void {
  let snapshot: FileSnapshot;
  try {
    snapshot = inspectRegularFile(databasePath);
  } catch (error) {
    throw new ApplicationImportError(code, 'Application database target changed identity.', {
      cause: error,
    });
  }
  if (
    !isPrivateOwnedFile(snapshot) ||
    snapshot.dev !== expected.dev ||
    snapshot.gid !== expected.gid ||
    snapshot.ino !== expected.ino ||
    snapshot.mode !== expected.mode ||
    snapshot.mtimeNs !== expected.mtimeNs ||
    snapshot.nlink !== expectedLinks ||
    snapshot.size !== expected.size ||
    snapshot.uid !== expected.uid
  ) {
    throw new ApplicationImportError(code, 'Application database target changed identity.');
  }
}

function assertTargetMatchesProof(
  databasePath: string,
  proof: StableDatabaseProof,
  expectedLinks: bigint,
  code: Extract<ApplicationImportCode, 'recovery_conflict' | 'target_changed'>,
): void {
  let snapshot: FileSnapshot;
  try {
    snapshot = inspectRegularFile(databasePath);
  } catch (error) {
    throw new ApplicationImportError(code, 'Application database target changed identity.', {
      cause: error,
    });
  }
  if (
    !isPrivateOwnedFile(snapshot) ||
    snapshot.dev !== proof.dev ||
    snapshot.gid !== proof.gid ||
    snapshot.ino !== proof.ino ||
    snapshot.mode !== proof.mode ||
    snapshot.mtimeNs !== proof.mtimeNs ||
    snapshot.nlink !== expectedLinks ||
    snapshot.size !== proof.size ||
    snapshot.uid !== proof.uid
  ) {
    throw new ApplicationImportError(code, 'Application database target changed identity.');
  }
}

function assertTargetAbsent(databasePath: string): void {
  try {
    fs.lstatSync(databasePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new ApplicationImportError(
    'target_changed',
    'Application database target appeared before publication.',
  );
}

function inspectRecoveryTarget(databasePath: string): FileSnapshot | undefined {
  try {
    const stats = fs.lstatSync(databasePath, { bigint: true });
    if (!stats.isFile()) throw new Error('Recovered application target is not a regular file.');
    return fileSnapshot(stats);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function inspectRegularFile(filePath: string): FileSnapshot {
  const stats = fs.lstatSync(filePath, { bigint: true });
  if (!stats.isFile()) throw new Error(`${filePath} is not a regular file.`);
  return fileSnapshot(stats);
}

function fileSnapshot(stats: fs.BigIntStats): FileSnapshot {
  return Object.freeze({
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    gid: stats.gid,
    ino: stats.ino,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    nlink: stats.nlink,
    size: stats.size,
    uid: stats.uid,
  });
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

function readExactFile(
  fileDescriptor: number,
  size: number,
  failureCode: Extract<ApplicationImportCode, 'source_changed'>,
): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fileDescriptor, bytes, offset, size - offset, offset);
    if (read === 0) {
      throw new ApplicationImportError(failureCode, 'Application source ended while being read.');
    }
    offset += read;
  }
  return bytes;
}

function hashFileDescriptor(fileDescriptor: number, size: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const requested = Math.min(chunk.byteLength, size - offset);
    const read = fs.readSync(fileDescriptor, chunk, 0, requested, offset);
    if (read === 0) throw new Error('File ended while it was being hashed.');
    hash.update(chunk.subarray(0, read));
    offset += read;
  }
  return hash.digest('hex');
}

function assertTargetSidecarsAbsent(
  databasePath: string,
  code: Extract<ApplicationImportCode, 'recovery_conflict' | 'target_changed' | 'target_conflict'>,
): void {
  if (!sqliteSidecars(databasePath).some(pathExists)) return;
  throw new ApplicationImportError(
    code,
    'Application database target has unexpected SQLite sidecars.',
  );
}

function sqliteSidecars(databasePath: string): readonly string[] {
  return [`${databasePath}-journal`, `${databasePath}-shm`, `${databasePath}-wal`];
}

function stageSidecarPaths(directoryPath: string): readonly string[] {
  return sqliteSidecars(path.join(directoryPath, STAGE_DATABASE_NAME));
}

function stageEntryNames(): ReadonlySet<string> {
  return new Set([
    STAGE_DATABASE_NAME,
    STAGE_MARKER_NAME,
    ...stageSidecarPaths('').map((sidecar) => path.basename(sidecar)),
  ]);
}

function stageCheckpointDetails(stage: ImportStage): ImportCheckpointDetails {
  return Object.freeze({
    databasePath: stage.databasePath,
    stagingDirectory: stage.directoryPath,
  });
}

function assertParentStable(
  options: ResolvedImportOptions,
  code: Extract<ApplicationImportCode, 'cleanup_failed' | 'recovery_conflict' | 'target_changed'>,
): void {
  try {
    const descriptorStats = fs.fstatSync(options.parentDescriptor, { bigint: true });
    const pathStats = fs.lstatSync(options.parentPath, { bigint: true });
    const descriptorSnapshot = fileSnapshot(descriptorStats);
    const pathSnapshot = fileSnapshot(pathStats);
    if (
      !descriptorStats.isDirectory() ||
      !pathStats.isDirectory() ||
      !sameDirectoryIdentity(descriptorSnapshot, options.parentSnapshot) ||
      !sameDirectoryIdentity(pathSnapshot, options.parentSnapshot)
    ) {
      throw new Error('Application database parent changed identity.');
    }
  } catch (error) {
    if (error instanceof ApplicationImportError && error.code === code) throw error;
    throw new ApplicationImportError(code, 'Application database parent changed identity.', {
      cause: error,
    });
  }
}

function syncParentDirectory(options: ResolvedImportOptions): void {
  assertParentStable(options, 'target_changed');
  fs.fsyncSync(options.parentDescriptor);
  assertParentStable(options, 'target_changed');
}

function sameDirectoryIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function sameFileIdentity(
  snapshot: Pick<FileSnapshot, 'dev' | 'ino'>,
  identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>,
): boolean {
  return snapshot.dev === identity.dev && snapshot.ino === identity.ino;
}

function isPrivateOwnedFile(value: Pick<FileSnapshot, 'mode' | 'uid'>): boolean {
  return (
    (value.mode & 0o170000n) === 0o100000n &&
    (value.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE) &&
    value.uid === CURRENT_EFFECTIVE_UID
  );
}

function isPrivateOwnedDirectory(
  value: Pick<FileSnapshot, 'mode' | 'uid'> | fs.BigIntStats,
): boolean {
  return (
    (value.mode & 0o170000n) === 0o040000n &&
    (value.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE) &&
    value.uid === CURRENT_EFFECTIVE_UID
  );
}

function stageMarkerBytes(marker: StageMarker): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      databaseDev: marker.databaseDev,
      databaseIno: marker.databaseIno,
      databaseSha256: marker.databaseSha256,
      databaseSize: marker.databaseSize,
      directoryDev: marker.directoryDev,
      directoryIno: marker.directoryIno,
      formatVersion: marker.formatVersion,
      kind: marker.kind,
      ownerPid: marker.ownerPid,
      parentDev: marker.parentDev,
      parentIno: marker.parentIno,
      role: marker.role,
      sourceCtimeNs: marker.sourceCtimeNs,
      sourceDev: marker.sourceDev,
      sourceGid: marker.sourceGid,
      sourceIno: marker.sourceIno,
      sourceMode: marker.sourceMode,
      sourceMtimeNs: marker.sourceMtimeNs,
      sourceReceipt: {
        formatVersion: marker.sourceReceipt.formatVersion,
        orderedRecordsSha256: marker.sourceReceipt.orderedRecordsSha256,
        recordCount: marker.sourceReceipt.recordCount,
        sourceBytes: marker.sourceReceipt.sourceBytes,
        sourceSha256: marker.sourceReceipt.sourceSha256,
      },
      sourceSize: marker.sourceSize,
      sourceUid: marker.sourceUid,
      targetName: marker.targetName,
    })}\n`,
    'utf8',
  );
}

function readStageMarker(markerPath: string): Readonly<{
  readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly marker: StageMarker;
}> {
  const pathStats = fs.lstatSync(markerPath, { bigint: true });
  if (
    !pathStats.isFile() ||
    pathStats.nlink !== 1n ||
    !isPrivateOwnedFile(fileSnapshot(pathStats)) ||
    pathStats.size > BigInt(STAGE_MARKER_MAX_BYTES)
  ) {
    throw new Error('Application import marker is not a bounded private regular file.');
  }
  const descriptor = fs.openSync(markerPath, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const snapshot = fileSnapshot(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameSnapshot(snapshot, fileSnapshot(pathStats))) {
      throw new Error('Application import marker changed while it was opened.');
    }
    const bytes = readDescriptorBytes(descriptor, Number(snapshot.size));
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      throw new Error('Application import marker is not canonical UTF-8 JSON.', { cause: error });
    }
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.sourceReceipt)) {
      throw new Error('Application import marker has an invalid shape.');
    }
    const topKeys = [
      'databaseDev',
      'databaseIno',
      'databaseSha256',
      'databaseSize',
      'directoryDev',
      'directoryIno',
      'formatVersion',
      'kind',
      'ownerPid',
      'parentDev',
      'parentIno',
      'role',
      'sourceCtimeNs',
      'sourceDev',
      'sourceGid',
      'sourceIno',
      'sourceMode',
      'sourceMtimeNs',
      'sourceReceipt',
      'sourceSize',
      'sourceUid',
      'targetName',
    ].toSorted();
    const receiptKeys = [
      'formatVersion',
      'orderedRecordsSha256',
      'recordCount',
      'sourceBytes',
      'sourceSha256',
    ].toSorted();
    if (
      Object.keys(parsed).toSorted().join('\0') !== topKeys.join('\0') ||
      Object.keys(parsed.sourceReceipt).toSorted().join('\0') !== receiptKeys.join('\0')
    ) {
      throw new Error('Application import marker does not have the exact field set.');
    }

    const decimalFields = [
      'databaseDev',
      'databaseIno',
      'databaseSize',
      'directoryDev',
      'directoryIno',
      'ownerPid',
      'parentDev',
      'parentIno',
      'sourceCtimeNs',
      'sourceDev',
      'sourceGid',
      'sourceIno',
      'sourceMode',
      'sourceMtimeNs',
      'sourceSize',
      'sourceUid',
    ] as const;
    for (const field of decimalFields) {
      if (typeof parsed[field] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(parsed[field])) {
        throw new Error(`Application import marker field ${field} is not canonical decimal.`);
      }
    }
    const receipt = parsed.sourceReceipt;
    if (
      parsed.formatVersion !== 1 ||
      parsed.kind !== 'handmark_application_import' ||
      (parsed.role !== 'build' && parsed.role !== 'replay') ||
      BigInt(parsed.ownerPid as string) < 1n ||
      BigInt(parsed.ownerPid as string) > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof parsed.targetName !== 'string' ||
      typeof parsed.databaseSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.databaseSha256) ||
      receipt.formatVersion !== APPLICATION_IMPORT_FORMAT_VERSION ||
      typeof receipt.sourceBytes !== 'number' ||
      !Number.isSafeInteger(receipt.sourceBytes) ||
      receipt.sourceBytes < 0 ||
      typeof receipt.recordCount !== 'number' ||
      !Number.isSafeInteger(receipt.recordCount) ||
      receipt.recordCount < 0 ||
      typeof receipt.sourceSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receipt.sourceSha256) ||
      typeof receipt.orderedRecordsSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receipt.orderedRecordsSha256)
    ) {
      throw new Error('Application import marker values are invalid.');
    }
    const marker: StageMarker = Object.freeze({
      databaseDev: parsed.databaseDev as string,
      databaseIno: parsed.databaseIno as string,
      databaseSha256: parsed.databaseSha256,
      databaseSize: parsed.databaseSize as string,
      directoryDev: parsed.directoryDev as string,
      directoryIno: parsed.directoryIno as string,
      formatVersion: 1,
      kind: 'handmark_application_import',
      ownerPid: parsed.ownerPid as string,
      parentDev: parsed.parentDev as string,
      parentIno: parsed.parentIno as string,
      role: parsed.role,
      sourceCtimeNs: parsed.sourceCtimeNs as string,
      sourceDev: parsed.sourceDev as string,
      sourceGid: parsed.sourceGid as string,
      sourceIno: parsed.sourceIno as string,
      sourceMode: parsed.sourceMode as string,
      sourceMtimeNs: parsed.sourceMtimeNs as string,
      sourceReceipt: Object.freeze({
        formatVersion: APPLICATION_IMPORT_FORMAT_VERSION,
        orderedRecordsSha256: receipt.orderedRecordsSha256,
        recordCount: receipt.recordCount,
        sourceBytes: receipt.sourceBytes,
        sourceSha256: receipt.sourceSha256,
      }),
      sourceSize: parsed.sourceSize as string,
      sourceUid: parsed.sourceUid as string,
      targetName: parsed.targetName,
    });
    if (!bytes.equals(stageMarkerBytes(marker))) {
      throw new Error('Application import marker bytes are not canonical.');
    }
    const after = fileSnapshot(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameSnapshot(snapshot, after)) {
      throw new Error('Application import marker changed while it was read.');
    }
    return Object.freeze({
      identity: Object.freeze({ dev: snapshot.dev, ino: snapshot.ino }),
      marker,
    });
  } finally {
    closeFileDescriptor(descriptor);
  }
}

function assertMarkerMatchesOperation(
  marker: StageMarker,
  options: ResolvedImportOptions,
  source: ValidatedSource,
  directory: FileSnapshot,
): void {
  const expectedReceipt = source.receipt;
  if (
    marker.targetName !== path.basename(options.databasePath) ||
    marker.parentDev !== options.parentSnapshot.dev.toString() ||
    marker.parentIno !== options.parentSnapshot.ino.toString() ||
    marker.directoryDev !== directory.dev.toString() ||
    marker.directoryIno !== directory.ino.toString() ||
    marker.sourceCtimeNs !== source.snapshot.ctimeNs.toString() ||
    marker.sourceDev !== source.snapshot.dev.toString() ||
    marker.sourceGid !== source.snapshot.gid.toString() ||
    marker.sourceIno !== source.snapshot.ino.toString() ||
    marker.sourceMode !== source.snapshot.mode.toString() ||
    marker.sourceMtimeNs !== source.snapshot.mtimeNs.toString() ||
    marker.sourceSize !== source.snapshot.size.toString() ||
    marker.sourceUid !== source.snapshot.uid.toString() ||
    marker.sourceReceipt.formatVersion !== expectedReceipt.formatVersion ||
    marker.sourceReceipt.orderedRecordsSha256 !== expectedReceipt.orderedRecordsSha256 ||
    marker.sourceReceipt.recordCount !== expectedReceipt.recordCount ||
    marker.sourceReceipt.sourceBytes !== expectedReceipt.sourceBytes ||
    marker.sourceReceipt.sourceSha256 !== expectedReceipt.sourceSha256
  ) {
    throw new Error('Application import marker does not match this source and target operation.');
  }
}

function assertMarkerOwnerStopped(marker: StageMarker): void {
  const ownerPid = Number(marker.ownerPid);
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return;
    throw new Error('Interrupted import owner liveness could not be proven.', { cause: error });
  }
  throw new Error('Application import staging is owned by a live process.');
}

function cleanupStage(options: ResolvedImportOptions, stage: ImportStage): void {
  const errors: ApplicationImportError[] = [];
  let namespaceProven = false;
  let preserveMarker = false;

  try {
    assertParentStable(options, 'cleanup_failed');
    if (pathExists(stage.directoryPath)) {
      assertStageDirectoryIdentity(stage);
      namespaceProven = true;
    }
  } catch (error) {
    errors.push(cleanupError('staging namespace proof', error));
  }

  if (namespaceProven) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(stage.directoryPath).toSorted();
      const unknown = entries.filter((entry) => !stageEntryNames().has(entry));
      if (unknown.length > 0) {
        preserveMarker = true;
        errors.push(
          cleanupError(
            'staging inventory',
            new Error('Application staging contains an unknown entry.'),
          ),
        );
      }
      if (stageSidecarPaths(stage.directoryPath).some(pathExists)) {
        preserveMarker = true;
        errors.push(
          cleanupError(
            'staging sidecar preservation',
            new Error('Application staging contains an ownership-unproven SQLite sidecar.'),
          ),
        );
      }
    } catch (error) {
      preserveMarker = true;
      errors.push(cleanupError('staging inventory', error));
    }

    try {
      const databaseSnapshot = pathExists(stage.databasePath)
        ? fs.lstatSync(stage.databasePath, { bigint: true })
        : undefined;
      const publicSnapshot = pathExists(options.databasePath)
        ? fs.lstatSync(options.databasePath, { bigint: true })
        : undefined;
      const replayLastCopy =
        stage.role === 'replay' &&
        databaseSnapshot?.isFile() === true &&
        sameFileIdentity(databaseSnapshot, stage.databaseIdentity) &&
        databaseSnapshot.nlink === 1n &&
        (!publicSnapshot?.isFile() || !sameFileIdentity(publicSnapshot, stage.databaseIdentity));
      if (replayLastCopy) {
        preserveMarker = true;
        errors.push(
          cleanupError(
            'replay pin preservation',
            new Error('The replay pin is the last link to the formerly inspected target.'),
          ),
        );
      } else {
        removeExactStageAlias(stage.databasePath, stage.databaseIdentity);
      }
    } catch (error) {
      preserveMarker = true;
      errors.push(cleanupError('staging database cleanup', error));
    }

    if (!preserveMarker) {
      try {
        removeExactStageAlias(stage.markerPath, stage.markerIdentity);
      } catch (error) {
        errors.push(cleanupError('staging marker cleanup', error));
      }
    }

    try {
      const remaining = fs.readdirSync(stage.directoryPath);
      if (remaining.length === 0) {
        assertStageDirectoryIdentity(stage);
        fs.rmdirSync(stage.directoryPath);
        fs.fsyncSync(options.parentDescriptor);
      } else {
        errors.push(
          cleanupError(
            'staging directory cleanup',
            new Error('Application staging retains preserved or unknown entries.'),
          ),
        );
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        errors.push(cleanupError('staging directory cleanup', error));
      }
    }
  }

  try {
    closeFileDescriptor(stage.databaseDescriptor);
  } catch (error) {
    errors.push(cleanupError('staging database descriptor close', error));
  }
  try {
    closeFileDescriptor(stage.directoryDescriptor);
  } catch (error) {
    errors.push(cleanupError('staging directory descriptor close', error));
  }
  if (errors.length > 0) {
    throw new ApplicationImportError(
      'cleanup_failed',
      'Application import staging could not be cleaned completely.',
      { cause: new AggregateError(errors) },
    );
  }
}

function removeExactStageAlias(
  filePath: string,
  identity: Readonly<{ readonly dev: bigint; readonly ino: bigint }> | undefined,
): void {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(filePath);
    return;
  }
  if (!stats.isFile()) throw new Error('Reserved staging entry is not safely unlinkable.');
  if (identity && sameFileIdentity(stats, identity)) {
    fs.unlinkSync(filePath);
    return;
  }
  if (stats.nlink > 1n) {
    fs.unlinkSync(filePath);
    return;
  }
  throw new Error('Reserved staging entry is an unowned single-link regular file.');
}

function readDescriptorBytes(descriptor: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (read === 0) throw new Error('File ended before its expected byte length.');
    offset += read;
  }
  return bytes;
}

function writeExact(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written === 0) throw new Error('File write made no progress.');
    offset += written;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recoveryConflict(message: string, cause?: unknown): ApplicationImportError {
  return new ApplicationImportError(
    'recovery_conflict',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function cleanupError(label: string, cause: unknown): ApplicationImportError {
  if (cause instanceof ApplicationImportError && cause.code === 'cleanup_failed') return cause;
  return new ApplicationImportError('cleanup_failed', `Application import ${label} failed.`, {
    cause,
  });
}

function captureCleanupError(
  errors: ApplicationImportError[],
  label: string,
  work: () => void,
): void {
  try {
    work();
  } catch (error) {
    errors.push(cleanupError(label, error));
  }
}

function throwCombinedImportFailure(
  primary: unknown,
  cleanupErrors: readonly ApplicationImportError[],
): never {
  if (primary === undefined) {
    throw new ApplicationImportError(
      'cleanup_failed',
      'Application import completed but cleanup failed.',
      { cause: new AggregateError(cleanupErrors) },
    );
  }
  const normalized =
    primary instanceof ApplicationImportError
      ? primary
      : new ApplicationImportError('import_failed', 'Application import failed safely.', {
          cause: primary,
        });
  if (cleanupErrors.length === 0) throw normalized;
  throw new ApplicationImportError(normalized.code, normalized.message, {
    cause: new AggregateError([primary, ...cleanupErrors]),
    ...(normalized.field === undefined ? {} : { field: normalized.field }),
    ...(normalized.line === undefined ? {} : { line: normalized.line }),
  });
}

function throwOperationErrors(
  primary: unknown,
  secondary: readonly unknown[],
  message: string,
): void {
  if (primary !== undefined && secondary.length === 0) throw primary;
  if (primary !== undefined) throw new AggregateError([primary, ...secondary], message);
  if (secondary.length === 1) throw secondary[0];
  if (secondary.length > 1) throw new AggregateError(secondary, message);
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function closeFileDescriptor(fileDescriptor: number): void {
  try {
    fs.closeSync(fileDescriptor);
  } catch (error) {
    if (errorCode(error) !== 'EBADF') throw error;
  }
}

function requiredFsConstant(value: number | undefined, name: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Handmark application import requires the ${name} filesystem flag.`);
  }
  return value;
}

function currentEffectiveUserId(): bigint {
  const getEffectiveUserId = process.geteuid;
  if (typeof getEffectiveUserId !== 'function') {
    throw new Error('Handmark application import requires an effective Unix user id.');
  }
  return BigInt(getEffectiveUserId());
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

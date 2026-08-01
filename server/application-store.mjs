import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
export const STALE_COMPACTION_TEMP_MS = 24 * 60 * 60 * 1000;

export const APPLICATION_RETENTION_DAYS = 90;
export const APPLICATION_MAX_BYTES = 100 * 1024 * 1024;
export const APPLICATION_MAX_RECORDS = 10_000;
export const APPLICATION_MAX_RECORD_BYTES = 64 * 1024;
export const APPLICATION_STORAGE_FULL_MESSAGE =
  'Handmark cannot accept another application because application storage is full. Please try again later.';

export class ApplicationStoreError extends Error {
  constructor(message, { code, status, publicMessage, cause } = {}) {
    super(message, { cause });
    this.name = 'ApplicationStoreError';
    this.code = code ?? 'application_storage_error';
    this.status = status ?? 503;
    this.publicMessage =
      publicMessage ??
      'Application storage needs administrator attention. No application was written.';
  }
}

export class ApplicationStoreCapacityError extends ApplicationStoreError {
  constructor(message, options = {}) {
    super(message, {
      code: 'storage_full',
      status: 507,
      publicMessage: APPLICATION_STORAGE_FULL_MESSAGE,
      ...options,
    });
    this.name = 'ApplicationStoreCapacityError';
  }
}

export function createApplicationStore({
  filePath,
  retentionMs = APPLICATION_RETENTION_DAYS * DAY_MS,
  maxBytes = APPLICATION_MAX_BYTES,
  maxRecords = APPLICATION_MAX_RECORDS,
  maxRecordBytes = APPLICATION_MAX_RECORD_BYTES,
  now = Date.now,
  maintenanceIntervalMs = DAY_MS,
} = {}) {
  if (!filePath) throw new TypeError('filePath is required.');
  for (const [name, value] of Object.entries({
    retentionMs,
    maxBytes,
    maxRecords,
    maxRecordBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`${name} must be a positive integer.`);
  }

  let initialized = false;
  let state = { bytes: 0, records: 0, nextExpiryAt: undefined };
  let queue = Promise.resolve();
  let maintenanceTimer;
  let maintenanceInFlight;
  let maintenanceStopped = true;

  function serialized(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function validateRecord(record, currentTime) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new ApplicationStoreError('Application storage contains a non-object record.');
    }
    if (typeof record.createdAt !== 'string') {
      throw new ApplicationStoreError('Application storage contains a record without createdAt.');
    }
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAt)) {
      throw new ApplicationStoreError(
        'Application storage contains an invalid createdAt timestamp.',
      );
    }
    if (createdAt > currentTime + 5 * 60 * 1000) {
      throw new ApplicationStoreError(
        'Application storage contains a createdAt timestamp in the future.',
      );
    }
    return createdAt;
  }

  function enforceCapacity(bytes, records) {
    if (bytes > maxBytes) {
      throw new ApplicationStoreCapacityError(
        `Application storage would exceed ${maxBytes} bytes (${bytes} requested).`,
      );
    }
    if (records > maxRecords) {
      throw new ApplicationStoreCapacityError(
        `Application storage would exceed ${maxRecords} records (${records} requested).`,
      );
    }
  }

  async function compactUnlocked() {
    const currentTime = now();
    const inspectedFile = await inspectStoragePath(filePath, { allowMissing: true });
    const staleTempsRemoved = await removeStaleCompactionTemps(currentTime);
    if (!inspectedFile.fileStats) {
      state = { bytes: 0, records: 0, nextExpiryAt: undefined };
      initialized = true;
      return { ...state, removed: 0, staleTempsRemoved };
    }

    const cutoff = currentTime - retentionMs;
    const temporaryPath = `${filePath}.compact-${process.pid}-${crypto.randomUUID()}`;
    let temporary;
    let source;
    let totalRecords = 0;
    let keptRecords = 0;
    let keptBytes = 0;
    let nextExpiryAt;

    try {
      source = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
      await assertOpenedStorageFile(filePath, source, inspectedFile.fileStats);
      temporary = await open(temporaryPath, 'wx', 0o600);
      for await (const line of readBoundedLines(source, maxRecordBytes)) {
        if (line.length === 0) continue;
        totalRecords += 1;
        let record;
        try {
          record = JSON.parse(line.toString('utf8'));
        } catch (error) {
          throw new ApplicationStoreError('Application storage contains invalid JSON.', {
            cause: error,
          });
        }
        const createdAt = validateRecord(record, currentTime);
        if (createdAt <= cutoff) continue;

        const lineBytes = line.byteLength + 1;
        enforceCapacity(keptBytes + lineBytes, keptRecords + 1);
        await temporary.write(line);
        await temporary.write('\n');
        keptBytes += lineBytes;
        keptRecords += 1;
        const expiresAt = createdAt + retentionMs;
        nextExpiryAt = nextExpiryAt === undefined ? expiresAt : Math.min(nextExpiryAt, expiresAt);
      }

      await source.close();
      source = undefined;
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await rename(temporaryPath, filePath);
      await syncDirectory(dirname(filePath));
      state = { bytes: keptBytes, records: keptRecords, nextExpiryAt };
      initialized = true;
      return { ...state, removed: totalRecords - keptRecords, staleTempsRemoved };
    } catch (error) {
      if (source) await source.close().catch(() => undefined);
      if (temporary) await temporary.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof ApplicationStoreError) throw error;
      if (isStorageCapacityError(error)) {
        throw new ApplicationStoreCapacityError(
          'The filesystem could not complete application compaction.',
          {
            cause: error,
          },
        );
      }
      throw new ApplicationStoreError('Could not compact application storage atomically.', {
        cause: error,
      });
    }
  }

  async function removeStaleCompactionTemps(currentTime) {
    const directoryPath = dirname(filePath);
    const prefix = `${basename(filePath)}.compact-`;
    const suffixPattern = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw new ApplicationStoreError('Could not inspect application compaction files.', {
        cause: error,
      });
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix) || !suffixPattern.test(entry.name.slice(prefix.length))) {
        continue;
      }
      const temporaryPath = join(directoryPath, entry.name);
      let temporaryStats;
      try {
        temporaryStats = await lstat(temporaryPath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new ApplicationStoreError('Could not inspect a stale application compaction file.', {
          cause: error,
        });
      }
      // lstat does not follow symlinks. Directories, devices, and links are never removed.
      if (
        !temporaryStats.isFile() ||
        temporaryStats.mtimeMs > currentTime - STALE_COMPACTION_TEMP_MS
      ) {
        continue;
      }
      try {
        await unlink(temporaryPath);
        removed += 1;
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new ApplicationStoreError('Could not remove a stale application compaction file.', {
          cause: error,
        });
      }
    }
    return removed;
  }

  async function initialize() {
    return serialized(compactUnlocked);
  }

  async function compact() {
    return serialized(compactUnlocked);
  }

  async function append(record) {
    return serialized(async () => {
      if (!initialized) await compactUnlocked();
      const currentTime = now();
      if (state.nextExpiryAt !== undefined && state.nextExpiryAt <= currentTime) {
        await compactUnlocked();
      } else {
        try {
          const inspectedFile = await inspectStoragePath(filePath, { allowMissing: true });
          if (inspectedFile.fileStats?.size !== state.bytes) await compactUnlocked();
        } catch (error) {
          if (error instanceof ApplicationStoreError) throw error;
          throw new ApplicationStoreError('Could not inspect application storage before append.', {
            cause: error,
          });
        }
      }

      const createdAt = validateRecord(record, currentTime);
      if (createdAt <= currentTime - retentionMs) {
        throw new ApplicationStoreError(
          'Refusing to append an application that is already outside retention.',
        );
      }
      const serializedRecord = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(serializedRecord);
      if (lineBytes > maxRecordBytes) {
        throw new ApplicationStoreCapacityError(
          `Application record exceeds the ${maxRecordBytes}-byte record ceiling.`,
        );
      }
      enforceCapacity(state.bytes + lineBytes, state.records + 1);

      await inspectStoragePath(filePath, { allowMissing: true });
      let handle;
      let writeAttempted = false;
      const originalBytes = state.bytes;
      try {
        handle = await open(
          filePath,
          fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW,
          0o600,
        );
        await assertOpenedStorageFile(filePath, handle);
        writeAttempted = true;
        await handle.writeFile(serializedRecord);
        await handle.sync();
      } catch (error) {
        if (handle && writeAttempted) {
          await handle.truncate(originalBytes).catch(() => undefined);
          await handle.sync().catch(() => undefined);
        }
        if (isStorageCapacityError(error)) {
          throw new ApplicationStoreCapacityError(
            'The filesystem could not store another application.',
            {
              cause: error,
            },
          );
        }
        throw new ApplicationStoreError('Could not append the application.', { cause: error });
      } finally {
        await handle?.close().catch(() => undefined);
      }

      state.bytes += lineBytes;
      state.records += 1;
      const expiresAt = createdAt + retentionMs;
      state.nextExpiryAt =
        state.nextExpiryAt === undefined ? expiresAt : Math.min(state.nextExpiryAt, expiresAt);
      return { ...state };
    });
  }

  function scheduleMaintenance() {
    if (maintenanceStopped || maintenanceTimer || maintenanceInFlight) return;
    const currentTime = now();
    const untilExpiry =
      state.nextExpiryAt === undefined ? maintenanceIntervalMs : state.nextExpiryAt - currentTime;
    const delay = Math.max(1, Math.min(maintenanceIntervalMs, untilExpiry, MAX_TIMER_MS));
    maintenanceTimer = setTimeout(() => {
      maintenanceTimer = undefined;
      const run = (async () => {
        try {
          await compact();
        } catch (error) {
          console.error('[handmark] application retention failed', error);
        }
      })();
      maintenanceInFlight = run;
      void run.finally(() => {
        if (maintenanceInFlight === run) maintenanceInFlight = undefined;
        scheduleMaintenance();
      });
    }, delay);
    maintenanceTimer.unref();
  }

  function startMaintenance() {
    maintenanceStopped = false;
    scheduleMaintenance();
  }

  async function stopMaintenance() {
    maintenanceStopped = true;
    if (maintenanceTimer) {
      clearTimeout(maintenanceTimer);
      maintenanceTimer = undefined;
    }
    await maintenanceInFlight;
  }

  return {
    initialize,
    compact,
    append,
    startMaintenance,
    stopMaintenance,
    stats: () => ({ ...state, initialized }),
  };
}

async function* readBoundedLines(handle, maxRecordBytes) {
  let remainder = Buffer.alloc(0);
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    let data = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
    let start = 0;
    let newline = data.indexOf(10, start);
    while (newline !== -1) {
      let line = data.subarray(start, newline);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.byteLength > maxRecordBytes) {
        throw new ApplicationStoreCapacityError(
          `Application storage contains a record over ${maxRecordBytes} bytes.`,
        );
      }
      yield line;
      start = newline + 1;
      newline = data.indexOf(10, start);
    }
    remainder = data.subarray(start);
    if (remainder.byteLength > maxRecordBytes) {
      throw new ApplicationStoreCapacityError(
        `Application storage contains a record over ${maxRecordBytes} bytes.`,
      );
    }
  }
  if (remainder.length > 0) yield remainder;
}

async function inspectStoragePath(filePath, { allowMissing = false } = {}) {
  const directoryPath = dirname(filePath);
  await mkdir(directoryPath, { recursive: true });

  let directoryStats;
  try {
    directoryStats = await lstat(directoryPath);
  } catch (error) {
    throw new ApplicationStoreError('Could not inspect the application storage directory.', {
      cause: error,
    });
  }
  if (!directoryStats.isDirectory()) {
    throw new ApplicationStoreError(
      'Application storage directory must be a real directory, not a link or special file.',
    );
  }

  let fileStats;
  try {
    fileStats = await lstat(filePath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return { canonicalDirectory: await realpath(directoryPath), fileStats: undefined };
    }
    throw new ApplicationStoreError('Could not inspect application storage.', { cause: error });
  }
  if (!fileStats.isFile()) {
    throw new ApplicationStoreError(
      'Application storage must be a regular file, not a link or special file.',
    );
  }
  if (fileStats.nlink !== 1) {
    throw new ApplicationStoreError('Application storage must have exactly one filesystem link.');
  }

  const [canonicalDirectory, canonicalFile] = await Promise.all([
    realpath(directoryPath),
    realpath(filePath),
  ]);
  if (dirname(canonicalFile) !== canonicalDirectory) {
    throw new ApplicationStoreError('Application storage resolves outside its data directory.');
  }
  return { canonicalDirectory, fileStats };
}

async function assertOpenedStorageFile(filePath, handle, expectedStats) {
  const [openedStats, inspectedFile] = await Promise.all([
    handle.stat(),
    inspectStoragePath(filePath),
  ]);
  const pathStats = inspectedFile.fileStats;
  if (!openedStats.isFile()) {
    throw new ApplicationStoreError('Opened application storage is not a regular file.');
  }
  if (
    openedStats.nlink !== 1 ||
    pathStats.nlink !== 1 ||
    (expectedStats && expectedStats.nlink !== 1)
  ) {
    throw new ApplicationStoreError('Application storage must have exactly one filesystem link.');
  }
  if (
    openedStats.dev !== pathStats.dev ||
    openedStats.ino !== pathStats.ino ||
    (expectedStats &&
      (openedStats.dev !== expectedStats.dev || openedStats.ino !== expectedStats.ino))
  ) {
    throw new ApplicationStoreError('Application storage changed while it was being opened.');
  }
}

function isStorageCapacityError(error) {
  return ['ENOSPC', 'EDQUOT', 'EFBIG'].includes(error?.code);
}

async function syncDirectory(directoryPath) {
  let directory;
  try {
    directory = await open(directoryPath, 'r');
    await directory.sync();
  } catch {
    // Atomic rename has already succeeded; directory fsync is not supported on every filesystem.
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

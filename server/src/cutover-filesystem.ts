import fs from 'node:fs';
import path from 'node:path';

export const CUTOVER_DIRECTORY_MAX_ENTRIES = 256;
export const CUTOVER_DIRECTORY_MAX_NAME_BYTES = 32 * 1024;

const SQLITE_SIDECAR_SUFFIXES = Object.freeze(['-journal', '-shm', '-wal'] as const);

/**
 * Snapshot one small operational directory without allowing accumulated entries to turn a
 * pre-activation proof into an unbounded allocation or sort.
 */
export function boundedCutoverDirectoryInventory(
  directoryPath: string,
  label: string,
): readonly string[] {
  const directory = fs.opendirSync(directoryPath);
  const names: string[] = [];
  let nameBytes = 0;
  let primaryError: unknown;
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (names.length >= CUTOVER_DIRECTORY_MAX_ENTRIES) {
        throw new Error(`${label} exceeds its bounded entry ceiling.`);
      }
      nameBytes += Buffer.byteLength(entry.name, 'utf8');
      if (nameBytes > CUTOVER_DIRECTORY_MAX_NAME_BYTES) {
        throw new Error(`${label} exceeds its bounded name-byte ceiling.`);
      }
      names.push(entry.name);
    }
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  try {
    directory.closeSync();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `${label} inspection and directory close both failed.`,
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return Object.freeze(names.toSorted());
}

/**
 * SQLite uses fixed sidecar suffixes. Reject case variants as well as exact path lookups so the
 * proof stays fail-closed on both case-sensitive filesystems and the Mac's case-insensitive APFS.
 */
export function assertSqliteSidecarsAbsent(
  databasePath: string,
  directoryNames: readonly string[],
  label: string,
): void {
  const databaseName = path.basename(databasePath);
  const sidecarNames = new Set(
    SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${databaseName}${suffix}`.toLowerCase()),
  );
  if (directoryNames.some((name) => sidecarNames.has(name.toLowerCase()))) {
    throw new Error(`${label} cannot proceed while a SQLite sidecar is present.`);
  }

  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      fs.lstatSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`${label} cannot proceed while a SQLite sidecar is present.`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

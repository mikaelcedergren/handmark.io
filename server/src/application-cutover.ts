import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  createPreparedSyncSqliteAdapter,
  type SyncSqliteDatabase,
} from '@mikaelcedergren/cx-framework/server/sqlite';

import {
  APPLICATION_IMPORT_MAX_RECORD_BYTES,
  APPLICATION_IMPORT_MAX_RECORDS,
  APPLICATION_IMPORT_MAX_SOURCE_BYTES,
} from './application-import.js';
import {
  verifyStoredImportedApplicationDatabase,
  type ApplicationImportReceipt,
} from './application-schema.js';
import { APPLICATION_DATABASE_MAX_BYTES } from './constants.js';
import {
  assertSqliteSidecarsAbsent,
  boundedCutoverDirectoryInventory,
} from './cutover-filesystem.js';

interface ImmutableDatabaseProof {
  readonly database: SyncSqliteDatabase;
  closeAndVerify(): void;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = requiredConstant(fs.constants.O_NOFOLLOW, 'O_NOFOLLOW');

/**
 * One-time pre-activation proof for the imported target and its first extracted SQLite backup.
 * The verifier never opens the legacy JSONL authority: it binds the immutable database to the
 * independently captured sealed receipt and recomputes every canonical application aggregate.
 */
export function verifyLegacyApplicationImportPreActivation(
  databasePath: string,
  expected: ApplicationImportReceipt,
): ApplicationImportReceipt {
  const proof = openImmutableDatabaseProof(databasePath);
  let result: ApplicationImportReceipt | undefined;
  let primaryError: unknown;
  try {
    result = verifyStoredImportedApplicationDatabase(proof.database, expected, {
      maxRecordBytes: APPLICATION_IMPORT_MAX_RECORD_BYTES,
      maxRecords: APPLICATION_IMPORT_MAX_RECORDS,
      maxSourceBytes: APPLICATION_IMPORT_MAX_SOURCE_BYTES,
    });
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  try {
    proof.closeAndVerify();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      'Handmark import verification and immutable close proof both failed.',
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  if (!result) throw new Error('Handmark import verification produced no receipt.');
  return result;
}

function openImmutableDatabaseProof(databasePath: string): ImmutableDatabaseProof {
  if (
    !path.isAbsolute(databasePath) ||
    path.normalize(databasePath) !== databasePath ||
    fs.realpathSync.native(databasePath) !== databasePath
  ) {
    throw new Error('Handmark import verification requires one canonical absolute database path.');
  }
  const parentPath = path.dirname(databasePath);
  const parentBefore = fs.lstatSync(parentPath, { bigint: true });
  if (
    !parentBefore.isDirectory() ||
    parentBefore.isSymbolicLink() ||
    parentBefore.uid !== BigInt(currentUid()) ||
    (parentBefore.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE) ||
    fs.realpathSync.native(parentPath) !== parentPath
  ) {
    throw new Error(
      'Handmark import verification requires one current-user-owned mode-0700 real parent directory.',
    );
  }
  const namesBefore = boundedCutoverDirectoryInventory(
    parentPath,
    'Handmark database parent inventory',
  );
  assertSqliteSidecarsAbsent(databasePath, namesBefore, 'Handmark application verification');

  const pathBefore = fs.lstatSync(databasePath, { bigint: true });
  const descriptor = fs.openSync(databasePath, fs.constants.O_RDONLY | NO_FOLLOW);
  let native: DatabaseSync | undefined;
  try {
    const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !descriptorBefore.isFile() ||
      descriptorBefore.isSymbolicLink() ||
      descriptorBefore.nlink !== 1n ||
      descriptorBefore.uid !== BigInt(currentUid()) ||
      (descriptorBefore.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
      descriptorBefore.size <= 0n ||
      descriptorBefore.size > BigInt(APPLICATION_DATABASE_MAX_BYTES) ||
      !sameStableFile(pathBefore, descriptorBefore)
    ) {
      throw new Error(
        'Handmark import verification requires one current-user-owned mode-0600 single-link database within its byte bound.',
      );
    }
    const digestBefore = hashDescriptor(descriptor, descriptorBefore.size);
    const immutable = pathToFileURL(`/dev/fd/${String(descriptor)}`);
    immutable.searchParams.set('immutable', '1');
    native = new DatabaseSync(immutable, { readOnly: true });
    native.enableDefensive(true);
    const database = createPreparedSyncSqliteAdapter(native);
    let closed = false;
    return Object.freeze({
      database,
      closeAndVerify() {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];
        try {
          native?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
          const pathAfter = fs.lstatSync(databasePath, { bigint: true });
          const parentAfter = fs.lstatSync(parentPath, { bigint: true });
          const namesAfter = boundedCutoverDirectoryInventory(
            parentPath,
            'Handmark database parent inventory',
          );
          assertSqliteSidecarsAbsent(databasePath, namesAfter, 'Handmark application verification');
          if (
            !sameStableFile(descriptorBefore, descriptorAfter) ||
            !sameStableFile(descriptorBefore, pathAfter) ||
            !sameStableDirectory(parentBefore, parentAfter) ||
            namesBefore.length !== namesAfter.length ||
            namesBefore.some((name, index) => name !== namesAfter[index]) ||
            hashDescriptor(descriptor, descriptorBefore.size) !== digestBefore
          ) {
            throw new Error(
              'Handmark import verification changed or raced its database or parent directory.',
            );
          }
        } catch (error) {
          errors.push(error);
        }
        try {
          fs.closeSync(descriptor);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Handmark immutable database proof failed to close.');
        }
      },
    });
  } catch (error) {
    const errors = [error];
    try {
      native?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      fs.closeSync(descriptor);
    } catch (closeError) {
      errors.push(closeError);
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, 'Handmark immutable database proof failed to open.');
  }
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameStableDirectory(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isDirectory() === right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashDescriptor(descriptor: number, size: bigint): string {
  if (size < 0n || size > BigInt(APPLICATION_DATABASE_MAX_BYTES)) {
    throw new Error('Handmark database exceeds the immutable verifier hashing range.');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  const total = Number(size);
  while (offset < total) {
    const length = Math.min(buffer.length, total - offset);
    const read = fs.readSync(descriptor, buffer, 0, length, offset);
    if (read === 0) throw new Error('Handmark database ended before its pinned size.');
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest('hex');
}

function requiredConstant(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`Handmark import verification requires ${name}.`);
  return value;
}

function currentUid(): number {
  if (process.geteuid === undefined) {
    throw new Error('Handmark import verification requires POSIX ownership checks.');
  }
  return process.geteuid();
}

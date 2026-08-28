import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  APPLICATION_IMPORT_MAX_RECORDS,
  APPLICATION_IMPORT_MAX_SOURCE_BYTES,
} from './application-import.js';
import { verifyLegacyApplicationImportPreActivation } from './application-cutover.js';
import {
  APPLICATION_IMPORT_FORMAT_VERSION,
  EMPTY_APPLICATION_AUTHORITY_SHA256,
  EMPTY_APPLICATION_RECORDS_SHA256,
  type ApplicationImportReceipt,
} from './application-schema.js';
import { boundedCutoverDirectoryInventory } from './cutover-filesystem.js';

const RECEIPT_MAX_BYTES = 2 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS = Object.freeze([
  'authorityKind',
  'formatVersion',
  'orderedRecordsSha256',
  'recordCount',
  'sourceBytes',
  'sourceSha256',
]);

interface VerificationArguments {
  readonly databasePath: string;
  readonly receiptPath: string;
}

export function parseApplicationImportVerificationArguments(
  arguments_: readonly string[],
): VerificationArguments {
  let databasePath: string | undefined;
  let receiptPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === '--database' && value && !value.startsWith('--') && !databasePath) {
      databasePath = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--receipt' && value && !value.startsWith('--') && !receiptPath) {
      receiptPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(
      'Usage: node server/dist/verify-application-import.js --database <imported-or-restored-database> --receipt <captured-import-receipt>',
    );
  }
  if (!databasePath || !receiptPath) {
    throw new Error(
      'Application import verification requires explicit --database and --receipt paths.',
    );
  }
  return Object.freeze({ databasePath, receiptPath });
}

export function readApplicationImportReceiptEvidence(
  receiptPath: string,
): ApplicationImportReceipt {
  const bytes = readStableReceipt(receiptPath);
  let decoded: string;
  let value: unknown;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(decoded);
  } catch {
    throw new Error('Application import receipt evidence is not canonical UTF-8 JSON.');
  }
  if (!plainObject(value) || Object.keys(value).toSorted().join(',') !== RECEIPT_KEYS.join(',')) {
    throw new Error('Application import receipt evidence has an unexpected shape.');
  }

  const authorityKind = value['authorityKind'];
  const formatVersion = value['formatVersion'];
  const orderedRecordsSha256 = value['orderedRecordsSha256'];
  const recordCount = value['recordCount'];
  const sourceBytes = value['sourceBytes'];
  const sourceSha256 = value['sourceSha256'];
  if (authorityKind !== 'legacy_jsonl_v1' && authorityKind !== 'legacy_empty_absence_v1') {
    throw new Error('Application import receipt evidence has an invalid authority kind.');
  }
  if (formatVersion !== APPLICATION_IMPORT_FORMAT_VERSION) {
    throw new Error('Application import receipt evidence has an unsupported format version.');
  }
  if (
    typeof recordCount !== 'number' ||
    !Number.isSafeInteger(recordCount) ||
    recordCount < 0 ||
    recordCount > APPLICATION_IMPORT_MAX_RECORDS
  ) {
    throw new Error('Application import receipt evidence has an invalid record count.');
  }
  if (
    typeof sourceBytes !== 'number' ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0 ||
    sourceBytes > APPLICATION_IMPORT_MAX_SOURCE_BYTES
  ) {
    throw new Error('Application import receipt evidence has an invalid source byte count.');
  }
  if (
    typeof sourceSha256 !== 'string' ||
    !SHA256_PATTERN.test(sourceSha256) ||
    typeof orderedRecordsSha256 !== 'string' ||
    !SHA256_PATTERN.test(orderedRecordsSha256)
  ) {
    throw new Error('Application import receipt evidence has an invalid aggregate hash.');
  }
  if (
    authorityKind === 'legacy_empty_absence_v1' &&
    (recordCount !== 0 ||
      sourceBytes !== 0 ||
      sourceSha256 !== EMPTY_APPLICATION_AUTHORITY_SHA256 ||
      orderedRecordsSha256 !== EMPTY_APPLICATION_RECORDS_SHA256)
  ) {
    throw new Error('Application import receipt evidence has invalid empty-authority values.');
  }

  const receipt = Object.freeze({
    authorityKind,
    formatVersion: APPLICATION_IMPORT_FORMAT_VERSION,
    orderedRecordsSha256,
    recordCount,
    sourceBytes,
    sourceSha256,
  });
  if (decoded !== `${JSON.stringify(receipt)}\n`) {
    throw new Error('Application import receipt evidence is not the canonical importer output.');
  }
  return receipt;
}

export function verifyApplicationImportEvidence(
  arguments_: readonly string[],
): ApplicationImportReceipt {
  const options = parseApplicationImportVerificationArguments(arguments_);
  const expected = readApplicationImportReceiptEvidence(options.receiptPath);
  return verifyLegacyApplicationImportPreActivation(options.databasePath, expected);
}

export function runApplicationImportVerification(arguments_: readonly string[]): void {
  const receipt = verifyApplicationImportEvidence(arguments_);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    runApplicationImportVerification(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : 'Application import proof failed safely.',
    );
    process.exitCode = 1;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStableReceipt(receiptPath: string): Buffer {
  if (
    !path.isAbsolute(receiptPath) ||
    path.normalize(receiptPath) !== receiptPath ||
    fs.realpathSync.native(receiptPath) !== receiptPath
  ) {
    throw new Error('Application import receipt evidence must use one canonical absolute path.');
  }
  const parentPath = path.dirname(receiptPath);
  const parentBefore = fs.lstatSync(parentPath, { bigint: true });
  if (
    !parentBefore.isDirectory() ||
    parentBefore.isSymbolicLink() ||
    parentBefore.uid !== BigInt(currentUid()) ||
    (parentBefore.mode & 0o777n) !== 0o700n ||
    fs.realpathSync.native(parentPath) !== parentPath
  ) {
    throw new Error(
      'Application import receipt evidence requires one current-user-owned mode-0700 real parent directory.',
    );
  }
  const namesBefore = boundedCutoverDirectoryInventory(
    parentPath,
    'Application import receipt parent inventory',
  );
  const pathBefore = fs.lstatSync(receiptPath, { bigint: true });
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow === undefined) {
    throw new Error('Application import receipt verification requires O_NOFOLLOW.');
  }
  const descriptor = fs.openSync(receiptPath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(currentUid()) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size <= 0n ||
      before.size > BigInt(RECEIPT_MAX_BYTES) ||
      !sameStableFile(pathBefore, before)
    ) {
      throw new Error(
        'Application import receipt evidence must be one current-user-owned mode-0600 single-link file within its byte bound.',
      );
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error('Application import receipt evidence ended early.');
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, extra, 0, 1, bytes.length) !== 0) {
      throw new Error('Application import receipt evidence grew while being read.');
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(receiptPath, { bigint: true });
    const parentAfter = fs.lstatSync(parentPath, { bigint: true });
    const namesAfter = boundedCutoverDirectoryInventory(
      parentPath,
      'Application import receipt parent inventory',
    );
    if (
      !sameStableFile(before, after) ||
      !sameStableFile(before, pathAfter) ||
      !sameStableDirectory(parentBefore, parentAfter) ||
      namesBefore.length !== namesAfter.length ||
      namesBefore.some((name, index) => name !== namesAfter[index])
    ) {
      throw new Error(
        'Application import receipt evidence or its private parent changed while being read.',
      );
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
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

function currentUid(): number {
  if (process.geteuid === undefined) {
    throw new Error('Application import receipt verification requires POSIX ownership checks.');
  }
  return process.geteuid();
}

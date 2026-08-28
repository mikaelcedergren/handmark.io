import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { APPLICATION_MAX_CANONICAL_BYTES } from './constants.js';

const READ_BUFFER_BYTES = 64 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW;

interface FileIdentity {
  readonly ctimeNs: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
}

interface DirectoryProof {
  readonly canonicalPath: string;
  readonly identity: DirectoryIdentity;
  readonly lexicalPath: string;
}

export type LegacyApplicationAuthorityProof =
  LegacyApplicationPresentSourceProof | LegacyApplicationAbsentSourceProof;

interface LegacyApplicationPresentSourceProof {
  readonly kind: 'present_jsonl';
  readonly sourceBytes: number;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  assertUnchanged(): void;
  close(): void;
}

interface LegacyApplicationAbsentSourceProof {
  readonly kind: 'absent';
  readonly sourcePath: string;
  assertUnchanged(): void;
  close(): void;
}

export function openLegacyApplicationAuthorityProof({
  operationalRoot,
  sourcePath,
}: {
  readonly operationalRoot: string;
  readonly sourcePath: string;
}): LegacyApplicationAuthorityProof {
  assertNormalizedAbsolutePath(operationalRoot, 'Legacy application operational root');
  assertNormalizedAbsolutePath(sourcePath, 'Legacy application source path');
  const relativeSource = path.relative(operationalRoot, sourcePath);
  if (
    !relativeSource ||
    relativeSource === '..' ||
    relativeSource.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSource)
  ) {
    throw new Error('Legacy application source must remain inside its operational root.');
  }

  const directoryProofs = inspectDirectoryChain(operationalRoot, path.dirname(sourcePath));
  const expectedCanonicalSource = path.join(directoryProofs[0].canonicalPath, relativeSource);

  let pathIdentity: FileIdentity;
  try {
    pathIdentity = inspectRegularSingleLinkSource(sourcePath, expectedCanonicalSource);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      let closed = false;
      assertAbsentSourceUnchanged(sourcePath, directoryProofs);
      return Object.freeze({
        assertUnchanged() {
          if (closed) throw new Error('Legacy application authority proof is already closed.');
          assertAbsentSourceUnchanged(sourcePath, directoryProofs);
        },
        close() {
          closed = true;
        },
        kind: 'absent' as const,
        sourcePath,
      });
    }
    throw error;
  }
  if (pathIdentity.size > BigInt(APPLICATION_MAX_CANONICAL_BYTES)) {
    throw new Error('Legacy application source exceeds the 100 MiB intake ceiling.');
  }

  const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | NO_FOLLOW);
  let closed = false;
  try {
    assertSameIdentity(pathIdentity, identityFromStats(fs.fstatSync(descriptor, { bigint: true })));
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let sourceBytes = 0;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, sourceBytes);
      if (bytesRead === 0) break;
      sourceBytes += bytesRead;
      if (sourceBytes > APPLICATION_MAX_CANONICAL_BYTES) {
        throw new Error('Legacy application source exceeds the 100 MiB intake ceiling.');
      }
      hash.update(buffer.subarray(0, bytesRead));
    }

    assertDescriptorAndPathUnchanged(
      descriptor,
      sourcePath,
      expectedCanonicalSource,
      pathIdentity,
      directoryProofs,
    );
    const sourceSha256 = hash.digest('hex');
    return Object.freeze({
      assertUnchanged() {
        if (closed) throw new Error('Legacy application source proof is already closed.');
        assertDescriptorAndPathUnchanged(
          descriptor,
          sourcePath,
          expectedCanonicalSource,
          pathIdentity,
          directoryProofs,
        );
      },
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(descriptor);
      },
      kind: 'present_jsonl' as const,
      sourceBytes,
      sourcePath,
      sourceSha256,
    });
  } catch (error) {
    fs.closeSync(descriptor);
    closed = true;
    throw error;
  }
}

function assertDescriptorAndPathUnchanged(
  descriptor: number,
  sourcePath: string,
  expectedCanonicalSource: string,
  expected: FileIdentity,
  directoryProofs: readonly DirectoryProof[],
): void {
  assertDirectoryChainUnchanged(directoryProofs);
  assertSameIdentity(expected, identityFromStats(fs.fstatSync(descriptor, { bigint: true })));
  assertSameIdentity(expected, inspectRegularSingleLinkSource(sourcePath, expectedCanonicalSource));
  assertDirectoryChainUnchanged(directoryProofs);
}

function inspectRegularSingleLinkSource(
  sourcePath: string,
  expectedCanonicalSource: string,
): FileIdentity {
  const stats = fs.lstatSync(sourcePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error('Legacy application source must be a single-link regular file.');
  }
  if (fs.realpathSync(sourcePath) !== expectedCanonicalSource) {
    throw new Error('Legacy application source escapes its operational root.');
  }
  return identityFromStats(stats);
}

function inspectDirectoryChain(
  operationalRoot: string,
  sourceDirectory: string,
): readonly [DirectoryProof, ...DirectoryProof[]] {
  const rootEntry = fs.lstatSync(operationalRoot, { bigint: true });
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error('Legacy application operational root must be a real directory.');
  }
  const canonicalRoot = fs.realpathSync(operationalRoot);
  const proofs: [DirectoryProof, ...DirectoryProof[]] = [
    directoryProof(operationalRoot, canonicalRoot, rootEntry),
  ];
  const relativeDirectory = path.relative(operationalRoot, sourceDirectory);
  let lexicalDirectory = operationalRoot;
  let canonicalDirectory = canonicalRoot;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    lexicalDirectory = path.join(lexicalDirectory, segment);
    canonicalDirectory = path.join(canonicalDirectory, segment);
    let entry: fs.BigIntStats;
    try {
      entry = fs.lstatSync(lexicalDirectory, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error('Legacy application source directory must already exist.', {
          cause: error,
        });
      }
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Legacy application source directory component is unsafe: ${lexicalDirectory}`,
      );
    }
    if (fs.realpathSync(lexicalDirectory) !== canonicalDirectory) {
      throw new Error('Legacy application source directory escapes its operational root.');
    }
    proofs.push(directoryProof(lexicalDirectory, canonicalDirectory, entry));
  }
  return Object.freeze(proofs);
}

function assertAbsentSourceUnchanged(
  sourcePath: string,
  directoryProofs: readonly DirectoryProof[],
): void {
  assertDirectoryChainUnchanged(directoryProofs);
  try {
    fs.lstatSync(sourcePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      assertDirectoryChainUnchanged(directoryProofs);
      return;
    }
    throw error;
  }
  throw new Error('Legacy application source appeared while its absence was verified.');
}

function directoryProof(
  lexicalPath: string,
  canonicalPath: string,
  stats: fs.BigIntStats,
): DirectoryProof {
  return Object.freeze({
    canonicalPath,
    identity: Object.freeze({
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
    }),
    lexicalPath,
  });
}

function assertDirectoryChainUnchanged(proofs: readonly DirectoryProof[]): void {
  for (const proof of proofs) {
    const entry = fs.lstatSync(proof.lexicalPath, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Legacy application source directory changed during receipt verification.');
    }
    if (
      entry.dev !== proof.identity.device ||
      entry.ino !== proof.identity.inode ||
      entry.mode !== proof.identity.mode ||
      fs.realpathSync(proof.lexicalPath) !== proof.canonicalPath
    ) {
      throw new Error('Legacy application source directory changed during receipt verification.');
    }
  }
}

function assertNormalizedAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be normalized and absolute.`);
  }
}

function identityFromStats(stats: fs.BigIntStats): FileIdentity {
  return Object.freeze({
    ctimeNs: stats.ctimeNs,
    device: stats.dev,
    inode: stats.ino,
    links: stats.nlink,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    size: stats.size,
  });
}

function assertSameIdentity(expected: FileIdentity, actual: FileIdentity): void {
  if (
    actual.ctimeNs !== expected.ctimeNs ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.links !== expected.links ||
    actual.mode !== expected.mode ||
    actual.mtimeNs !== expected.mtimeNs ||
    actual.size !== expected.size
  ) {
    throw new Error('Legacy application source changed while its import receipt was verified.');
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

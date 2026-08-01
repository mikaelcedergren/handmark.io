import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPLICATION_MAX_BYTES,
  APPLICATION_MAX_RECORDS,
  APPLICATION_RETENTION_DAYS,
  ApplicationStoreCapacityError,
  ApplicationStoreError,
  createApplicationStore,
  STALE_COMPACTION_TEMP_MS,
} from '../../server/application-store.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

function setup(t, { autoCleanup = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-applications-'));
  const filePath = path.join(directory, 'applications.jsonl');
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  if (autoCleanup) t.after(cleanup);
  return { cleanup, directory, filePath };
}

function application(id, createdAt = new Date(NOW).toISOString(), extra = {}) {
  return { id, createdAt, name: `Applicant ${id}`, ...extra };
}

test('production policy is fixed at 90 days, 100 MiB, and 10,000 records', () => {
  assert.equal(APPLICATION_RETENTION_DAYS, 90);
  assert.equal(APPLICATION_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(APPLICATION_MAX_RECORDS, 10_000);
});

test('compaction atomically removes applications at the 90-day boundary', async (t) => {
  const { filePath } = setup(t);
  const expired = application('expired', new Date(NOW - 90 * DAY_MS).toISOString());
  const recent = application('recent', new Date(NOW - 89 * DAY_MS).toISOString());
  fs.writeFileSync(filePath, `${JSON.stringify(expired)}\n${JSON.stringify(recent)}\n`, {
    mode: 0o600,
  });

  const store = createApplicationStore({ filePath, now: () => NOW });
  const result = await store.initialize();
  const records = fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(result.removed, 1);
  assert.deepEqual(
    records.map((record) => record.id),
    ['recent'],
  );
  assert.equal(store.stats().records, 1);
});

test('malformed input leaves the original file untouched', async (t) => {
  const { directory, filePath } = setup(t);
  const original = `${JSON.stringify(application('valid'))}\n{not-json}\n`;
  fs.writeFileSync(filePath, original, { mode: 0o600 });
  const store = createApplicationStore({ filePath, now: () => NOW });

  await assert.rejects(store.initialize(), ApplicationStoreError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['applications.jsonl']);
});

test('initialization rejects a linked main store without reading its target', async (t) => {
  const { directory, filePath } = setup(t);
  const targetPath = path.join(directory, 'outside-target.jsonl');
  const original = `${JSON.stringify(application('protected'))}\n`;
  fs.writeFileSync(targetPath, original, { mode: 0o600 });
  fs.symlinkSync(targetPath, filePath);

  const store = createApplicationStore({ filePath, now: () => NOW });

  await assert.rejects(store.initialize(), ApplicationStoreError);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), original);
  assert.equal(fs.lstatSync(filePath).isSymbolicLink(), true);
});

test('initialization rejects a multi-link regular store without changing its target', async (t) => {
  const { directory, filePath } = setup(t);
  const targetPath = path.join(directory, 'protected-target.jsonl');
  const original = `${JSON.stringify(application('protected'))}\n`;
  fs.writeFileSync(targetPath, original, { mode: 0o600 });
  fs.linkSync(targetPath, filePath);

  const store = createApplicationStore({ filePath, now: () => NOW });

  await assert.rejects(store.initialize(), ApplicationStoreError);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), original);
  assert.equal(fs.statSync(targetPath).nlink, 2);
});

test('append rejects a store replaced by a link without changing its target', async (t) => {
  const { directory, filePath } = setup(t);
  const targetPath = path.join(directory, 'outside-target.jsonl');
  fs.writeFileSync(targetPath, 'protected\n', { mode: 0o600 });
  const store = createApplicationStore({ filePath, now: () => NOW });
  await store.initialize();
  fs.symlinkSync(targetPath, filePath);

  await assert.rejects(store.append(application('linked')), ApplicationStoreError);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'protected\n');
  assert.equal(fs.lstatSync(filePath).isSymbolicLink(), true);
});

test('append rejects an equal-size hardlink swap after initialization without changing its target', async (t) => {
  const { directory, filePath } = setup(t);
  const initial = `${JSON.stringify(application('initial'))}\n`;
  fs.writeFileSync(filePath, initial, { mode: 0o600 });
  const store = createApplicationStore({ filePath, now: () => NOW });
  await store.initialize();

  const targetPath = path.join(directory, 'protected-target.jsonl');
  const protectedContents = 'p'.repeat(store.stats().bytes);
  fs.writeFileSync(targetPath, protectedContents, { mode: 0o600 });
  fs.unlinkSync(filePath);
  fs.linkSync(targetPath, filePath);
  assert.equal(fs.statSync(filePath).size, store.stats().bytes);

  await assert.rejects(store.append(application('hardlink-swap')), ApplicationStoreError);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), protectedContents);
  assert.equal(fs.statSync(targetPath).nlink, 2);
});

test('initialization rejects a linked storage directory', async (t) => {
  const { directory } = setup(t);
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-external-'));
  t.after(() => fs.rmSync(externalDirectory, { recursive: true, force: true }));
  const linkedDirectory = path.join(directory, 'linked-data');
  fs.symlinkSync(externalDirectory, linkedDirectory, 'dir');
  const store = createApplicationStore({
    filePath: path.join(linkedDirectory, 'applications.jsonl'),
    now: () => NOW,
  });

  await assert.rejects(store.initialize(), ApplicationStoreError);
  assert.deepEqual(fs.readdirSync(externalDirectory), []);
});

test('initialization removes only stale, exact-name regular compaction files', async (t) => {
  const { directory, filePath } = setup(t);
  const stalePath = path.join(
    directory,
    'applications.jsonl.compact-123-00000000-0000-4000-8000-000000000001',
  );
  const freshPath = path.join(
    directory,
    'applications.jsonl.compact-123-00000000-0000-4000-8000-000000000002',
  );
  const symlinkPath = path.join(
    directory,
    'applications.jsonl.compact-123-00000000-0000-4000-8000-000000000003',
  );
  const directoryPath = path.join(
    directory,
    'applications.jsonl.compact-123-00000000-0000-4000-8000-000000000004',
  );
  const protectedPath = path.join(directory, 'protected.txt');
  const staleTime = new Date(NOW - STALE_COMPACTION_TEMP_MS - 1);

  fs.writeFileSync(stalePath, 'stale');
  fs.utimesSync(stalePath, staleTime, staleTime);
  fs.writeFileSync(freshPath, 'fresh');
  fs.writeFileSync(protectedPath, 'protected');
  fs.symlinkSync(protectedPath, symlinkPath);
  fs.mkdirSync(directoryPath);
  fs.utimesSync(directoryPath, staleTime, staleTime);

  const store = createApplicationStore({ filePath, now: () => NOW });
  const result = await store.initialize();

  assert.equal(result.staleTempsRemoved, 1);
  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(fs.readFileSync(freshPath, 'utf8'), 'fresh');
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(fs.statSync(directoryPath).isDirectory(), true);
  assert.equal(fs.readFileSync(protectedPath, 'utf8'), 'protected');
});

test('record-count capacity rejects the next append without changing the file', async (t) => {
  const { filePath } = setup(t);
  const store = createApplicationStore({
    filePath,
    now: () => NOW,
    maxBytes: 10_000,
    maxRecords: 2,
    maxRecordBytes: 1_000,
  });
  await store.initialize();
  await store.append(application('one'));
  await store.append(application('two'));
  const before = fs.readFileSync(filePath, 'utf8');

  await assert.rejects(
    store.append(application('three')),
    (error) =>
      error instanceof ApplicationStoreCapacityError &&
      error.code === 'storage_full' &&
      error.status === 507,
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(store.stats().records, 2);
});

test('byte capacity rejects the next append without changing the file', async (t) => {
  const { filePath } = setup(t);
  const first = application('one');
  const firstBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`);
  const store = createApplicationStore({
    filePath,
    now: () => NOW,
    maxBytes: firstBytes,
    maxRecords: 10,
    maxRecordBytes: 1_000,
  });
  await store.initialize();
  await store.append(first);
  const before = fs.readFileSync(filePath, 'utf8');

  await assert.rejects(store.append(application('two')), ApplicationStoreCapacityError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(store.stats().bytes, firstBytes);
});

test('serialized concurrent writes cannot pass the record ceiling', async (t) => {
  const { filePath } = setup(t);
  const store = createApplicationStore({
    filePath,
    now: () => NOW,
    maxBytes: 10_000,
    maxRecords: 3,
    maxRecordBytes: 1_000,
  });
  await store.initialize();

  const results = await Promise.allSettled(
    ['one', 'two', 'three', 'four', 'five'].map((id) => store.append(application(id))),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(fs.readFileSync(filePath, 'utf8').trim().split('\n').length, 3);
});

test('scheduled maintenance expires records while the server is otherwise idle', async (t) => {
  const { cleanup, filePath } = setup(t, { autoCleanup: false });
  let currentTime = NOW;
  const store = createApplicationStore({
    filePath,
    retentionMs: 100,
    maxBytes: 10_000,
    maxRecords: 10,
    maxRecordBytes: 1_000,
    maintenanceIntervalMs: 5,
    now: () => currentTime,
  });
  t.after(async () => {
    await store.stopMaintenance();
    cleanup();
  });
  await store.initialize();
  await store.append(application('expires-idle'));
  currentTime += 101;
  store.startMaintenance();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(filePath, 'utf8'), '');
  assert.equal(store.stats().records, 0);
});

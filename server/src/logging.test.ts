import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseLogRecord,
  runWithLogContext,
  type LogRecord,
} from '@mikaelcedergren/cx-framework/server/logging';
import { configureHandmarkLogging } from './logging.js';
import { openApplicationRepository } from './application-repository.js';
import { createApplicationService } from './application-service.js';
import { APPLICATION_RETENTION_MS } from './constants.js';

test('health transitions stay quiet and retention does not inherit the scheduling request', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-logging-')));
  const databasePath = path.join(root, 'applications.sqlite');
  const records: LogRecord[] = [];
  configureHandmarkLogging({ NODE_ENV: 'test', CX_EXECUTION_SCOPE: 'test' }, 'synthetic-logging', {
    write(line) {
      records.push(parseLogRecord(line));
      return true;
    },
    status() {
      return { accepted: records.length, dropped: 0, failed: 0, pendingBytes: 0, available: true };
    },
  });
  let timestamp = Date.UTC(2026, 0, 1);
  let scheduled: (() => void) | undefined;
  const repository = openApplicationRepository({
    operationalRoot: root,
    databasePath,
    retentionOwner: true,
    clock: () => timestamp,
    scheduleTimer(callback) {
      scheduled = callback;
      return { unref() {} };
    },
    cancelTimer() {
      scheduled = undefined;
    },
  });
  t.after(() => {
    repository.close();
    configureHandmarkLogging({ NODE_ENV: 'test' });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createApplicationService({
    repository,
    clock: () => timestamp,
    generateId: () => 'HM-12345678',
  });
  await runWithLogContext({ requestId: 'synthetic-request-123' }, () =>
    service.submit({
      agree: true,
      billingCycle: 'monthly',
      brand: 'PRIVATE-BRAND',
      category: 'Furniture',
      contactPreference: 'Email',
      craftSummary: 'PRIVATE-CRAFT',
      email: 'private@example.com',
      name: 'PRIVATE-NAME',
      paymentPreference: 'after-approval',
      plan: 'verification',
      proofLinks: 'https://example.com/private-proof',
      walkthroughPreference: '',
      website: 'https://example.com',
    }),
  );
  assert.equal(records[0]?.event, 'application.accepted');
  assert.equal(records[0]?.requestId, 'synthetic-request-123');
  runWithLogContext({ requestId: 'synthetic-request-123' }, () => repository.startMaintenance());
  timestamp += APPLICATION_RETENTION_MS + 1;
  assert.ok(scheduled);
  runWithLogContext({ requestId: 'synthetic-request-123' }, scheduled);
  const retention = records.find((record) => record.event === 'retention.completed');
  assert.ok(retention?.runId);
  assert.equal(retention.requestId, undefined);
  assert.equal(retention.count, 1);

  fs.renameSync(databasePath, `${databasePath}.held`);
  assert.equal(repository.isReady(), false);
  assert.equal(repository.isReady(), false);
  fs.renameSync(`${databasePath}.held`, databasePath);
  assert.equal(repository.isReady(), true);
  assert.equal(repository.isReady(), true);
  assert.equal(records.filter((record) => record.event === 'storage.health_failed').length, 1);
  assert.equal(records.filter((record) => record.event === 'storage.health_recovered').length, 1);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private@example|https:|\/private\//);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestLimiter, MAX_REQUEST_BUCKETS } from '../../server/request-limiter.mjs';

test('production request tracking has a fixed cardinality ceiling', () => {
  assert.equal(MAX_REQUEST_BUCKETS, 10_000);
});

test('request tracking enforces per-key limits and fails closed at capacity', () => {
  let currentTime = 1_000;
  const limiter = createRequestLimiter({
    maxBuckets: 2,
    sweepIntervalMs: 10,
    now: () => currentTime,
  });

  assert.equal(limiter.allow('login:client-a', 2, 100), true);
  assert.equal(limiter.allow('login:client-a', 2, 100), true);
  assert.equal(limiter.allow('login:client-a', 2, 100), false);
  assert.equal(limiter.allow('apply:client-b', 2, 100), true);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.allow('login:client-c', 2, 100), false);

  currentTime += 101;
  assert.equal(limiter.allow('login:client-c', 2, 100), true);
  assert.equal(limiter.size(), 1);
});

test('scheduled sweeps remove request buckets while the server is otherwise idle', async (t) => {
  let currentTime = 1_000;
  const limiter = createRequestLimiter({
    maxBuckets: 2,
    sweepIntervalMs: 5,
    now: () => currentTime,
  });
  t.after(limiter.stopSweep);
  limiter.allow('login:client-a', 2, 10);
  currentTime += 11;
  limiter.startSweep();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(limiter.size(), 0);
});

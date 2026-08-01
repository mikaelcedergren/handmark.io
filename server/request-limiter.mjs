const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_REQUEST_BUCKETS = 10_000;

export function createRequestLimiter({
  maxBuckets = MAX_REQUEST_BUCKETS,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  now = Date.now,
} = {}) {
  for (const [name, value] of Object.entries({ maxBuckets, sweepIntervalMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }

  const buckets = new Map();
  let nextSweepAt = 0;
  let sweepTimer;

  function sweep(currentTime = now(), force = false) {
    if (!force && currentTime < nextSweepAt) return 0;
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) {
        buckets.delete(key);
        removed += 1;
      }
    }
    nextSweepAt = currentTime + sweepIntervalMs;
    return removed;
  }

  function hasCapacity(currentTime) {
    if (buckets.size < maxBuckets) return true;
    sweep(currentTime);
    return buckets.size < maxBuckets;
  }

  function allow(key, maxRequests, windowMs) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new TypeError('maxRequests must be a positive integer.');
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new TypeError('windowMs must be a positive integer.');
    }

    const currentTime = now();
    sweep(currentTime);
    const current = buckets.get(key);
    if (!current || current.resetAt <= currentTime) {
      if (current) buckets.delete(key);
      // Fail closed when every live slot is occupied. Evicting a live bucket would let rotating
      // clients erase rate-limit history.
      if (!hasCapacity(currentTime)) return false;
      buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= maxRequests;
  }

  function startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => sweep(now(), true), sweepIntervalMs);
    sweepTimer.unref();
  }

  function stopSweep() {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }

  return {
    allow,
    sweep: (force = true) => sweep(now(), force),
    size: () => buckets.size,
    startSweep,
    stopSweep,
  };
}

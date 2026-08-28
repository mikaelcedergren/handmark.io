import { readFileSync } from 'node:fs';

const configuredNow = process.env.HANDMARK_CURRENT_NOW_MS;
const clockFile = process.env.HANDMARK_CURRENT_CLOCK_FILE;

if (configuredNow !== undefined && clockFile) {
  throw new Error('Configure either HANDMARK_CURRENT_NOW_MS or HANDMARK_CURRENT_CLOCK_FILE.');
}

if (configuredNow !== undefined || clockFile) {
  const readNow = () => Number(clockFile ? readFileSync(clockFile, 'utf8') : configuredNow);
  const now = readNow();
  if (!Number.isSafeInteger(now)) {
    throw new TypeError('The current-behavior clock must contain a safe integer.');
  }
  Date.now = () => {
    const current = readNow();
    if (!Number.isSafeInteger(current)) {
      throw new TypeError('The current-behavior clock must contain a safe integer.');
    }
    return current;
  };
}

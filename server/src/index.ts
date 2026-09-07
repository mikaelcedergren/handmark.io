import { loadHandmarkEnvironmentFile } from './environment-files.js';
import { configureHandmarkLogging, handmarkLog } from './logging.js';

configureHandmarkLogging();
try {
  loadHandmarkEnvironmentFile();
  const { startHandmarkServer } = await import('./runtime.js');
  await startHandmarkServer({ entrypointUrl: import.meta.url });
} catch (error) {
  handmarkLog.emit({
    event: 'process.start_failed',
    level: 'fatal',
    category: 'diagnostic',
    outcome: 'failure',
    error,
  });
  process.exitCode = 1;
}

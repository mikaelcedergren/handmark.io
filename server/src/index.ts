import { loadHandmarkEnvironmentFile } from './environment-files.js';

loadHandmarkEnvironmentFile();

const { startHandmarkServer } = await import('./runtime.js');
await startHandmarkServer({ entrypointUrl: import.meta.url });

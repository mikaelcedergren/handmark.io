import path from 'node:path';

import { releaseValidationEnvironmentValue } from '@mikaelcedergren/cx-framework/server/configuration';
import {
  loadPrivateEnvironmentFile,
  privateEnvironmentFileStartupMode,
  UnsupportedPrivateEnvironmentKeyError,
} from '@mikaelcedergren/cx-framework/server/private-environment';

import { resolveHandmarkOperationalRoot } from './environment.js';

const HANDMARK_PRIVATE_KEYS = new Set(['HANDMARK_PASSWORD', 'SESSION_SECRET']);

export function loadHandmarkEnvironmentFile(environment: NodeJS.ProcessEnv = process.env): void {
  const releaseValidation = releaseValidationEnvironmentValue(environment);
  if (releaseValidation) {
    for (const name of HANDMARK_PRIVATE_KEYS) delete environment[name];
    resolveHandmarkOperationalRoot(environment);
    return;
  }
  const mode = privateEnvironmentFileStartupMode({
    bypassKey: 'HANDMARK_LOAD_ENV_FILE',
    environment,
  });
  if (mode === 'skip') return;

  const operationalRoot = resolveHandmarkOperationalRoot(environment);
  try {
    loadPrivateEnvironmentFile({
      allowedKeys: HANDMARK_PRIVATE_KEYS,
      environment,
      file: path.join(operationalRoot, '.env.web'),
      mode,
    });
  } catch (error) {
    if (error instanceof UnsupportedPrivateEnvironmentKeyError) {
      throw new Error(
        `Handmark .env.web contains a value outside its private allowlist: ${error.key}.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

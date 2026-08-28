import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  localBindHost,
  nodeEnvironmentValue,
  portEnvironmentValue,
  releaseValidationEnvironmentValue,
  type Environment,
} from '@mikaelcedergren/cx-framework/server/configuration';
import { normalizeHttpOrigin } from '@mikaelcedergren/cx-framework/server/origin';
import { randomBase64UrlIdentifier } from '@mikaelcedergren/cx-framework/server/signing';

import { HANDMARK_PUBLIC_ORIGIN, HANDMARK_WWW_ORIGIN } from './constants.js';

export const HANDMARK_MANIFEST_FILE = fileURLToPath(
  new URL('../../cx-product.json', import.meta.url),
);
export const HANDMARK_ARTIFACT_ROOT = path.dirname(HANDMARK_MANIFEST_FILE);

export interface HandmarkEnvironment {
  readonly appOrigin: string;
  readonly browserDirOverride: string | undefined;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly gatePassword: string;
  readonly host: string;
  readonly isProduction: boolean;
  readonly legacyApplicationsPath: string;
  readonly mutationOrigins: readonly string[];
  readonly operationalRoot: string;
  readonly port: number;
  readonly releaseValidation: boolean;
  readonly sessionSecret: string;
}

export function resolveHandmarkOperationalRoot(environment: Environment): string {
  const nodeEnvironment = nodeEnvironmentValue(environment);
  const validation = releaseValidationEnvironmentValue(environment);
  const override = environment['CX_RUNTIME_ROOT'];
  if (override !== undefined && !validation) {
    throw new Error('CX_RUNTIME_ROOT is reserved for CX_RELEASE_VALIDATION=1.');
  }
  if (validation && override === undefined) {
    throw new Error('CX_RELEASE_VALIDATION=1 requires an absolute CX_RUNTIME_ROOT.');
  }
  if (override !== undefined && (!override || !path.isAbsolute(override))) {
    throw new Error('CX_RUNTIME_ROOT must be absolute during release validation.');
  }
  return realpathSync.native(path.resolve(override ?? process.cwd()));
}

export function loadHandmarkEnvironment(
  environment: Environment = process.env,
): HandmarkEnvironment {
  const nodeEnvironment = nodeEnvironmentValue(environment);
  const releaseValidation = releaseValidationEnvironmentValue(environment);
  const operationalRoot = resolveHandmarkOperationalRoot(environment);
  const isProduction = nodeEnvironment === 'production';
  const port = portEnvironmentValue(environment, 'PORT', 3000);
  const host = localBindHost(environment);
  // Validation owns no operator credential: fresh unreachable values keep the real auth stack
  // composable without turning a development default into a release-validation bypass.
  const gatePassword = releaseValidation
    ? randomBase64UrlIdentifier(32)
    : (environment['HANDMARK_PASSWORD'] ??
      (isProduction ? '' : 'handmark-local-development-password'));
  const sessionSecret = releaseValidation
    ? randomBase64UrlIdentifier(32)
    : (environment['SESSION_SECRET'] ??
      (isProduction ? '' : 'handmark-local-development-session-secret'));

  if (gatePassword.length < 12) {
    throw new Error('HANDMARK_PASSWORD must contain at least 12 characters.');
  }
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }

  const configuredOrigin = environment['APP_BASE_URL'];
  const expectedProductionOrigin = releaseValidation ? 'http://127.0.0.1' : HANDMARK_PUBLIC_ORIGIN;
  if (isProduction && configuredOrigin !== expectedProductionOrigin) {
    throw new Error(`APP_BASE_URL must be exactly ${expectedProductionOrigin} in production.`);
  }
  const appOrigin = normalizeHttpOrigin(configuredOrigin ?? `http://127.0.0.1:${String(port)}`);
  const mutationOrigins = Object.freeze(
    isProduction && !releaseValidation
      ? [HANDMARK_PUBLIC_ORIGIN, HANDMARK_WWW_ORIGIN]
      : [appOrigin],
  );

  const defaultDataDirectory = isProduction || releaseValidation ? 'data' : '.run/dev/data';
  const dataDirectory = resolveMutablePath(
    operationalRoot,
    environment['DATA_DIR'] ?? defaultDataDirectory,
    'DATA_DIR',
  );
  const databasePath = resolveMutablePath(
    operationalRoot,
    environment['DB_PATH'] ?? path.join(dataDirectory, 'handmark.sqlite'),
    'DB_PATH',
  );
  const legacyApplicationsPath = path.join(dataDirectory, 'applications.jsonl');
  const browserDirOverride = environment['SITE_BROWSER_DIR'];
  if (browserDirOverride !== undefined) {
    if (!path.isAbsolute(browserDirOverride)) {
      throw new Error('SITE_BROWSER_DIR must be absolute when it is set.');
    }
    if (isProduction && !releaseValidation) {
      throw new Error('SITE_BROWSER_DIR is available only to development and release validation.');
    }
    if (releaseValidation) {
      assertContainedPath(operationalRoot, browserDirOverride, 'SITE_BROWSER_DIR');
    }
  }

  return Object.freeze({
    appOrigin,
    browserDirOverride,
    dataDirectory,
    databasePath,
    gatePassword,
    host,
    isProduction,
    legacyApplicationsPath,
    mutationOrigins,
    operationalRoot,
    port,
    releaseValidation,
    sessionSecret,
  });
}

function resolveMutablePath(root: string, configured: string, name: string): string {
  if (!configured || configured !== configured.trim() || /[\u0000-\u001f\u007f]/.test(configured)) {
    throw new Error(`${name} must be a non-empty safe path.`);
  }
  const resolved = path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(root, configured);
  assertContainedPath(root, resolved, name);
  return resolved;
}

function assertContainedPath(root: string, candidate: string, name: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must remain inside the operational root.`);
  }
}

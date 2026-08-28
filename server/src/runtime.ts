import type { Server } from 'node:http';

import { loadProductManifestFile } from '@mikaelcedergren/cx-framework/server/product-manifest';
import { assertServerProcessRole } from '@mikaelcedergren/cx-framework/server/process-role';
import { listenHttpApplication } from '@mikaelcedergren/cx-framework/server/listen';
import {
  loadServerReleaseIdentity,
  type ServerReleaseIdentity,
} from '@mikaelcedergren/cx-framework/server/server-identity';
import {
  bindShutdownSignals,
  createGracefulShutdown,
  type GracefulShutdown,
} from '@mikaelcedergren/cx-framework/server/shutdown';
import { assertBrowserServingForStartup } from '@mikaelcedergren/cx-framework/server/static-files';

import { createHandmarkApplication } from './app.js';
import { openApplicationRepository, type ApplicationRepository } from './application-repository.js';
import { createHandmarkBrowserServing } from './browser-serving.js';
import {
  HANDMARK_ARTIFACT_ROOT,
  HANDMARK_MANIFEST_FILE,
  loadHandmarkEnvironment,
  type HandmarkEnvironment,
} from './environment.js';
import { openLegacyApplicationSourceProof } from './legacy-cutover.js';
import { assertHandmarkProductManifest } from './product-contract.js';

export interface HandmarkRuntime {
  readonly environment: HandmarkEnvironment;
  readonly identity: ServerReleaseIdentity | undefined;
  readonly repository: ApplicationRepository;
  readonly server: Server;
  readonly shutdown: GracefulShutdown;
}

export async function startHandmarkServer({
  entrypointUrl,
  environment: sourceEnvironment = process.env,
}: {
  readonly entrypointUrl: string | URL;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<HandmarkRuntime> {
  const environment = loadHandmarkEnvironment(sourceEnvironment);
  const { manifest } = loadProductManifestFile(HANDMARK_MANIFEST_FILE);
  assertHandmarkProductManifest(manifest);

  const identity = loadServerReleaseIdentity({
    environment: sourceEnvironment,
    required: environment.isProduction || environment.releaseValidation,
  });
  if (identity) {
    assertServerProcessRole({
      artifactRoot: HANDMARK_ARTIFACT_ROOT,
      entrypointUrl,
      identity,
      role: { kind: 'web' },
    });
  }

  const configuredBrowserServing = createHandmarkBrowserServing(environment);
  assertBrowserServingForStartup({
    browserServing: configuredBrowserServing,
    environment: sourceEnvironment,
  });

  const legacySource = openLegacyApplicationSourceProof({
    operationalRoot: environment.operationalRoot,
    sourcePath: environment.legacyApplicationsPath,
  });
  let repository: ApplicationRepository | undefined;
  let repositoryOpen = false;
  try {
    const openedRepository = openApplicationRepository({
      databasePath: environment.databasePath,
      operationalRoot: environment.operationalRoot,
      requireLegacyImportReceipt: environment.isProduction && !environment.releaseValidation,
      ...(legacySource === undefined
        ? {}
        : {
            requiredLegacyImportSource: {
              sourceBytes: legacySource.sourceBytes,
              sourceSha256: legacySource.sourceSha256,
            },
          }),
    });
    repository = openedRepository;
    repositoryOpen = true;
    try {
      legacySource?.assertUnchanged();
    } finally {
      legacySource?.close();
    }
    const app = createHandmarkApplication({
      browserServing: configuredBrowserServing,
      environment,
      repository: openedRepository,
      ...(identity === undefined ? {} : { identity }),
    });
    const server = await listenHttpApplication(app, {
      host: environment.host,
      port: environment.port,
    });
    const httpShutdown = createGracefulShutdown({ server, timeoutMs: 10_000 });
    try {
      const removed = openedRepository.pruneExpired(Date.now());
      if (removed > 0) {
        console.info('[handmark] expired applications removed', { count: removed });
      }
      openedRepository.startMaintenance();
    } catch (error) {
      try {
        await httpShutdown.close('startup_failure');
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'Handmark startup retention and listener cleanup both failed.',
        );
      }
      throw error;
    }
    console.info(`[handmark] listening on http://${environment.host}:${String(environment.port)}`);
    let closing: Promise<void> | undefined;
    let disposeSignals = (): void => undefined;
    const shutdown: GracefulShutdown = {
      get closing() {
        return closing !== undefined;
      },
      close(reason = 'shutdown') {
        if (closing) return closing;
        console.info(`[handmark] shutting down (${reason})`);
        openedRepository.stopMaintenance();
        closing = httpShutdown.close(reason).finally(() => {
          disposeSignals();
          if (repositoryOpen) {
            repositoryOpen = false;
            openedRepository.close();
          }
        });
        return closing;
      },
    };
    try {
      disposeSignals = bindShutdownSignals({
        onError(error) {
          console.error('[handmark] shutdown failed', error);
          process.exitCode = 1;
        },
        shutdown,
        signals: process,
      });
    } catch (error) {
      server.close();
      openedRepository.stopMaintenance();
      openedRepository.close();
      repositoryOpen = false;
      throw error;
    }
    return Object.freeze({
      environment,
      identity,
      repository: openedRepository,
      server,
      shutdown,
    });
  } catch (error) {
    legacySource?.close();
    if (repositoryOpen && repository) {
      repository.stopMaintenance();
      repository.close();
    }
    throw error;
  }
}

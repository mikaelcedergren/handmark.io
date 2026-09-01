import path from 'node:path';

import {
  createBrowserServing,
  createSinglePageApplicationMiddlewareStack,
  type BrowserServing,
} from '@mikaelcedergren/cx-framework/server/static-files';
import express from 'express';

import type { HandmarkEnvironment } from './environment.js';

export function createHandmarkBrowserServing(environment: HandmarkEnvironment): BrowserServing {
  return createBrowserServing({
    express,
    repoRoot: environment.operationalRoot,
    defaultBrowserDir: path.join(environment.operationalRoot, 'dist', 'browser'),
    ...(environment.browserDirOverride === undefined
      ? {}
      : { browserDirOverride: environment.browserDirOverride }),
  });
}

export function mountHandmarkBrowser(
  app: express.Express,
  environment: HandmarkEnvironment,
  browserServing: BrowserServing,
): void {
  for (const middleware of createSinglePageApplicationMiddlewareStack({
    browserServing,
    repoRoot: environment.operationalRoot,
  })) {
    app.use(middleware);
  }
}

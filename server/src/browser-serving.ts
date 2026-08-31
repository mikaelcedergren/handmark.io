import path from 'node:path';

import { missingAssetMiddleware } from '@mikaelcedergren/cx-framework/server/security';
import {
  createBrowserServing,
  retainedReleaseAssetMiddleware,
  staticFileOptions,
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
  app.use(browserServing.staticMiddleware(staticFileOptions()));
  if (browserServing.useReleaseHistory) {
    app.use(retainedReleaseAssetMiddleware({ repoRoot: environment.operationalRoot }));
  }
  app.use(missingAssetMiddleware());
  app.use((request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method) || request.path.startsWith('/api')) {
      next();
      return;
    }
    try {
      browserServing.sendFileForRequest(request, response, 'index.html');
    } catch (error) {
      next(error);
    }
  });
}

import compression from 'compression';
import { serializeCookie } from '@mikaelcedergren/cx-framework/server/cookies';
import {
  apiNotFoundMiddleware,
  jsonErrorMiddleware,
  notFoundError,
} from '@mikaelcedergren/cx-framework/server/errors';
import { createSiteGate } from '@mikaelcedergren/cx-framework/server/gate';
import { healthMiddleware } from '@mikaelcedergren/cx-framework/server/health';
import { createOriginGuard } from '@mikaelcedergren/cx-framework/server/origin';
import {
  createBoundedRateLimiter,
  rateLimitMiddleware,
} from '@mikaelcedergren/cx-framework/server/rate-limit';
import { requestIdMiddleware } from '@mikaelcedergren/cx-framework/server/request-id';
import {
  hardenApplication,
  noStoreHeader,
  securityHeaders,
} from '@mikaelcedergren/cx-framework/server/security';
import {
  SERVER_IDENTITY_PATH,
  serverReleaseIdentityMiddleware,
  type ServerReleaseIdentity,
} from '@mikaelcedergren/cx-framework/server/server-identity';
import type { BrowserServing } from '@mikaelcedergren/cx-framework/server/static-files';
import express, { type NextFunction, type Request, type Response } from 'express';

import type { ApplicationRepository } from './application-repository.js';
import {
  createApplicationService,
  type ApplicationService,
  type ApplicationServiceOptions,
} from './application-service.js';
import {
  HANDMARK_GATE_COOKIE,
  HANDMARK_GATE_MAX_AGE_SECONDS,
  HANDMARK_GATE_PATH,
  HANDMARK_GATE_PUBLIC_PATHS,
  HANDMARK_PRODUCT_ID,
} from './constants.js';
import { mountHandmarkBrowser } from './browser-serving.js';
import type { HandmarkEnvironment } from './environment.js';
import { HANDMARK_GATE_PRESENTATION } from './gate-presentation.js';

export interface HandmarkApplicationOptions {
  readonly applicationService?: ApplicationService;
  readonly browserServing: BrowserServing;
  readonly environment: HandmarkEnvironment;
  readonly identity?: ServerReleaseIdentity;
  readonly onInternalError?: (error: unknown, request: unknown) => void;
  readonly repository: ApplicationRepository;
  readonly serviceOptions?: Omit<ApplicationServiceOptions, 'repository'>;
}

export function createHandmarkApplication({
  applicationService,
  browserServing,
  environment,
  identity,
  onInternalError = defaultInternalErrorLogger,
  repository,
  serviceOptions = {},
}: HandmarkApplicationOptions): express.Express {
  const app = express();
  hardenApplication(app);
  app.use(securityHeaders());
  app.use(requestIdMiddleware());
  app.use(compression());

  app.get(
    '/healthz',
    healthMiddleware(HANDMARK_PRODUCT_ID, environment.port, () => repository.isReady()),
  );
  if (identity) app.get(SERVER_IDENTITY_PATH, serverReleaseIdentityMiddleware(identity));
  app.use('/api', noStoreHeader());

  const gate = createSiteGate({
    cookieName: HANDMARK_GATE_COOKIE,
    gatePath: HANDMARK_GATE_PATH,
    maxAgeSeconds: HANDMARK_GATE_MAX_AGE_SECONDS,
    password: environment.gatePassword,
    presentation: HANDMARK_GATE_PRESENTATION,
    publicPaths: HANDMARK_GATE_PUBLIC_PATHS,
    secret: environment.sessionSecret,
    siteName: 'Handmark',
  });
  app.use(gate.middleware());

  // Authentication owns the first decision: a locked API request remains a 401 even when the
  // unauthenticated client also omits Origin. Every mutation that reaches product code is then
  // required to prove one exact official origin.
  app.use(
    createOriginGuard({
      allowedOrigins: environment.mutationOrigins,
    }),
  );

  app.post('/logout', (_request, response) => {
    response.setHeader(
      'Set-Cookie',
      serializeCookie(HANDMARK_GATE_COOKIE, '', {
        expires: new Date(0),
        maxAgeSeconds: 0,
      }),
    );
    response.redirect(302, HANDMARK_GATE_PATH);
  });

  const intakeLimiter = createBoundedRateLimiter({
    limit: 30,
    maxKeys: 10_000,
    windowMs: 60 * 60 * 1_000,
  });
  const service = applicationService ?? createApplicationService({ repository, ...serviceOptions });
  app.post(
    '/api/apply',
    express.json({ limit: '64kb' }),
    rateLimitMiddleware({
      code: 'application_rate_limited',
      key: (request) => request.ip ?? 'unknown-client',
      limiter: intakeLimiter,
      message: 'Too many applications. Try again later.',
    }),
    (request: Request, response: Response, next: NextFunction) => {
      void service
        .submit(request.body)
        .then((result) => response.status(201).json(result))
        .catch(next);
    },
  );
  app.use('/api', apiNotFoundMiddleware());

  mountHandmarkBrowser(app, environment, browserServing);

  app.use((request, _response, next) => {
    next(notFoundError(request.originalUrl));
  });
  app.use(jsonErrorMiddleware({ onInternalError }));
  return app;
}

function defaultInternalErrorLogger(error: unknown, request: unknown): void {
  const context =
    request && typeof request === 'object'
      ? (request as {
          readonly method?: unknown;
          readonly path?: unknown;
          readonly requestId?: unknown;
        })
      : {};
  console.error('[handmark] unhandled request error', {
    error,
    method: typeof context.method === 'string' ? context.method : undefined,
    path: typeof context.path === 'string' ? context.path : undefined,
    requestId: typeof context.requestId === 'string' ? context.requestId : undefined,
  });
}

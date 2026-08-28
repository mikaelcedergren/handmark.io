import { createExactOriginFetch } from '@mikaelcedergren/cx-framework/platform/e2e-runner';

const allowedOrigin = process.env['CX_TEST_ALLOWED_ORIGIN'];
if (!allowedOrigin) throw new Error('Handmark test fetch guard requires its exact allowed origin.');
globalThis.fetch = createExactOriginFetch(globalThis.fetch.bind(globalThis), allowedOrigin);

import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '@mikaelcedergren/cx-framework/server/errors';

import { validateApplicationSubmission } from './application-validation.js';

const validSubmission = Object.freeze({
  agree: true,
  billingCycle: 'monthly',
  brand: 'Human studio',
  category: 'Furniture',
  contactPreference: 'Email',
  craftSummary: 'Built by hand.',
  email: 'maker@example.com',
  name: 'Human maker',
  paymentPreference: 'after-approval',
  plan: 'verification',
  proofLinks: 'https://example.com/proof',
  website: 'https://example.com',
});

test('application validation preserves the characterized first-error order', () => {
  assert.throws(
    () =>
      validateApplicationSubmission({
        ...validSubmission,
        brand: '',
        contactPreference: '',
        email: 'not-an-email',
        name: '',
        website: '',
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === 'invalid_application' &&
      error.message === 'name is required.',
  );

  assert.throws(
    () => validateApplicationSubmission({ ...validSubmission, brand: '', email: 'not-an-email' }),
    (error: unknown) =>
      error instanceof HttpError && error.message === 'Enter a valid email address.',
  );
});

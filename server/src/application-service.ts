import { randomBytes } from 'node:crypto';

import { HttpError } from '@mikaelcedergren/cx-framework/server/errors';

import {
  ApplicationStorageCapacityError,
  ApplicationStorageError,
  type ApplicationRepository,
} from './application-repository.js';
import type { ApplicationRecord } from './application-record.js';
import { validateApplicationSubmission } from './application-validation.js';
import { APPLICATION_STORAGE_FULL_MESSAGE, APPLICATION_SUCCESS_MESSAGE } from './constants.js';

const APPLICATION_ID_ATTEMPTS = 32;

export interface ApplicationSubmissionResult {
  readonly id: string;
  readonly message: string;
  readonly ok: true;
}

export interface ApplicationServiceOptions {
  readonly clock?: () => number;
  readonly generateId?: () => string;
  readonly repository: Pick<ApplicationRepository, 'append'>;
}

export interface ApplicationService {
  submit(payload: unknown): Promise<ApplicationSubmissionResult>;
}

export function createApplicationService({
  clock = Date.now,
  generateId = defaultApplicationId,
  repository,
}: ApplicationServiceOptions): ApplicationService {
  if (!repository || typeof repository.append !== 'function') {
    throw new Error('Application service requires a repository.');
  }

  return Object.freeze({
    async submit(payload: unknown): Promise<ApplicationSubmissionResult> {
      const submission = validateApplicationSubmission(payload);
      const acceptedAt = clock();
      if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
        throw new Error('Application clock must return non-negative epoch milliseconds.');
      }
      const createdAt = new Date(acceptedAt).toISOString();

      try {
        for (let attempt = 0; attempt < APPLICATION_ID_ATTEMPTS; attempt += 1) {
          const id = validateGeneratedId(generateId());
          const record: ApplicationRecord = Object.freeze({
            id,
            createdAt,
            plan: submission.plan,
            billingCycle: submission.billingCycle,
            name: submission.name,
            email: submission.email,
            contactPreference: submission.contactPreference,
            brand: submission.brand,
            website: submission.website,
            category: submission.category,
            craftSummary: submission.craftSummary,
            proofLinks: submission.proofLinks,
            walkthroughPreference: submission.walkthroughPreference,
            paymentPreference: submission.paymentPreference,
          });
          const sequence = await repository.append(record, acceptedAt);
          if (sequence !== undefined) {
            return Object.freeze({ id, message: APPLICATION_SUCCESS_MESSAGE, ok: true });
          }
        }
      } catch (error) {
        if (error instanceof ApplicationStorageCapacityError) {
          throw new HttpError({
            cause: error,
            code: 'storage_full',
            message: APPLICATION_STORAGE_FULL_MESSAGE,
            status: 507,
          });
        }
        if (error instanceof ApplicationStorageError) {
          throw new HttpError({
            cause: error,
            code: 'application_storage_error',
            message:
              'Application storage needs administrator attention. No application was written.',
            status: 503,
          });
        }
        throw error;
      }

      throw new HttpError({
        code: 'application_id_unavailable',
        message: 'Could not create a unique application id. Please try again.',
        status: 503,
      });
    },
  });
}

function defaultApplicationId(): string {
  return `HM-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function validateGeneratedId(value: string): string {
  if (!/^HM-[0-9A-F]{8}$/.test(value)) {
    throw new Error('Application id generator returned an invalid Handmark id.');
  }
  return value;
}

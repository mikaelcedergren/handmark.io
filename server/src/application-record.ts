import { sha256Hex } from '@mikaelcedergren/cx-framework/server/signing';

export const APPLICATION_RECORD_FIELDS = Object.freeze([
  'id',
  'createdAt',
  'plan',
  'billingCycle',
  'name',
  'email',
  'contactPreference',
  'brand',
  'website',
  'category',
  'craftSummary',
  'proofLinks',
  'walkthroughPreference',
  'paymentPreference',
] as const);

export interface ApplicationRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly plan: string;
  readonly billingCycle: string;
  readonly name: string;
  readonly email: string;
  readonly contactPreference: string;
  readonly brand: string;
  readonly website: string;
  readonly category: string;
  readonly craftSummary: string;
  readonly proofLinks: string;
  readonly walkthroughPreference: string;
  readonly paymentPreference: string;
}

export function canonicalApplicationRecordBytes(record: ApplicationRecord): Buffer {
  return Buffer.from(
    JSON.stringify(
      Object.fromEntries(APPLICATION_RECORD_FIELDS.map((field) => [field, record[field]])),
    ),
    'utf8',
  );
}

export function applicationRecordHash(record: ApplicationRecord): string {
  return sha256Hex(canonicalApplicationRecordBytes(record));
}

/** Match the UTF-8 replacement semantics used by node:sqlite for TEXT bindings. */
export function sqliteTextProjection(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}

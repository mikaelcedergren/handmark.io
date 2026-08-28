import { HttpError } from '@mikaelcedergren/cx-framework/server/errors';

export interface ValidatedApplicationSubmission {
  readonly billingCycle: 'monthly';
  readonly brand: string;
  readonly category: string;
  readonly contactPreference: string;
  readonly craftSummary: string;
  readonly email: string;
  readonly name: string;
  readonly paymentPreference: 'after-approval';
  readonly plan: 'verification';
  readonly proofLinks: string;
  readonly walkthroughPreference: string;
  readonly website: string;
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateApplicationSubmission(payload: unknown): ValidatedApplicationSubmission {
  const source = isRecord(payload) ? payload : {};
  const plan = requiredField(source, 'plan', 32);
  if (plan !== 'verification') invalid('Choose a valid plan.');
  if (source['agree'] !== true) invalid('Agreement is required.');

  const billingCycle = requiredField(source, 'billingCycle', 32);
  if (billingCycle !== 'monthly') invalid('Choose a valid billing cycle.');
  const paymentPreference = requiredField(source, 'paymentPreference', 32);
  if (paymentPreference !== 'after-approval') {
    invalid('Choose a valid payment preference.');
  }

  // Keep the historical first-error order stable even though the returned object's key order is
  // separately fixed by the canonical application-record serializer.
  const name = requiredField(source, 'name', 200);
  const email = requiredEmail(source);
  const contactPreference = requiredField(source, 'contactPreference', 500);
  const brand = requiredField(source, 'brand', 200);
  const website = requiredField(source, 'website', 2_048);
  const category = requiredField(source, 'category', 200);
  const craftSummary = requiredField(source, 'craftSummary', 10_000);
  const proofLinks = requiredField(source, 'proofLinks', 10_000);
  const walkthroughPreference = optionalField(source, 'walkthroughPreference', 1_000);

  return Object.freeze({
    billingCycle,
    brand,
    category,
    contactPreference,
    craftSummary,
    email,
    name,
    paymentPreference,
    plan,
    proofLinks,
    walkthroughPreference,
    website,
  });
}

function requiredEmail(source: Readonly<Record<string, unknown>>): string {
  const value = requiredField(source, 'email', 254);
  if (!EMAIL_PATTERN.test(value)) invalid('Enter a valid email address.');
  return value;
}

function requiredField(
  source: Readonly<Record<string, unknown>>,
  field: string,
  maxLength: number,
): string {
  const raw = source[field];
  if (typeof raw !== 'string') invalid(`${field} must be text.`);
  const value = raw.trim();
  if (!value) invalid(`${field} is required.`);
  if (value.length > maxLength) invalid(`${field} is too long.`);
  return value;
}

function optionalField(
  source: Readonly<Record<string, unknown>>,
  field: string,
  maxLength: number,
): string {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') invalid(`${field} must be text.`);
  const value = raw.trim();
  if (value.length > maxLength) invalid(`${field} is too long.`);
  return value;
}

function invalid(message: string): never {
  throw new HttpError({ code: 'invalid_application', message, status: 400 });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

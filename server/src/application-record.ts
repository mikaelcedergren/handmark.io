import { createHash } from 'node:crypto';
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

export type ApplicationRecordField = (typeof APPLICATION_RECORD_FIELDS)[number];

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

export type ApplicationRecordParseCode = 'invalid_json' | 'invalid_record';

export class ApplicationRecordParseError extends Error {
  readonly code: ApplicationRecordParseCode;
  readonly field: string | undefined;

  constructor(
    code: ApplicationRecordParseCode,
    message: string,
    options: { readonly cause?: unknown; readonly field?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApplicationRecordParseError';
    this.code = code;
    this.field = options.field;
  }
}

const APPLICATION_FIELD_SET = new Set<string>(APPLICATION_RECORD_FIELDS);
const APPLICATION_ID_PATTERN = /^HM-[0-9A-F]{8}$/;
const REQUIRED_TRIMMED_FIELDS = Object.freeze([
  'name',
  'email',
  'contactPreference',
  'brand',
  'category',
  'craftSummary',
  'paymentPreference',
] as const satisfies readonly ApplicationRecordField[]);
const OPTIONAL_TRIMMED_FIELDS = Object.freeze([
  'website',
  'proofLinks',
  'walkthroughPreference',
] as const satisfies readonly ApplicationRecordField[]);

/**
 * Parse the union of records that Handmark's committed JSONL writers could persist.
 * This deliberately does not apply today's stricter form-validation policy retroactively.
 */
export function parseHistoricalApplicationRecord(source: string): ApplicationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ApplicationRecordParseError('invalid_json', 'Application record is not valid JSON.', {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new ApplicationRecordParseError(
      'invalid_record',
      'Application record must be a JSON object.',
    );
  }

  const physicalKeys = rootObjectKeys(source);
  const observedKeys = new Set<string>();
  for (const key of physicalKeys) {
    if (observedKeys.has(key)) {
      throw invalidField(key, `Application record contains duplicate field ${key}.`);
    }
    observedKeys.add(key);
  }

  for (const key of physicalKeys) {
    if (!APPLICATION_FIELD_SET.has(key)) {
      throw invalidField(key, `Application record contains unknown field ${key}.`);
    }
  }
  for (const field of APPLICATION_RECORD_FIELDS) {
    if (!Object.hasOwn(parsed, field)) {
      throw invalidField(field, `Application record is missing field ${field}.`);
    }
  }
  if (physicalKeys.length !== APPLICATION_RECORD_FIELDS.length) {
    throw new ApplicationRecordParseError(
      'invalid_record',
      'Application record does not have the exact historical field set.',
    );
  }

  for (const field of APPLICATION_RECORD_FIELDS) {
    if (typeof parsed[field] !== 'string') {
      throw invalidField(field, `Application field ${field} must be a string.`);
    }
  }

  const candidate = parsed as unknown as ApplicationRecord;
  if (!APPLICATION_ID_PATTERN.test(candidate.id)) {
    throw invalidField('id', 'Application id is not in the historical Handmark format.');
  }
  if (!isCanonicalTimestamp(candidate.createdAt)) {
    throw invalidField('createdAt', 'Application createdAt is not a canonical UTC timestamp.');
  }
  if (candidate.plan !== 'verification') {
    throw invalidField('plan', 'Application plan is not part of the historical writer contract.');
  }

  // The two earliest writers used String(payload.billingCycle || 'monthly') without trim or
  // validation. Truthy arrays and objects could therefore persist empty, whitespace, or arbitrary
  // string projections. Every string is historical here, including an empty string.
  assertString(candidate.billingCycle, 'billingCycle');

  for (const field of REQUIRED_TRIMMED_FIELDS) {
    const value = candidate[field];
    if (value.length === 0 || value.trim() !== value) {
      throw invalidField(field, `Application field ${field} is not a persisted required value.`);
    }
  }
  for (const field of OPTIONAL_TRIMMED_FIELDS) {
    const value = candidate[field];
    if (value.trim() !== value) {
      throw invalidField(field, `Application field ${field} is not a persisted optional value.`);
    }
  }

  return Object.freeze({
    id: candidate.id,
    createdAt: candidate.createdAt,
    plan: candidate.plan,
    billingCycle: candidate.billingCycle,
    name: candidate.name,
    email: candidate.email,
    contactPreference: candidate.contactPreference,
    brand: candidate.brand,
    website: candidate.website,
    category: candidate.category,
    craftSummary: candidate.craftSummary,
    proofLinks: candidate.proofLinks,
    walkthroughPreference: candidate.walkthroughPreference,
    paymentPreference: candidate.paymentPreference,
  });
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

export function orderedApplicationRecordHash(records: readonly ApplicationRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) hash.update(`${applicationRecordHash(record)}\n`, 'ascii');
  return hash.digest('hex');
}

/** Match the UTF-8 replacement semantics used by node:sqlite for TEXT bindings. */
export function sqliteTextProjection(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}

function assertString(value: string, field: ApplicationRecordField): void {
  if (typeof value !== 'string') {
    throw invalidField(field, `Application field ${field} must be a string.`);
  }
}

function invalidField(field: string, message: string): ApplicationRecordParseError {
  return new ApplicationRecordParseError('invalid_record', message, { field });
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON.parse intentionally accepts duplicate keys, so inspect the valid root object spelling too. */
function rootObjectKeys(source: string): readonly string[] {
  let index = skipWhitespace(source, 0);
  if (source[index] !== '{') return [];
  index += 1;
  const keys: string[] = [];

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === '}') return keys;

    const keyStart = index;
    const keyEnd = jsonStringEnd(source, keyStart);
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as unknown;
    if (typeof key !== 'string') {
      throw new ApplicationRecordParseError(
        'invalid_json',
        'Application record contains an invalid JSON object key.',
      );
    }
    keys.push(key);
    index = skipWhitespace(source, keyEnd);
    if (source[index] !== ':') {
      throw new ApplicationRecordParseError(
        'invalid_json',
        'Application record contains an invalid JSON object member.',
      );
    }
    index = jsonRootValueEnd(source, index + 1);
    index = skipWhitespace(source, index);
    if (source[index] === ',') {
      index += 1;
      continue;
    }
    if (source[index] === '}') return keys;
    throw new ApplicationRecordParseError(
      'invalid_json',
      'Application record contains an invalid JSON object delimiter.',
    );
  }

  return keys;
}

function jsonStringEnd(source: string, start: number): number {
  if (source[start] !== '"') {
    throw new ApplicationRecordParseError(
      'invalid_json',
      'Application record contains a non-string JSON object key.',
    );
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  throw new ApplicationRecordParseError(
    'invalid_json',
    'Application record contains an unterminated JSON string.',
  );
}

function jsonRootValueEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = skipWhitespace(source, start); index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === ']') {
      depth -= 1;
      continue;
    }
    if (character === '}') {
      if (depth === 0) return index;
      depth -= 1;
      continue;
    }
    if (character === ',' && depth === 0) return index;
  }
  return source.length;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (
    index < source.length &&
    (source[index] === ' ' ||
      source[index] === '\n' ||
      source[index] === '\r' ||
      source[index] === '\t')
  ) {
    index += 1;
  }
  return index;
}

export const APPLICATION_FIELDS = Object.freeze([
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
]);

export const CURRENT_RECORD = Object.freeze({
  id: 'HM-00000001',
  createdAt: '2026-08-24T10:11:12.345Z',
  plan: 'verification',
  billingCycle: 'monthly',
  name: 'Ada Example',
  email: 'ada@example.com',
  contactPreference: 'Email',
  brand: 'Ada Workshop',
  website: 'https://example.com/ada',
  category: 'Furniture',
  craftSummary: 'Drawn, cut, joined, and finished by hand.',
  proofLinks: 'https://example.com/ada/process',
  walkthroughPreference: 'Video call on a weekday',
  paymentPreference: 'after-approval',
});

// This is valid historical data because the original intake accepted a non-empty email without
// format validation, allowed empty website/proof fields, accepted arbitrary billing strings, and
// preserved any non-empty payment string. Migration validation must describe what could have been
// written, not apply the stricter rules of today's intake retroactively.
export const HISTORICAL_RECORD = Object.freeze({
  id: 'HM-00000002',
  createdAt: '2026-06-29T05:06:07.008Z',
  plan: 'verification',
  billingCycle: 'annual-manual',
  name: 'Historical maker',
  email: 'maker at workshop',
  contactPreference: '@historical-maker',
  brand: 'Historical workshop',
  website: '',
  category: 'Human-made work',
  craftSummary: 'Built before the current intake validation shipped.',
  proofLinks: '',
  walkthroughPreference: '',
  paymentPreference: 'invoice-after-review',
});

// The earliest writers persisted String(payload.billingCycle || 'monthly') without trimming.
// Truthy arrays could therefore become an empty string and whitespace-only strings stayed intact.
export const HISTORICAL_EMPTY_BILLING_RECORD = Object.freeze({
  ...HISTORICAL_RECORD,
  id: 'HM-00000006',
  billingCycle: '',
});

export const HISTORICAL_WHITESPACE_BILLING_RECORD = Object.freeze({
  ...HISTORICAL_RECORD,
  id: 'HM-00000007',
  billingCycle: '   ',
});

// The first writer coerced every submitted value through String(). Required and optional values
// were trimmed, while billingCycle was not. This one synthetic payload exercises every coercible
// persisted field so a future importer cannot silently reapply today's string-only form contract.
const LEGACY_COERCION_PAYLOAD = Object.freeze({
  agree: [],
  billingCycle: [{}, {}],
  brand: true,
  category: ['Ceramics', {}],
  contactPreference: 1e20,
  craftSummary: [true, 1e20, {}],
  email: true,
  name: {},
  paymentPreference: {},
  plan: '  verification  ',
  proofLinks: [{}, {}],
  walkthroughPreference: [null, {}, ''],
  website: {},
});
export const LEGACY_COERCION_REQUEST_BYTES = Buffer.byteLength(
  JSON.stringify(LEGACY_COERCION_PAYLOAD),
);
export const LEGACY_COERCED_RECORD = Object.freeze({
  id: 'HM-0000000B',
  createdAt: '2026-06-29T05:06:07.010Z',
  plan: String(LEGACY_COERCION_PAYLOAD.plan || '').trim(),
  billingCycle: String(LEGACY_COERCION_PAYLOAD.billingCycle || 'monthly'),
  name: String(LEGACY_COERCION_PAYLOAD.name || '').trim(),
  email: String(LEGACY_COERCION_PAYLOAD.email || '').trim(),
  contactPreference: String(LEGACY_COERCION_PAYLOAD.contactPreference || '').trim(),
  brand: String(LEGACY_COERCION_PAYLOAD.brand || '').trim(),
  website: String(LEGACY_COERCION_PAYLOAD.website || '').trim(),
  category: String(LEGACY_COERCION_PAYLOAD.category || '').trim(),
  craftSummary: String(LEGACY_COERCION_PAYLOAD.craftSummary || '').trim(),
  proofLinks: String(LEGACY_COERCION_PAYLOAD.proofLinks || '').trim(),
  walkthroughPreference: String(LEGACY_COERCION_PAYLOAD.walkthroughPreference || '').trim(),
  paymentPreference: String(LEGACY_COERCION_PAYLOAD.paymentPreference || '').trim(),
});

// A pre-bounds writer accepted a 64 KiB JSON request and then coerced values with String(). An
// array of tiny objects therefore expanded substantially when persisted even though the request
// itself stayed inside its hard body ceiling. This proves the importer cannot reuse the later
// 64 KiB JSONL-line ceiling without rejecting legitimate early history.
const LEGACY_EXPANSION_VALUE = Array.from({ length: 5_000 }, () => ({}));
const LEGACY_EXPANSION_PAYLOAD = {
  agree: true,
  billingCycle: LEGACY_EXPANSION_VALUE,
  brand: 'Expansion workshop',
  category: 'Historical work',
  contactPreference: 'Email',
  craftSummary: 'Made by hand.',
  email: 'expansion@example.com',
  name: 'Expansion maker',
  paymentPreference: 'invoice',
  plan: 'verification',
};
export const LEGACY_EXPANDED_REQUEST_BYTES = Buffer.byteLength(
  JSON.stringify(LEGACY_EXPANSION_PAYLOAD),
);
export const LEGACY_EXPANDED_RECORD = Object.freeze({
  id: 'HM-00000008',
  createdAt: '2026-06-29T05:06:07.009Z',
  plan: String(LEGACY_EXPANSION_PAYLOAD.plan).trim(),
  billingCycle: String(LEGACY_EXPANSION_PAYLOAD.billingCycle || 'monthly'),
  name: String(LEGACY_EXPANSION_PAYLOAD.name).trim(),
  email: String(LEGACY_EXPANSION_PAYLOAD.email).trim(),
  contactPreference: String(LEGACY_EXPANSION_PAYLOAD.contactPreference).trim(),
  brand: String(LEGACY_EXPANSION_PAYLOAD.brand).trim(),
  website: '',
  category: String(LEGACY_EXPANSION_PAYLOAD.category).trim(),
  craftSummary: String(LEGACY_EXPANSION_PAYLOAD.craftSummary).trim(),
  proofLinks: '',
  walkthroughPreference: '',
  paymentPreference: String(LEGACY_EXPANSION_PAYLOAD.paymentPreference).trim(),
});

export const UNICODE_RECORD = Object.freeze({
  id: 'HM-00000003',
  createdAt: '2026-07-15T12:00:00.000Z',
  plan: 'verification',
  billingCycle: 'monthly',
  name: 'Zo\u00eb \u00c5ngstr\u00f6m \ud83e\udeb5',
  email: 'zoe@example.se',
  contactPreference: 'Signal: \u201cZo\u00eb\u201d',
  brand: 'Atelj\u00e9\\Studio',
  website: 'https://example.se/%C3%A5',
  category: 'Tr\u00e4sl\u00f6jd',
  craftSummary: 'First line\nSecond line\twith a tab and a \\ backslash.',
  proofLinks: 'https://example.se/proof?quote=%22yes%22',
  walkthroughPreference: 'P\u00e5 plats \u2014 g\u00e4rna efter lunch',
  paymentPreference: 'after-approval',
});

export const DUPLICATE_CONTENT_RECORDS = Object.freeze([
  Object.freeze({ ...CURRENT_RECORD, id: 'HM-00000004' }),
  Object.freeze({ ...CURRENT_RECORD, id: 'HM-00000005' }),
]);

export function recordWithId(index, overrides = {}) {
  return {
    ...CURRENT_RECORD,
    id: `HM-${index.toString(16).toUpperCase().padStart(8, '0')}`,
    createdAt: new Date(Date.parse(CURRENT_RECORD.createdAt) + index).toISOString(),
    ...overrides,
  };
}

export function jsonlBytes(records, { finalNewline = true, lineEnding = '\n' } = {}) {
  const body = records.map((record) => JSON.stringify(record)).join(lineEnding);
  return Buffer.from(`${body}${finalNewline && records.length > 0 ? lineEnding : ''}`, 'utf8');
}

export function jsonlBytesWithReorderedKeys(record) {
  const reversed = Object.fromEntries(Object.entries(record).toReversed());
  return Buffer.from(`${JSON.stringify(reversed)}\n`, 'utf8');
}

export const INVALID_UTF8_BYTES = Buffer.concat([
  Buffer.from('{"id":"HM-00000009","name":"', 'utf8'),
  Buffer.from([0xc3, 0x28]),
  Buffer.from('"}\n', 'utf8'),
]);

export const LONE_SURROGATE_RECORD = Object.freeze({
  ...CURRENT_RECORD,
  id: 'HM-0000000A',
  name: '\ud800',
});

export const LONE_SURROGATE_BYTES = jsonlBytes([LONE_SURROGATE_RECORD]);

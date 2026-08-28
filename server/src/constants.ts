export const HANDMARK_PRODUCT_ID = 'handmark';
export const HANDMARK_PUBLIC_ORIGIN = 'https://handmark.io';
export const HANDMARK_WWW_ORIGIN = 'https://www.handmark.io';

export const HANDMARK_GATE_COOKIE = 'hm_session';
export const HANDMARK_GATE_PATH = '/login';
export const HANDMARK_GATE_MAX_AGE_SECONDS = 12 * 60 * 60;

export const APPLICATION_RETENTION_DAYS = 90;
export const APPLICATION_RETENTION_MS = APPLICATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const APPLICATION_MAX_RECORDS = 10_000;
export const APPLICATION_MAX_CANONICAL_BYTES = 100 * 1024 * 1024;
export const APPLICATION_DATABASE_MAX_BYTES = 512 * 1024 * 1024;
export const APPLICATION_DATABASE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

export const APPLICATION_SUCCESS_MESSAGE =
  'Application received. The next step is human review and process walkthrough.';
export const APPLICATION_STORAGE_FULL_MESSAGE =
  'Handmark cannot accept another application because application storage is full. Please try again later.';

export const HANDMARK_GATE_PUBLIC_PATHS = Object.freeze([
  '/styles.css',
  '/sitemap.xml',
  '/site.webmanifest',
  '/assets/handmark-logo.svg',
  '/assets/handmark-symbol.svg',
  '/assets/fonts/ArchivoNarrow.woff2',
  '/assets/fonts/DMSerifDisplay.woff2',
  '/assets/fonts/InterVariable-Italic.woff2',
  '/assets/fonts/InterVariable.woff2',
  '/assets/fonts/PlusJakartaSans.woff2',
  '/assets/fonts/RobotoMono.woff2',
  '/assets/fonts/Rubik.woff2',
] as const);

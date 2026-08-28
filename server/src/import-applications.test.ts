import assert from 'node:assert/strict';
import test from 'node:test';

import { parseImportArguments } from './import-applications.js';

const OPERATIONAL_ROOT = '/synthetic/handmark';
const SOURCE_PATH = `${OPERATIONAL_ROOT}/data/applications.jsonl`;
const DATABASE_PATH = `${OPERATIONAL_ROOT}/data/handmark.sqlite`;

test('application import CLI selects JSONL authority by default', () => {
  assert.deepEqual(
    parseImportArguments([
      '--operational-root',
      OPERATIONAL_ROOT,
      '--source',
      SOURCE_PATH,
      '--database',
      DATABASE_PATH,
    ]),
    {
      authorityKind: 'legacy_jsonl_v1',
      databasePath: DATABASE_PATH,
      operationalRoot: OPERATIONAL_ROOT,
      sourcePath: SOURCE_PATH,
    },
  );
});

test('application import CLI requires an explicit flag for absent empty authority', () => {
  assert.deepEqual(
    parseImportArguments([
      '--empty-authority',
      '--database',
      DATABASE_PATH,
      '--source',
      SOURCE_PATH,
      '--operational-root',
      OPERATIONAL_ROOT,
    ]),
    {
      authorityKind: 'legacy_empty_absence_v1',
      databasePath: DATABASE_PATH,
      operationalRoot: OPERATIONAL_ROOT,
      sourcePath: SOURCE_PATH,
    },
  );
});

test('application import CLI keeps its argument contract closed', () => {
  for (const arguments_ of [
    [],
    ['--source', SOURCE_PATH, '--database', DATABASE_PATH],
    ['--operational-root', OPERATIONAL_ROOT, '--database', DATABASE_PATH],
    ['--operational-root', OPERATIONAL_ROOT, '--source', SOURCE_PATH],
    [
      '--operational-root',
      OPERATIONAL_ROOT,
      '--source',
      SOURCE_PATH,
      '--database',
      DATABASE_PATH,
      '--empty-authority',
      '--empty-authority',
    ],
    [
      '--operational-root',
      OPERATIONAL_ROOT,
      '--source',
      SOURCE_PATH,
      '--database',
      DATABASE_PATH,
      '--unknown',
    ],
  ]) {
    assert.throws(() => parseImportArguments(arguments_));
  }
});

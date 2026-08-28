import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  APPLICATION_FIELDS,
  CURRENT_RECORD,
  DUPLICATE_CONTENT_RECORDS,
  HISTORICAL_EMPTY_BILLING_RECORD,
  HISTORICAL_RECORD,
  HISTORICAL_WHITESPACE_BILLING_RECORD,
  INVALID_UTF8_BYTES,
  jsonlBytes,
  jsonlBytesWithReorderedKeys,
  LEGACY_COERCED_RECORD,
  LEGACY_COERCION_REQUEST_BYTES,
  LEGACY_EXPANDED_RECORD,
  LEGACY_EXPANDED_REQUEST_BYTES,
  LONE_SURROGATE_BYTES,
  LONE_SURROGATE_RECORD,
  recordWithId,
  UNICODE_RECORD,
} from '../fixtures/application-import/records.mjs';
import {
  applicationLineAtBytes,
  assertFileSnapshot,
  assertImportedTarget,
  assertNoTargetArtifacts,
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  canonicalRecordBytes,
  captureFile,
  COMPILED_IMPORTER_PATH,
  discoverImporter,
  EXPECTED_CHECKPOINTS,
  EXPECTED_LIMITS,
  expectImportError,
  expectedReceipt,
  expectedRows,
  orderedRecordHash,
  readImportedApplications,
  readImportedTarget,
  recordHash,
  setupImportFixture,
  sha256,
  stagingDirectoryPath,
  writeSource,
} from './import-contract-support.mjs';

const discovery = await discoverImporter();
const importer = discovery.module;
const CONTRACT_SKIP = importer
  ? false
  : `compiled strict TypeScript importer not available at ${COMPILED_IMPORTER_PATH}`;

function contractTest(name, optionsOrHandler, maybeHandler) {
  const options = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler;
  const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
  return test(name, { ...options, skip: CONTRACT_SKIP || options.skip }, handler);
}

async function importSource(databasePath, sourcePath) {
  return importer.importApplicationsJsonl({ databasePath, sourcePath });
}

async function importSourceForTest(databasePath, sourcePath, onCheckpoint) {
  return importer.importApplicationsJsonlForTest(
    { databasePath, sourcePath },
    Object.freeze({ onCheckpoint }),
  );
}

function importerChildEnvironment({
  checkpoint,
  databasePath,
  mode,
  readyPath,
  releasePath,
  sourcePath,
}) {
  if (mode !== 'kill' && mode !== 'pause') {
    throw new Error(`Unsupported importer child mode: ${String(mode)}`);
  }
  return Object.freeze({
    HANDMARK_DATABASE_PATH: databasePath,
    HANDMARK_IMPORTER_PATH: COMPILED_IMPORTER_PATH,
    ...(mode === 'kill'
      ? { HANDMARK_KILL_CHECKPOINT: checkpoint }
      : {
          HANDMARK_PAUSE_CHECKPOINT: checkpoint,
          HANDMARK_READY_PATH: readyPath,
          HANDMARK_RELEASE_PATH: releasePath,
        }),
    HANDMARK_SOURCE_PATH: sourcePath,
  });
}

function createProtectedSqlite(filePath) {
  const database = new DatabaseSync(filePath);
  try {
    database.exec(
      `CREATE TABLE protected_evidence (
         id INTEGER PRIMARY KEY,
         value TEXT NOT NULL
       ) STRICT;
       INSERT INTO protected_evidence (id, value) VALUES (1, 'must remain exact');`,
    );
  } finally {
    database.close();
  }
  fs.chmodSync(filePath, 0o600);
}

function killImporterAtCheckpoint(databasePath, sourcePath, checkpoint) {
  const childProgram = String.raw`
    import { pathToFileURL } from 'node:url';
    const importer = await import(pathToFileURL(process.env.HANDMARK_IMPORTER_PATH).href);
    await importer.importApplicationsJsonlForTest(
      {
        databasePath: process.env.HANDMARK_DATABASE_PATH,
        sourcePath: process.env.HANDMARK_SOURCE_PATH,
      },
      {
        onCheckpoint(observed) {
          if (observed === process.env.HANDMARK_KILL_CHECKPOINT) {
            process.kill(process.pid, 'SIGKILL');
          }
        },
      },
    );
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childProgram], {
    encoding: 'utf8',
    env: importerChildEnvironment({ checkpoint, databasePath, mode: 'kill', sourcePath }),
    timeout: 15_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
  assert.equal(child.status, null);
}

function startPausedImporter(databasePath, sourcePath, checkpoint, readyPath, releasePath) {
  const childProgram = String.raw`
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const importer = await import(pathToFileURL(process.env.HANDMARK_IMPORTER_PATH).href);
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    await importer.importApplicationsJsonlForTest(
      {
        databasePath: process.env.HANDMARK_DATABASE_PATH,
        sourcePath: process.env.HANDMARK_SOURCE_PATH,
      },
      {
        onCheckpoint(observed) {
          if (observed !== process.env.HANDMARK_PAUSE_CHECKPOINT) return;
          fs.writeFileSync(process.env.HANDMARK_READY_PATH, 'ready', {
            flag: 'wx',
            mode: 0o600,
          });
          const deadline = Date.now() + 15_000;
          while (!fs.existsSync(process.env.HANDMARK_RELEASE_PATH)) {
            if (Date.now() >= deadline) throw new Error('Timed out waiting for test release.');
            Atomics.wait(waitCell, 0, 0, 10);
          }
        },
      },
    );
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childProgram], {
    env: importerChildEnvironment({
      checkpoint,
      databasePath,
      mode: 'pause',
      readyPath,
      releasePath,
      sourcePath,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ signal, status, stderr, stdout }));
  });
  return { child, completion };
}

async function waitForPath(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function onlyExpectedFields(record) {
  return Object.keys(record).toSorted();
}

function assertTargetRows(databasePath, records) {
  assert.deepEqual(readImportedApplications(databasePath), expectedRows(records));
}

test('synthetic fixture records carry exactly the historical 14-field shape', () => {
  assert.equal(APPLICATION_FIELDS.length, 14);
  for (const record of [
    CURRENT_RECORD,
    HISTORICAL_RECORD,
    HISTORICAL_EMPTY_BILLING_RECORD,
    HISTORICAL_WHITESPACE_BILLING_RECORD,
    LEGACY_COERCED_RECORD,
    LEGACY_EXPANDED_RECORD,
    LONE_SURROGATE_RECORD,
    UNICODE_RECORD,
  ]) {
    assert.deepEqual(onlyExpectedFields(record), APPLICATION_FIELDS.toSorted());
  }
});

test('synthetic history keeps values that older committed intake code could write', () => {
  assert.equal(HISTORICAL_RECORD.website, '');
  assert.equal(HISTORICAL_RECORD.proofLinks, '');
  assert.equal(HISTORICAL_RECORD.walkthroughPreference, '');
  assert.doesNotMatch(HISTORICAL_RECORD.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  assert.equal(HISTORICAL_RECORD.billingCycle, 'annual-manual');
  assert.equal(HISTORICAL_RECORD.paymentPreference, 'invoice-after-review');
  assert.equal(HISTORICAL_EMPTY_BILLING_RECORD.billingCycle, '');
  assert.equal(HISTORICAL_WHITESPACE_BILLING_RECORD.billingCycle, '   ');
  assert.ok(LEGACY_COERCION_REQUEST_BYTES <= 64 * 1024);
  assert.deepEqual(LEGACY_COERCED_RECORD, {
    id: 'HM-0000000B',
    createdAt: '2026-06-29T05:06:07.010Z',
    plan: 'verification',
    billingCycle: '[object Object],[object Object]',
    name: '[object Object]',
    email: 'true',
    contactPreference: '100000000000000000000',
    brand: 'true',
    website: '[object Object]',
    category: 'Ceramics,[object Object]',
    craftSummary: 'true,100000000000000000000,[object Object]',
    proofLinks: '[object Object],[object Object]',
    walkthroughPreference: ',[object Object],',
    paymentPreference: '[object Object]',
  });
});

test('fixture-side canonical hashes ignore JSON spelling but preserve physical order', () => {
  const first = recordHash(UNICODE_RECORD);
  const reordered = Object.fromEntries(Object.entries(UNICODE_RECORD).toReversed());
  assert.equal(recordHash(reordered), first);
  assert.notEqual(
    orderedRecordHash([CURRENT_RECORD, UNICODE_RECORD]),
    orderedRecordHash([UNICODE_RECORD, CURRENT_RECORD]),
  );
  assert.equal(orderedRecordHash([]), sha256(Buffer.alloc(0)));
  assert.equal(canonicalRecordBytes(UNICODE_RECORD).at(-1), '}'.charCodeAt(0));
});

test('the compiled strict TypeScript importer exposes the closed migration contract', () => {
  if (!importer) {
    assert.fail(
      `Expected the compiled importer at ${COMPILED_IMPORTER_PATH}. ` +
        `Phase 6 must add server/src/application-import.ts and build:server before this contract can run. ` +
        `Discovery failed with: ${discovery.error?.message ?? 'unknown error'}`,
    );
  }

  assert.equal(typeof importer.importApplicationsJsonl, 'function');
  assert.equal(typeof importer.importApplicationsJsonlForTest, 'function');
  assert.deepEqual(importer.APPLICATION_IMPORT_CHECKPOINTS, EXPECTED_CHECKPOINTS);
  assert.equal(importer.APPLICATION_IMPORT_MAX_SOURCE_BYTES, EXPECTED_LIMITS.maxSourceBytes);
  assert.equal(importer.APPLICATION_IMPORT_MAX_RECORDS, EXPECTED_LIMITS.maxRecords);
  assert.equal(importer.APPLICATION_IMPORT_MAX_RECORD_BYTES, EXPECTED_LIMITS.maxRecordBytes);
});

test('the compiled importer proves private creation modes without permission mutation APIs', () => {
  const compiledSource = fs.readFileSync(COMPILED_IMPORTER_PATH, 'utf8');
  assert.doesNotMatch(compiledSource, /\b(?:f?chmod|f?chown)(?:Sync)?\b/u);
});

test('importer subprocesses receive only explicit synthetic paths and checkpoints', () => {
  const common = {
    checkpoint: 'marker_durable',
    databasePath: '/synthetic/data/handmark.sqlite',
    sourcePath: '/synthetic/data/applications.jsonl',
  };
  const killed = importerChildEnvironment({ ...common, mode: 'kill' });
  const paused = importerChildEnvironment({
    ...common,
    mode: 'pause',
    readyPath: '/synthetic/control/ready',
    releasePath: '/synthetic/control/release',
  });

  assert.deepEqual(Object.keys(killed).toSorted(), [
    'HANDMARK_DATABASE_PATH',
    'HANDMARK_IMPORTER_PATH',
    'HANDMARK_KILL_CHECKPOINT',
    'HANDMARK_SOURCE_PATH',
  ]);
  assert.deepEqual(Object.keys(paused).toSorted(), [
    'HANDMARK_DATABASE_PATH',
    'HANDMARK_IMPORTER_PATH',
    'HANDMARK_PAUSE_CHECKPOINT',
    'HANDMARK_READY_PATH',
    'HANDMARK_RELEASE_PATH',
    'HANDMARK_SOURCE_PATH',
  ]);
  for (const forbidden of ['HOME', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS']) {
    assert.equal(killed[forbidden], undefined);
    assert.equal(paused[forbidden], undefined);
  }
  assert.throws(
    () => importerChildEnvironment({ ...common, mode: 'run' }),
    /Unsupported importer child mode/u,
  );
});

contractTest(
  'LF, CRLF, final-newline, and no-final-newline sources import identically',
  async (t) => {
    const records = [CURRENT_RECORD, HISTORICAL_RECORD];
    const variants = [
      { finalNewline: true, lineEnding: '\n', name: 'lf-final' },
      { finalNewline: false, lineEnding: '\n', name: 'lf-no-final' },
      { finalNewline: true, lineEnding: '\r\n', name: 'crlf-final' },
      { finalNewline: false, lineEnding: '\r\n', name: 'crlf-no-final' },
    ];
    const recordAggregates = new Set();

    for (const variant of variants) {
      await t.test(variant.name, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = jsonlBytes(records, variant);
        writeSource(fixture.sourcePath, bytes);
        const sourceBefore = captureFile(fixture.sourcePath);

        const receipt = await importSource(fixture.databasePath, fixture.sourcePath);

        assert.deepEqual(receipt, expectedReceipt(bytes, records));
        recordAggregates.add(receipt.orderedRecordsSha256);
        assertImportedTarget(fixture.databasePath, bytes, records);
        assertFileSnapshot(fixture.sourcePath, sourceBefore);
      });
    }

    assert.equal(recordAggregates.size, 1);
  },
);

contractTest('an empty source imports as a sealed zero-record receipt', async (t) => {
  const fixture = setupImportFixture(t);
  const bytes = Buffer.alloc(0);
  writeSource(fixture.sourcePath, bytes);
  const sourceBefore = captureFile(fixture.sourcePath);

  const receipt = await importSource(fixture.databasePath, fixture.sourcePath);

  assert.deepEqual(receipt, expectedReceipt(bytes, []));
  assertImportedTarget(fixture.databasePath, bytes, []);
  assertFileSnapshot(fixture.sourcePath, sourceBefore);
});

contractTest(
  'Unicode, JSON escapes, and property order preserve canonical record identity',
  async (t) => {
    const literal = jsonlBytesWithReorderedKeys(UNICODE_RECORD);
    const reversed = Object.fromEntries(Object.entries(UNICODE_RECORD).toReversed());
    const escaped = Buffer.from(
      `${JSON.stringify(reversed)
        .replace('Zoë', 'Zo\\u00eb')
        .replace('Ångström', '\\u00c5ngstr\\u00f6m')
        .replace('Ateljé', 'Atelj\\u00e9')
        .replace('Träslöjd', 'Tr\\u00e4sl\\u00f6jd')}\n`,
      'utf8',
    );
    const hashes = [];

    for (const [name, bytes] of [
      ['literal', literal],
      ['escaped', escaped],
    ]) {
      await t.test(name, async (t) => {
        const fixture = setupImportFixture(t);
        writeSource(fixture.sourcePath, bytes);
        const receipt = await importSource(fixture.databasePath, fixture.sourcePath);
        hashes.push(receipt.orderedRecordsSha256);
        assertImportedTarget(fixture.databasePath, bytes, [UNICODE_RECORD]);
      });
    }

    assert.equal(new Set(hashes).size, 1);
    assert.notEqual(sha256(literal), sha256(escaped));
  },
);

contractTest(
  'historical weak values import without weakening the current intake contract',
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [
      HISTORICAL_RECORD,
      HISTORICAL_EMPTY_BILLING_RECORD,
      HISTORICAL_WHITESPACE_BILLING_RECORD,
      LEGACY_COERCED_RECORD,
      LEGACY_EXPANDED_RECORD,
    ];
    assert.ok(LEGACY_EXPANDED_REQUEST_BYTES <= 64 * 1024);
    assert.ok(canonicalRecordBytes(LEGACY_EXPANDED_RECORD).byteLength > 64 * 1024);
    assert.ok(
      canonicalRecordBytes(LEGACY_EXPANDED_RECORD).byteLength <= EXPECTED_LIMITS.maxRecordBytes,
    );
    const bytes = jsonlBytes(records);
    writeSource(fixture.sourcePath, bytes);

    const receipt = await importSource(fixture.databasePath, fixture.sourcePath);

    assert.deepEqual(receipt, expectedReceipt(bytes, records));
    assertImportedTarget(fixture.databasePath, bytes, records);
  },
);

contractTest('offline import never applies runtime retention', async (t) => {
  const fixture = setupImportFixture(t);
  const retainedRecord = {
    ...CURRENT_RECORD,
    id: 'HM-0000000C',
    createdAt: '2000-01-01T00:00:00.000Z',
  };
  const bytes = jsonlBytes([retainedRecord]);
  writeSource(fixture.sourcePath, bytes);

  await importSource(fixture.databasePath, fixture.sourcePath);

  assertImportedTarget(fixture.databasePath, bytes, [retainedRecord]);
});

contractTest('duplicate content with distinct IDs succeeds in physical intake order', async (t) => {
  const fixture = setupImportFixture(t);
  const bytes = jsonlBytes(DUPLICATE_CONTENT_RECORDS);
  writeSource(fixture.sourcePath, bytes);

  await importSource(fixture.databasePath, fixture.sourcePath);

  const target = assertImportedTarget(fixture.databasePath, bytes, DUPLICATE_CONTENT_RECORDS);
  assert.deepEqual(
    target.applications.map(({ id, intakeSequence }) => ({ id, intakeSequence })),
    [
      { id: 'HM-00000004', intakeSequence: 1 },
      { id: 'HM-00000005', intakeSequence: 2 },
    ],
  );
});

contractTest(
  'physical source order becomes explicit intake_sequence, not ID or timestamp order',
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [UNICODE_RECORD, HISTORICAL_RECORD, CURRENT_RECORD];
    const bytes = jsonlBytes(records);
    writeSource(fixture.sourcePath, bytes);

    await importSource(fixture.databasePath, fixture.sourcePath);

    const target = assertImportedTarget(fixture.databasePath, bytes, records);
    assert.deepEqual(
      target.applications.map(({ id, intakeSequence }) => ({ id, intakeSequence })),
      records.map(({ id }, index) => ({ id, intakeSequence: index + 1 })),
    );
    assert.deepEqual(
      target.applications.map(({ createdAt, createdAtMs }) => ({ createdAt, createdAtMs })),
      records.map(({ createdAt }) => ({ createdAt, createdAtMs: Date.parse(createdAt) })),
    );
    assert.equal(target.receipt.orderedRecordsSha256, orderedRecordHash(records));
  },
);

contractTest('malformed JSON and non-object JSON values fail before a target write', async (t) => {
  const cases = [
    { bytes: Buffer.from('{not-json}\n'), code: 'invalid_json', name: 'malformed object' },
    { bytes: Buffer.from('null\n'), code: 'invalid_record', name: 'null' },
    { bytes: Buffer.from('42\n'), code: 'invalid_record', name: 'number' },
    { bytes: Buffer.from('true\n'), code: 'invalid_record', name: 'boolean' },
    { bytes: Buffer.from('"record"\n'), code: 'invalid_record', name: 'string' },
    { bytes: Buffer.from('[{}]\n'), code: 'invalid_record', name: 'array' },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (t) => {
      const fixture = setupImportFixture(t);
      writeSource(fixture.sourcePath, fixtureCase.bytes);
      const sourceBefore = captureFile(fixture.sourcePath);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        fixtureCase.code,
        { line: 1 },
      );

      assertFileSnapshot(fixture.sourcePath, sourceBefore);
      assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
        path.basename(fixture.sourcePath),
      ]);
    });
  }
});

contractTest(
  'plain and escaped-equivalent duplicate JSON keys fail before target creation',
  async (t) => {
    const canonical = JSON.stringify(CURRENT_RECORD);
    const cases = [
      {
        name: 'plain duplicate',
        source: canonical.replace('"id":"HM-00000001"', '"id":"HM-00000001","id":"HM-00000002"'),
      },
      {
        name: 'escaped-equivalent duplicate',
        source: canonical.replace(
          '"id":"HM-00000001"',
          '"id":"HM-00000001","i\\u0064":"HM-00000002"',
        ),
      },
    ];

    for (const fixtureCase of cases) {
      await t.test(fixtureCase.name, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = Buffer.from(`${fixtureCase.source}\n`, 'utf8');
        writeSource(fixture.sourcePath, bytes);
        const sourceBefore = captureFile(fixture.sourcePath);

        await expectImportError(
          () => importSource(fixture.databasePath, fixture.sourcePath),
          'invalid_record',
          { field: 'id', line: 1 },
        );

        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
          path.basename(fixture.sourcePath),
        ]);
      });
    }
  },
);

contractTest('every missing field fails closed before a target write', async (t) => {
  for (const field of APPLICATION_FIELDS) {
    await t.test(field, async (t) => {
      const fixture = setupImportFixture(t);
      const invalid = { ...CURRENT_RECORD };
      delete invalid[field];
      const bytes = jsonlBytes([invalid]);
      writeSource(fixture.sourcePath, bytes);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'invalid_record',
        { field, line: 1 },
      );

      assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
        path.basename(fixture.sourcePath),
      ]);
    });
  }
});

contractTest('every wrongly typed field fails closed before a target write', async (t) => {
  const wrongValues = {
    billingCycle: false,
    brand: {},
    category: [],
    contactPreference: 7,
    craftSummary: null,
    createdAt: 1_700_000_000,
    email: ['ada@example.com'],
    id: 1,
    name: true,
    paymentPreference: {},
    plan: ['verification'],
    proofLinks: null,
    walkthroughPreference: false,
    website: 42,
  };

  for (const field of APPLICATION_FIELDS) {
    await t.test(field, async (t) => {
      const fixture = setupImportFixture(t);
      const bytes = jsonlBytes([{ ...CURRENT_RECORD, [field]: wrongValues[field] }]);
      writeSource(fixture.sourcePath, bytes);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'invalid_record',
        { field, line: 1 },
      );

      assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
        path.basename(fixture.sourcePath),
      ]);
    });
  }
});

contractTest('unknown fields and impossible historical string values fail closed', async (t) => {
  const cases = [
    { field: 'unexpected', record: { ...CURRENT_RECORD, unexpected: 'not in schema' } },
    { field: 'id', record: { ...CURRENT_RECORD, id: 'hm-00000001' } },
    { field: 'createdAt', record: { ...CURRENT_RECORD, createdAt: 'not-a-timestamp' } },
    { field: 'createdAt', record: { ...CURRENT_RECORD, createdAt: '2026-08-24' } },
    {
      field: 'createdAt',
      record: { ...CURRENT_RECORD, createdAt: '2026-08-24T12:11:12.345+02:00' },
    },
    { field: 'plan', record: { ...CURRENT_RECORD, plan: 'other' } },
    { field: 'name', record: { ...CURRENT_RECORD, name: '' } },
    { field: 'email', record: { ...CURRENT_RECORD, email: '' } },
    { field: 'contactPreference', record: { ...CURRENT_RECORD, contactPreference: '' } },
    { field: 'brand', record: { ...CURRENT_RECORD, brand: '' } },
    { field: 'category', record: { ...CURRENT_RECORD, category: '' } },
    { field: 'craftSummary', record: { ...CURRENT_RECORD, craftSummary: '' } },
    { field: 'paymentPreference', record: { ...CURRENT_RECORD, paymentPreference: '' } },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.field, async (t) => {
      const fixture = setupImportFixture(t);
      const bytes = jsonlBytes([fixtureCase.record]);
      writeSource(fixture.sourcePath, bytes);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'invalid_record',
        { field: fixtureCase.field, line: 1 },
      );
      assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
        path.basename(fixture.sourcePath),
      ]);
    });
  }
});

contractTest('invalid raw UTF-8 is rejected before a target write', async (t) => {
  const fixture = setupImportFixture(t);
  writeSource(fixture.sourcePath, INVALID_UTF8_BYTES);

  await expectImportError(
    () => importSource(fixture.databasePath, fixture.sourcePath),
    'invalid_utf8',
    { line: 1 },
  );
  assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
    path.basename(fixture.sourcePath),
  ]);
});

contractTest('escaped lone UTF-16 surrogates remain exact historical data', async (t) => {
  const fixture = setupImportFixture(t);
  writeSource(fixture.sourcePath, LONE_SURROGATE_BYTES);

  const receipt = await importSource(fixture.databasePath, fixture.sourcePath);

  assert.deepEqual(receipt, expectedReceipt(LONE_SURROGATE_BYTES, [LONE_SURROGATE_RECORD]));
  assertImportedTarget(fixture.databasePath, LONE_SURROGATE_BYTES, [LONE_SURROGATE_RECORD]);
});

contractTest(
  'every physical blank line is rejected while one terminating newline stays valid',
  async (t) => {
    const validLine = JSON.stringify(CURRENT_RECORD);
    const cases = [
      { bytes: Buffer.from(`\n${validLine}\n`), line: 1, name: 'leading' },
      { bytes: Buffer.from(`${validLine}\n\n${validLine}\n`), line: 2, name: 'middle' },
      { bytes: Buffer.from(`${validLine}\n\n`), line: 2, name: 'trailing blank' },
      { bytes: Buffer.from('\n'), line: 1, name: 'newline only' },
    ];

    for (const fixtureCase of cases) {
      await t.test(fixtureCase.name, async (t) => {
        const fixture = setupImportFixture(t);
        writeSource(fixture.sourcePath, fixtureCase.bytes);
        await expectImportError(
          () => importSource(fixture.databasePath, fixture.sourcePath),
          'blank_line',
          { line: fixtureCase.line },
        );
        assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
          path.basename(fixture.sourcePath),
        ]);
      });
    }

    await t.test('one final newline is a terminator, not a blank record', async (t) => {
      const fixture = setupImportFixture(t);
      const bytes = Buffer.from(`${validLine}\n`);
      writeSource(fixture.sourcePath, bytes);
      await importSource(fixture.databasePath, fixture.sourcePath);
      assertImportedTarget(fixture.databasePath, bytes, [CURRENT_RECORD]);
    });
  },
);

contractTest(
  'adjacent and nonadjacent duplicate IDs reject the complete source before writes',
  async (t) => {
    const repeated = { ...CURRENT_RECORD };
    const cases = [
      { name: 'adjacent', records: [CURRENT_RECORD, repeated] },
      {
        name: 'nonadjacent',
        records: [CURRENT_RECORD, HISTORICAL_RECORD, repeated],
      },
    ];

    for (const fixtureCase of cases) {
      await t.test(fixtureCase.name, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = jsonlBytes(fixtureCase.records);
        writeSource(fixture.sourcePath, bytes);

        await expectImportError(
          () => importSource(fixture.databasePath, fixture.sourcePath),
          'duplicate_id',
          { line: fixtureCase.records.length },
        );
        assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
          path.basename(fixture.sourcePath),
        ]);
      });
    }
  },
);

contractTest('record byte bounds accept the exact ceiling and reject the next byte', async (t) => {
  const exactRecord = applicationLineAtBytes(CURRENT_RECORD, EXPECTED_LIMITS.maxRecordBytes);
  const overRecord = applicationLineAtBytes(
    { ...CURRENT_RECORD, id: 'HM-00000002' },
    EXPECTED_LIMITS.maxRecordBytes + 1,
  );

  await t.test('exact ceiling', async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([exactRecord]);
    writeSource(fixture.sourcePath, bytes);
    await importSource(fixture.databasePath, fixture.sourcePath);
    assertImportedTarget(fixture.databasePath, bytes, [exactRecord]);
  });

  await t.test('one byte over', async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([overRecord]);
    writeSource(fixture.sourcePath, bytes);
    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'record_too_large',
      { line: 1 },
    );
    assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
      path.basename(fixture.sourcePath),
    ]);
  });
});

contractTest(
  'record-count bounds accept 10,000 records and reject the 10,001st before writes',
  { timeout: 60_000 },
  async (t) => {
    const exactRecords = Array.from({ length: EXPECTED_LIMITS.maxRecords }, (_, index) =>
      recordWithId(index + 0x100),
    );

    await t.test('exact ceiling', async (t) => {
      const fixture = setupImportFixture(t);
      const bytes = jsonlBytes(exactRecords);
      writeSource(fixture.sourcePath, bytes);
      const receipt = await importSource(fixture.databasePath, fixture.sourcePath);
      assert.deepEqual(receipt, expectedReceipt(bytes, exactRecords));
      assertImportedTarget(fixture.databasePath, bytes, exactRecords);
    });

    await t.test('one record over', async (t) => {
      const fixture = setupImportFixture(t);
      const records = [...exactRecords, recordWithId(EXPECTED_LIMITS.maxRecords + 0x100)];
      const bytes = jsonlBytes(records);
      writeSource(fixture.sourcePath, bytes);
      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'too_many_records',
        { line: EXPECTED_LIMITS.maxRecords + 1 },
      );
      assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
        path.basename(fixture.sourcePath),
      ]);
    });
  },
);

contractTest(
  'the source file byte ceiling is checked before parsing or target creation',
  async (t) => {
    const fixture = setupImportFixture(t);
    writeSource(fixture.sourcePath, jsonlBytes([CURRENT_RECORD]));
    fs.truncateSync(fixture.sourcePath, EXPECTED_LIMITS.maxSourceBytes + 1);
    const sourceBefore = captureFile(fixture.sourcePath, { includeBytes: false });

    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'file_too_large',
    );

    assertFileSnapshot(fixture.sourcePath, sourceBefore);
    assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
      path.basename(fixture.sourcePath),
    ]);
  },
);

contractTest(
  'missing and non-regular source paths fail without following or opening them',
  async (t) => {
    await t.test('missing', async (t) => {
      const fixture = setupImportFixture(t);
      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'source_missing',
      );
      assertNoTargetArtifacts(fixture.directory, fixture.databasePath);
    });

    await t.test('directory', async (t) => {
      const fixture = setupImportFixture(t);
      fs.mkdirSync(fixture.sourcePath);
      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'source_invalid_type',
      );
      assert.equal(fs.lstatSync(fixture.sourcePath).isDirectory(), true);
      assert.equal(fs.existsSync(fixture.databasePath), false);
    });

    await t.test('symlink', async (t) => {
      const fixture = setupImportFixture(t);
      const protectedPath = path.join(fixture.directory, 'protected.jsonl');
      writeSource(protectedPath, jsonlBytes([CURRENT_RECORD]));
      const protectedBefore = captureFile(protectedPath);
      fs.symlinkSync(protectedPath, fixture.sourcePath);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'source_invalid_type',
      );

      assert.equal(fs.lstatSync(fixture.sourcePath).isSymbolicLink(), true);
      assertFileSnapshot(protectedPath, protectedBefore);
      assert.equal(fs.existsSync(fixture.databasePath), false);
    });

    await t.test('hardlink', async (t) => {
      const fixture = setupImportFixture(t);
      const protectedPath = path.join(fixture.directory, 'protected.jsonl');
      writeSource(protectedPath, jsonlBytes([CURRENT_RECORD]));
      fs.linkSync(protectedPath, fixture.sourcePath);
      const protectedBefore = captureFile(protectedPath);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'source_invalid_type',
      );

      assertFileSnapshot(protectedPath, protectedBefore);
      assertFileSnapshot(fixture.sourcePath, protectedBefore);
      assert.equal(fs.existsSync(fixture.databasePath), false);
    });

    await t.test('FIFO', async (t) => {
      const fixture = setupImportFixture(t);
      const result = spawnSync('mkfifo', [fixture.sourcePath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);

      await expectImportError(
        () => importSource(fixture.databasePath, fixture.sourcePath),
        'source_invalid_type',
      );

      assert.equal(fs.lstatSync(fixture.sourcePath).isFIFO(), true);
      assert.equal(fs.existsSync(fixture.databasePath), false);
    });
  },
);

contractTest(
  'non-regular or multiply linked target paths fail without changing either file',
  async (t) => {
    const cases = ['directory', 'symlink', 'hardlink', 'FIFO'];

    for (const targetType of cases) {
      await t.test(targetType, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = jsonlBytes([CURRENT_RECORD]);
        writeSource(fixture.sourcePath, bytes);
        const sourceBefore = captureFile(fixture.sourcePath);
        const protectedPath = path.join(fixture.directory, 'protected-target');
        let protectedBefore;

        if (targetType === 'directory') fs.mkdirSync(fixture.databasePath);
        if (targetType === 'symlink') {
          fs.writeFileSync(protectedPath, 'protected', { mode: 0o600 });
          protectedBefore = captureFile(protectedPath);
          fs.symlinkSync(protectedPath, fixture.databasePath);
        }
        if (targetType === 'hardlink') {
          fs.writeFileSync(protectedPath, 'protected', { mode: 0o600 });
          fs.linkSync(protectedPath, fixture.databasePath);
          protectedBefore = captureFile(protectedPath);
        }
        if (targetType === 'FIFO') {
          const result = spawnSync('mkfifo', [fixture.databasePath], { encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
        }

        await expectImportError(
          () => importSource(fixture.databasePath, fixture.sourcePath),
          'target_invalid_type',
        );

        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        if (protectedBefore) assertFileSnapshot(protectedPath, protectedBefore);
        if (targetType === 'directory')
          assert.equal(fs.statSync(fixture.databasePath).isDirectory(), true);
        if (targetType === 'FIFO') assert.equal(fs.lstatSync(fixture.databasePath).isFIFO(), true);
      });
    }
  },
);

contractTest(
  'the closed checkpoint seam exposes the complete success lifecycle in order',
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [CURRENT_RECORD, HISTORICAL_RECORD, UNICODE_RECORD];
    const bytes = jsonlBytes(records);
    writeSource(fixture.sourcePath, bytes);
    const observed = [];

    await importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint, details) => {
      observed.push(
        checkpoint === 'record_inserted' ? `${checkpoint}:${details.intakeSequence}` : checkpoint,
      );
      if (checkpoint === 'temporary_created') {
        assertPrivateOwnedDirectory(details.stagingDirectory);
        assertPrivateOwnedRegularFile(details.databasePath);
      }
      if (checkpoint === 'marker_durable') {
        assertPrivateOwnedDirectory(details.stagingDirectory);
        assertPrivateOwnedRegularFile(details.databasePath);
        assertPrivateOwnedRegularFile(path.join(details.stagingDirectory, 'operation.json'));
      }
    });

    assert.deepEqual(observed, [
      'source_opened',
      'source_validated',
      'temporary_created',
      'target_transaction_started',
      'record_inserted:1',
      'record_inserted:2',
      'record_inserted:3',
      'before_commit',
      'target_reopened',
      'marker_durable',
      'before_publish',
      'target_linked',
      'target_published',
      'final_source_verified',
    ]);
    assertImportedTarget(fixture.databasePath, bytes, records);
  },
);

contractTest('every injected lifecycle failure leaves no partial published target', async (t) => {
  const checkpoints = [
    'source_opened',
    'source_validated',
    'temporary_created',
    'target_transaction_started',
    'record_inserted',
    'before_commit',
    'target_reopened',
    'marker_durable',
    'before_publish',
    'target_linked',
    'target_published',
    'final_source_verified',
  ];

  for (const failingCheckpoint of checkpoints) {
    await t.test(failingCheckpoint, async (t) => {
      const fixture = setupImportFixture(t);
      const records = [CURRENT_RECORD, HISTORICAL_RECORD, UNICODE_RECORD];
      const bytes = jsonlBytes(records);
      writeSource(fixture.sourcePath, bytes);
      const sourceBefore = captureFile(fixture.sourcePath);
      const injected = new Error(`injected failure at ${failingCheckpoint}`);

      await expectImportError(
        () =>
          importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint, details) => {
            if (
              checkpoint === failingCheckpoint &&
              (checkpoint !== 'record_inserted' || details.intakeSequence === 2)
            ) {
              throw injected;
            }
          }),
        'import_failed',
      );

      assertFileSnapshot(fixture.sourcePath, sourceBefore);
      assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
        path.basename(fixture.sourcePath),
      ]);
    });
  }
});

contractTest(
  'staging database path swaps cannot redirect SQLite into a protected database',
  async (t) => {
    for (const replacementType of ['symlink', 'hardlink']) {
      await t.test(replacementType, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
        writeSource(fixture.sourcePath, bytes);
        const sourceBefore = captureFile(fixture.sourcePath);
        const protectedPath = path.join(fixture.directory, `protected-${replacementType}.sqlite`);
        createProtectedSqlite(protectedPath);
        const protectedBefore = captureFile(protectedPath);

        await expectImportError(
          () =>
            importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint, details) => {
              if (checkpoint !== 'temporary_created') return;
              fs.unlinkSync(details.databasePath);
              if (replacementType === 'symlink') {
                fs.symlinkSync(protectedPath, details.databasePath);
              } else {
                fs.linkSync(protectedPath, details.databasePath);
              }
            }),
          'import_failed',
        );

        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        assertFileSnapshot(protectedPath, protectedBefore);
        assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
          path.basename(fixture.sourcePath),
          path.basename(protectedPath),
        ]);
      });
    }
  },
);

contractTest(
  'database parent replacement fails closed without touching the replacement namespace',
  async (t) => {
    for (const failingCheckpoint of ['temporary_created', 'before_publish']) {
      await t.test(failingCheckpoint, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
        writeSource(fixture.sourcePath, bytes);
        const sourceBefore = captureFile(fixture.sourcePath);
        const databaseParent = path.join(fixture.directory, 'database-parent');
        const databasePath = path.join(databaseParent, 'handmark.sqlite');
        const movedDirectory = path.join(fixture.directory, `moved-${failingCheckpoint}`);
        const replacementEvidence = path.join(databaseParent, 'replacement-evidence');
        fs.mkdirSync(databaseParent, { mode: 0o700 });

        await expectImportError(
          () =>
            importSourceForTest(databasePath, fixture.sourcePath, (checkpoint) => {
              if (checkpoint !== failingCheckpoint) return;
              fs.renameSync(databaseParent, movedDirectory);
              fs.mkdirSync(databaseParent, { mode: 0o700 });
              fs.writeFileSync(replacementEvidence, 'replacement must remain untouched', {
                mode: 0o600,
              });
            }),
          'target_changed',
        );

        assert.equal(
          fs.readFileSync(replacementEvidence, 'utf8'),
          'replacement must remain untouched',
        );
        assert.equal(fs.existsSync(databasePath), false);
        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        assert.equal(fs.existsSync(stagingDirectoryPath(databasePath)), false);
        assert.equal(
          fs.existsSync(
            path.join(movedDirectory, path.basename(stagingDirectoryPath(databasePath))),
          ),
          true,
          'unaddressable original namespace must be preserved for explicit recovery',
        );
      });
    }
  },
);

contractTest(
  'cleanup preserves planted staging sidecars and keeps the injected primary error',
  async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
    writeSource(fixture.sourcePath, bytes);
    const sourceBefore = captureFile(fixture.sourcePath);
    const injected = new Error('primary checkpoint failure');
    const stageDirectory = stagingDirectoryPath(fixture.databasePath);
    const plantedSidecar = path.join(stageDirectory, 'database.sqlite-wal');
    const plantedBytes = Buffer.from('foreign sidecar evidence');
    let observedError;

    try {
      await importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint, details) => {
        if (checkpoint !== 'marker_durable') return;
        fs.writeFileSync(`${details.databasePath}-wal`, plantedBytes, { mode: 0o600 });
        throw injected;
      });
      assert.fail('expected the injected import failure');
    } catch (error) {
      observedError = error;
    }

    assert.equal(observedError?.name, 'ApplicationImportError');
    assert.equal(observedError?.code, 'import_failed');
    assert.ok(observedError?.cause instanceof AggregateError);
    assert.equal(observedError.cause.errors[0], injected);
    assert.ok(
      observedError.cause.errors.some(
        (error) => error?.name === 'ApplicationImportError' && error?.code === 'cleanup_failed',
      ),
    );
    assertFileSnapshot(fixture.sourcePath, sourceBefore);
    assert.equal(fs.existsSync(fixture.databasePath), false);
    assert.deepEqual(fs.readFileSync(plantedSidecar), plantedBytes);
    assert.deepEqual(fs.readdirSync(stageDirectory).toSorted(), [
      'database.sqlite-wal',
      'operation.json',
    ]);
    const sidecarBeforeRecovery = captureFile(plantedSidecar);
    const markerBeforeRecovery = captureFile(path.join(stageDirectory, 'operation.json'));

    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'recovery_conflict',
    );

    assertFileSnapshot(plantedSidecar, sidecarBeforeRecovery);
    assertFileSnapshot(path.join(stageDirectory, 'operation.json'), markerBeforeRecovery);
    assertFileSnapshot(fixture.sourcePath, sourceBefore);
    assert.equal(fs.existsSync(fixture.databasePath), false);
  },
);

contractTest(
  'a target sidecar created after publication rolls back only the importer target',
  async (t) => {
    for (const suffix of ['-journal', '-shm', '-wal']) {
      await t.test(suffix, async (t) => {
        const fixture = setupImportFixture(t);
        const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
        writeSource(fixture.sourcePath, bytes);
        const sourceBefore = captureFile(fixture.sourcePath);
        const sidecarPath = `${fixture.databasePath}${suffix}`;
        const sidecarBytes = Buffer.from(`unowned ${suffix} evidence`);

        await expectImportError(
          () =>
            importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
              if (checkpoint === 'target_published') {
                fs.writeFileSync(sidecarPath, sidecarBytes, { mode: 0o600 });
              }
            }),
          'target_changed',
        );

        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        assert.equal(fs.existsSync(fixture.databasePath), false);
        assert.deepEqual(fs.readFileSync(sidecarPath), sidecarBytes);
        assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), false);
      });
    }

    await t.test('after final source proof', async (t) => {
      const fixture = setupImportFixture(t);
      const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
      writeSource(fixture.sourcePath, bytes);
      const sourceBefore = captureFile(fixture.sourcePath);
      const sidecarPath = `${fixture.databasePath}-journal`;
      const sidecarBytes = Buffer.from('late journal evidence');

      await expectImportError(
        () =>
          importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
            if (checkpoint === 'final_source_verified') {
              fs.writeFileSync(sidecarPath, sidecarBytes, { mode: 0o600 });
            }
          }),
        'target_changed',
      );

      assertFileSnapshot(fixture.sourcePath, sourceBefore);
      assert.equal(fs.existsSync(fixture.databasePath), false);
      assert.deepEqual(fs.readFileSync(sidecarPath), sidecarBytes);
      assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), false);
    });
  },
);

contractTest(
  'durable checkpoints recover to one exact private target after process death',
  { timeout: 60_000 },
  async (t) => {
    for (const checkpoint of ['marker_durable', 'target_linked', 'target_published']) {
      await t.test(checkpoint, async (t) => {
        const fixture = setupImportFixture(t);
        const records = [CURRENT_RECORD, HISTORICAL_RECORD, UNICODE_RECORD];
        const bytes = jsonlBytes(records);
        writeSource(fixture.sourcePath, bytes, 0o640);
        const sourceBefore = captureFile(fixture.sourcePath);

        killImporterAtCheckpoint(fixture.databasePath, fixture.sourcePath, checkpoint);

        assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), true);
        assert.equal(
          fs.existsSync(fixture.databasePath),
          checkpoint === 'marker_durable' ? false : true,
        );

        const receipt = await importSource(fixture.databasePath, fixture.sourcePath);

        assert.deepEqual(receipt, expectedReceipt(bytes, records));
        assertImportedTarget(fixture.databasePath, bytes, records);
        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        const target = captureFile(fixture.databasePath, { includeBytes: false });
        assert.equal(target.mode, 0o600);
        assert.equal(target.nlink, 1);
      });
    }
  },
);

contractTest(
  'a live marker owner blocks concurrent crash recovery at the linked boundary',
  { timeout: 30_000 },
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [CURRENT_RECORD, HISTORICAL_RECORD];
    const bytes = jsonlBytes(records);
    writeSource(fixture.sourcePath, bytes);
    const sourceBefore = captureFile(fixture.sourcePath);
    const readyPath = path.join(fixture.directory, 'child-ready');
    const releasePath = path.join(fixture.directory, 'child-release');
    const { child, completion } = startPausedImporter(
      fixture.databasePath,
      fixture.sourcePath,
      'target_linked',
      readyPath,
      releasePath,
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });

    await waitForPath(readyPath);
    const targetWhileOwned = captureFile(fixture.databasePath, { includeBytes: false });
    assert.equal(targetWhileOwned.nlink, 2);

    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'recovery_conflict',
    );

    assertFileSnapshot(fixture.databasePath, targetWhileOwned);
    assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), true);
    fs.writeFileSync(releasePath, 'release', { mode: 0o600 });
    const result = await completion;
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    assertImportedTarget(fixture.databasePath, bytes, records);
    assertFileSnapshot(fixture.sourcePath, sourceBefore);
  },
);

contractTest(
  'source path replacement after open is detected before any target publication',
  async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
    writeSource(fixture.sourcePath, bytes);
    const openedSourcePath = path.join(fixture.directory, 'opened-source.jsonl');
    let replacementBefore;

    await expectImportError(
      () =>
        importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
          if (checkpoint !== 'source_opened') return;
          fs.renameSync(fixture.sourcePath, openedSourcePath);
          writeSource(fixture.sourcePath, jsonlBytes([UNICODE_RECORD]));
          replacementBefore = captureFile(fixture.sourcePath);
        }),
      'source_changed',
    );

    assert.deepEqual(fs.readFileSync(openedSourcePath), bytes);
    assertFileSnapshot(fixture.sourcePath, replacementBefore);
    assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
      path.basename(fixture.sourcePath),
      path.basename(openedSourcePath),
    ]);
  },
);

contractTest(
  'same-inode source byte changes after validation fail before target publication',
  async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
    writeSource(fixture.sourcePath, bytes);
    let changedSource;

    await expectImportError(
      () =>
        importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
          if (checkpoint !== 'source_validated') return;
          fs.appendFileSync(fixture.sourcePath, ' ');
          changedSource = captureFile(fixture.sourcePath);
        }),
      'source_changed',
    );

    assertFileSnapshot(fixture.sourcePath, changedSource);
    assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
      path.basename(fixture.sourcePath),
    ]);
  },
);

contractTest(
  'source mode changes after target reopen fail before atomic publication',
  async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
    writeSource(fixture.sourcePath, bytes, 0o640);
    let changedSource;

    await expectImportError(
      () =>
        importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
          if (checkpoint !== 'target_reopened') return;
          fs.chmodSync(fixture.sourcePath, 0o600);
          changedSource = captureFile(fixture.sourcePath);
        }),
      'source_changed',
    );

    assertFileSnapshot(fixture.sourcePath, changedSource);
    assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
      path.basename(fixture.sourcePath),
    ]);
  },
);

contractTest(
  'a source change immediately after publication rolls the unaccepted target back',
  async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
    writeSource(fixture.sourcePath, bytes, 0o640);
    let changedSource;

    await expectImportError(
      () =>
        importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
          if (checkpoint !== 'target_published') return;
          fs.appendFileSync(fixture.sourcePath, ' ');
          changedSource = captureFile(fixture.sourcePath);
        }),
      'source_changed',
    );

    assertFileSnapshot(fixture.sourcePath, changedSource);
    assertNoTargetArtifacts(fixture.directory, fixture.databasePath, [
      path.basename(fixture.sourcePath),
    ]);
  },
);

contractTest('a target appearing at the final publish boundary is never overwritten', async (t) => {
  const fixture = setupImportFixture(t);
  const bytes = jsonlBytes([CURRENT_RECORD, HISTORICAL_RECORD]);
  writeSource(fixture.sourcePath, bytes, 0o640);
  const sourceBefore = captureFile(fixture.sourcePath);

  await expectImportError(
    () =>
      importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
        if (checkpoint === 'before_publish') fs.mkdirSync(fixture.databasePath);
      }),
    'target_changed',
  );

  assertFileSnapshot(fixture.sourcePath, sourceBefore);
  assert.equal(fs.lstatSync(fixture.databasePath).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(fixture.directory).toSorted(), [
    path.basename(fixture.sourcePath),
    path.basename(fixture.databasePath),
  ]);
});

contractTest(
  'an exact replay returns the exact receipt without changing source or target',
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [CURRENT_RECORD, HISTORICAL_RECORD, UNICODE_RECORD];
    const bytes = jsonlBytes(records, { finalNewline: false, lineEnding: '\r\n' });
    writeSource(fixture.sourcePath, bytes, 0o640);

    const firstReceipt = await importSource(fixture.databasePath, fixture.sourcePath);
    assertImportedTarget(fixture.databasePath, bytes, records);
    const sourceBeforeReplay = captureFile(fixture.sourcePath);
    const targetBeforeReplay = captureFile(fixture.databasePath);

    const secondReceipt = await importSource(fixture.databasePath, fixture.sourcePath);

    assert.deepEqual(secondReceipt, firstReceipt);
    assert.deepEqual(secondReceipt, expectedReceipt(bytes, records));
    assertFileSnapshot(fixture.sourcePath, sourceBeforeReplay);
    assertFileSnapshot(fixture.databasePath, targetBeforeReplay);
    assertImportedTarget(fixture.databasePath, bytes, records);
  },
);

contractTest(
  'exact replay rejects every public SQLite sidecar without changing any file',
  async (t) => {
    for (const suffix of ['-journal', '-shm', '-wal']) {
      await t.test(suffix, async (t) => {
        const fixture = setupImportFixture(t);
        const records = [CURRENT_RECORD, HISTORICAL_RECORD];
        const bytes = jsonlBytes(records);
        writeSource(fixture.sourcePath, bytes);
        await importSource(fixture.databasePath, fixture.sourcePath);
        const targetBefore = captureFile(fixture.databasePath);
        const sourceBefore = captureFile(fixture.sourcePath);
        const sidecarPath = `${fixture.databasePath}${suffix}`;
        fs.writeFileSync(sidecarPath, `existing ${suffix} evidence`, { mode: 0o600 });
        const sidecarBefore = captureFile(sidecarPath);

        await expectImportError(
          () => importSource(fixture.databasePath, fixture.sourcePath),
          'target_conflict',
        );

        assertFileSnapshot(fixture.databasePath, targetBefore);
        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        assertFileSnapshot(sidecarPath, sidecarBefore);
        assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), false);
      });
    }
  },
);

contractTest(
  'a sidecar appearing after replay pinning conflicts and leaves the target untouched',
  async (t) => {
    for (const suffix of ['-journal', '-shm', '-wal']) {
      await t.test(suffix, async (t) => {
        const fixture = setupImportFixture(t);
        const records = [CURRENT_RECORD, HISTORICAL_RECORD];
        const bytes = jsonlBytes(records);
        writeSource(fixture.sourcePath, bytes);
        await importSource(fixture.databasePath, fixture.sourcePath);
        const targetBefore = captureFile(fixture.databasePath);
        const sourceBefore = captureFile(fixture.sourcePath);
        const sidecarPath = `${fixture.databasePath}${suffix}`;
        const sidecarBytes = Buffer.from(`late replay ${suffix}`);

        await expectImportError(
          () =>
            importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
              if (checkpoint === 'replay_pinned') {
                fs.writeFileSync(sidecarPath, sidecarBytes, { mode: 0o600 });
              }
            }),
          'target_conflict',
        );

        assertFileSnapshot(fixture.databasePath, targetBefore);
        assertFileSnapshot(fixture.sourcePath, sourceBefore);
        assert.deepEqual(fs.readFileSync(sidecarPath), sidecarBytes);
        assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), false);
      });
    }
  },
);

contractTest(
  'replay verification stays pinned when the public target path is replaced',
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [CURRENT_RECORD, HISTORICAL_RECORD];
    const bytes = jsonlBytes(records);
    writeSource(fixture.sourcePath, bytes);
    await importSource(fixture.databasePath, fixture.sourcePath);
    const targetBefore = captureFile(fixture.databasePath);
    const sourceBefore = captureFile(fixture.sourcePath);
    const originalPath = path.join(fixture.directory, 'original-import.sqlite');
    const replacementBytes = Buffer.from('replacement database pathname');

    await expectImportError(
      () =>
        importSourceForTest(fixture.databasePath, fixture.sourcePath, (checkpoint) => {
          if (checkpoint !== 'replay_pinned') return;
          fs.renameSync(fixture.databasePath, originalPath);
          fs.writeFileSync(fixture.databasePath, replacementBytes, { mode: 0o600 });
        }),
      'target_changed',
    );

    assertFileSnapshot(originalPath, targetBefore);
    assert.deepEqual(fs.readFileSync(fixture.databasePath), replacementBytes);
    assertFileSnapshot(fixture.sourcePath, sourceBefore);
    assert.equal(fs.existsSync(stagingDirectoryPath(fixture.databasePath)), false);
  },
);

contractTest(
  'a different byte source cannot reuse an existing receipt or rewrite its target',
  async (t) => {
    const fixture = setupImportFixture(t);
    const records = [CURRENT_RECORD, HISTORICAL_RECORD];
    const firstBytes = jsonlBytes(records, { finalNewline: true });
    const changedBytes = jsonlBytes(records, { finalNewline: false });
    writeSource(fixture.sourcePath, firstBytes);
    await importSource(fixture.databasePath, fixture.sourcePath);
    fs.writeFileSync(fixture.sourcePath, changedBytes);
    const targetBefore = captureFile(fixture.databasePath);

    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'target_conflict',
    );

    assertFileSnapshot(fixture.databasePath, targetBefore);
    assertImportedTarget(fixture.databasePath, firstBytes, records);
  },
);

contractTest('arbitrary and partial existing target states reject without mutation', async (t) => {
  await t.test('arbitrary bytes', async (t) => {
    const fixture = setupImportFixture(t);
    const bytes = jsonlBytes([CURRENT_RECORD]);
    writeSource(fixture.sourcePath, bytes);
    fs.writeFileSync(fixture.databasePath, 'not a Handmark database', { mode: 0o600 });
    const targetBefore = captureFile(fixture.databasePath);

    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'target_conflict',
    );
    assertFileSnapshot(fixture.databasePath, targetBefore);
  });

  await t.test('applications without receipt', async (t) => {
    const fixture = setupImportFixture(t);
    const records = [CURRENT_RECORD, HISTORICAL_RECORD];
    const bytes = jsonlBytes(records);
    writeSource(fixture.sourcePath, bytes);
    await importSource(fixture.databasePath, fixture.sourcePath);

    const database = new DatabaseSync(fixture.databasePath);
    database.exec('DROP TABLE application_import_receipts');
    database.close();
    const targetBefore = captureFile(fixture.databasePath);

    await expectImportError(
      () => importSource(fixture.databasePath, fixture.sourcePath),
      'target_conflict',
    );
    assertFileSnapshot(fixture.databasePath, targetBefore);
    assertTargetRows(fixture.databasePath, records);
  });
});

contractTest('the successful import receipt is sealed against direct mutation', async (t) => {
  const fixture = setupImportFixture(t);
  const records = [CURRENT_RECORD, HISTORICAL_RECORD];
  const bytes = jsonlBytes(records);
  writeSource(fixture.sourcePath, bytes);
  const receipt = await importSource(fixture.databasePath, fixture.sourcePath);
  const database = new DatabaseSync(fixture.databasePath);

  try {
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE application_import_receipts
             SET source_sha256 = ?
             WHERE receipt_key = 'legacy_jsonl_v1'`,
          )
          .run('0'.repeat(64)),
      /immutable|read.only|sealed/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `DELETE FROM application_import_receipts
             WHERE receipt_key = 'legacy_jsonl_v1'`,
          )
          .run(),
      /immutable|read.only|sealed/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO application_import_receipts
             (receipt_key, format_version, source_bytes, source_sha256, record_count,
              ordered_records_sha256)
             VALUES ('other', 1, 0, ?, 0, ?)`,
          )
          .run('0'.repeat(64), sha256(Buffer.alloc(0))),
      /immutable|read.only|sealed/i,
    );
  } finally {
    database.close();
  }

  assert.deepEqual(await importSource(fixture.databasePath, fixture.sourcePath), receipt);
  assertImportedTarget(fixture.databasePath, bytes, records);
});

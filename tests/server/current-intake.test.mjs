import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cookiePair,
  createCurrentClock,
  createCurrentFixture,
  CURRENT_PASSWORD,
  jsonBodyWithExactBytes,
  localFetch,
  login,
  startCurrentServer,
  stopCurrentServer,
  waitForExit,
  waitForOutput,
} from './current-server-harness.mjs';

const FIELD_ORDER = [
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
];

const validApplication = {
  agree: true,
  billingCycle: 'monthly',
  brand: 'Current studio',
  category: 'Furniture',
  contactPreference: 'Email',
  craftSummary: 'A human-made process.',
  email: 'current@example.com',
  name: 'Current maker',
  paymentPreference: 'after-approval',
  plan: 'verification',
  proofLinks: 'https://example.com/proof',
  walkthroughPreference: 'Video call',
  website: 'https://example.com',
};

test('current intake writes the exact ordered 14-field JSONL record, trims text, and ignores extras', async (t) => {
  const fixture = await createCurrentFixture(t);
  const server = await startCurrentServer(fixture);
  const auth = await login(server, { forwardedFor: '198.51.100.50' });
  const cookie = cookiePair(auth);
  const payload = {
    agree: true,
    billingCycle: '  monthly  ',
    brand: '  Current studio  ',
    category: '  Furniture  ',
    contactPreference: '  Email first  ',
    craftSummary: '  Built entirely by hand.  ',
    email: '  maker@example.com  ',
    ignoredNested: { must: 'not persist' },
    ignoredScalar: 'not persisted',
    name: '  Current maker  ',
    paymentPreference: '  after-approval  ',
    plan: '  verification  ',
    proofLinks: '  https://example.com/proof  ',
    walkthroughPreference: '  Video call  ',
    website: '  https://example.com  ',
  };

  const response = await submit(server, cookie, payload, '198.51.100.51');
  assert.equal(response.status, 201);
  const success = await response.json();
  assert.deepEqual(success, {
    id: success.id,
    message: 'Application received. The next step is human review and process walkthrough.',
    ok: true,
  });
  assert.match(success.id, /^HM-[A-F0-9]{8}$/);

  const filePath = path.join(fixture.dataDir, 'applications.jsonl');
  const bytes = await readFile(filePath, 'utf8');
  assert.ok(bytes.endsWith('\n'));
  assert.equal(bytes.split('\n').length, 2);
  const record = JSON.parse(bytes.slice(0, -1));
  assert.deepEqual(Object.keys(record), FIELD_ORDER);
  assert.equal(record.id, success.id);
  assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
  assert.deepEqual(record, {
    billingCycle: 'monthly',
    brand: 'Current studio',
    category: 'Furniture',
    contactPreference: 'Email first',
    craftSummary: 'Built entirely by hand.',
    createdAt: record.createdAt,
    email: 'maker@example.com',
    id: success.id,
    name: 'Current maker',
    paymentPreference: 'after-approval',
    plan: 'verification',
    proofLinks: 'https://example.com/proof',
    walkthroughPreference: 'Video call',
    website: 'https://example.com',
  });
  assert.equal(Object.hasOwn(record, 'agree'), false);
  assert.equal(Object.hasOwn(record, 'ignoredNested'), false);
  assert.equal(Object.hasOwn(record, 'ignoredScalar'), false);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  for (const [index, walkthroughPreference] of [undefined, null, '', '   '].entries()) {
    const optionalPayload = { ...validApplication };
    if (walkthroughPreference === undefined) {
      delete optionalPayload.walkthroughPreference;
    } else {
      optionalPayload.walkthroughPreference = walkthroughPreference;
    }
    const optionalResponse = await submit(
      server,
      cookie,
      optionalPayload,
      `198.51.100.${60 + index}`,
    );
    assert.equal(optionalResponse.status, 201);
  }
  const records = await storedRecords(fixture);
  assert.deepEqual(
    records.slice(1).map((recordEntry) => recordEntry.walkthroughPreference),
    ['', '', '', ''],
  );
});

test('current field types, UTF-16 length boundaries, allowed values, and validation order are executable facts', async (t) => {
  const fixture = await createCurrentFixture(t);
  const server = await startCurrentServer(fixture);
  const cookie = cookiePair(await login(server, { forwardedFor: '198.51.100.70' }));
  let client = 1;
  const nextClient = () => `198.18.${Math.floor(client / 250)}.${(client++ % 250) + 1}`;

  const flexibleBoundaries = [
    ['name', 200, 'x'.repeat(200), 'x'.repeat(201)],
    ['email', 254, `${'a'.repeat(242)}@example.com`, `${'a'.repeat(243)}@example.com`],
    ['contactPreference', 500, 'x'.repeat(500), 'x'.repeat(501)],
    ['brand', 200, 'x'.repeat(200), 'x'.repeat(201)],
    ['website', 2_048, 'x'.repeat(2_048), 'x'.repeat(2_049)],
    ['category', 200, 'x'.repeat(200), 'x'.repeat(201)],
    ['craftSummary', 10_000, 'x'.repeat(10_000), 'x'.repeat(10_001)],
    ['proofLinks', 10_000, 'x'.repeat(10_000), 'x'.repeat(10_001)],
    ['walkthroughPreference', 1_000, 'x'.repeat(1_000), 'x'.repeat(1_001)],
  ];
  for (const [field, limit, acceptedValue, rejectedValue] of flexibleBoundaries) {
    assert.equal(acceptedValue.length, limit);
    const accepted = await submit(
      server,
      cookie,
      { ...validApplication, [field]: acceptedValue },
      nextClient(),
    );
    assert.equal(accepted.status, 201, `${field} at ${limit}`);

    const rejected = await submit(
      server,
      cookie,
      { ...validApplication, [field]: rejectedValue },
      nextClient(),
    );
    assert.equal(rejected.status, 400, `${field} at ${limit + 1}`);
    assert.deepEqual(await rejected.json(), { ok: false, message: `${field} is too long.` });
  }

  const astralAtBoundary = '🪵'.repeat(100);
  const astralOverBoundary = `${astralAtBoundary}x`;
  assert.equal(astralAtBoundary.length, 200);
  assert.equal(astralOverBoundary.length, 201);
  const acceptedAstral = await submit(
    server,
    cookie,
    { ...validApplication, name: astralAtBoundary },
    nextClient(),
  );
  assert.equal(acceptedAstral.status, 201);
  const rejectedAstral = await submit(
    server,
    cookie,
    { ...validApplication, name: astralOverBoundary },
    nextClient(),
  );
  assert.equal(rejectedAstral.status, 400);
  assert.deepEqual(await rejectedAstral.json(), { ok: false, message: 'name is too long.' });

  const enumeratedBoundaries = [
    ['plan', 'Choose a valid plan.'],
    ['billingCycle', 'Choose a valid billing cycle.'],
    ['paymentPreference', 'Choose a valid payment preference.'],
  ];
  for (const [field, invalidMessage] of enumeratedBoundaries) {
    const atLimit = await submit(
      server,
      cookie,
      { ...validApplication, [field]: 'x'.repeat(32) },
      nextClient(),
    );
    assert.equal(atLimit.status, 400);
    assert.deepEqual(await atLimit.json(), { ok: false, message: invalidMessage });

    const overLimit = await submit(
      server,
      cookie,
      { ...validApplication, [field]: 'x'.repeat(33) },
      nextClient(),
    );
    assert.equal(overLimit.status, 400);
    assert.deepEqual(await overLimit.json(), {
      ok: false,
      message: `${field} is too long.`,
    });
  }

  const requiredStrings = [
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
    'paymentPreference',
  ];
  for (const field of requiredStrings) {
    const wrongType = await submit(
      server,
      cookie,
      { ...validApplication, [field]: null },
      nextClient(),
    );
    assert.equal(wrongType.status, 400, `${field} null`);
    assert.deepEqual(await wrongType.json(), { ok: false, message: `${field} must be text.` });

    const blank = await submit(
      server,
      cookie,
      { ...validApplication, [field]: '   ' },
      nextClient(),
    );
    assert.equal(blank.status, 400, `${field} blank`);
    assert.deepEqual(await blank.json(), { ok: false, message: `${field} is required.` });
  }

  const wrongOptionalType = await submit(
    server,
    cookie,
    { ...validApplication, walkthroughPreference: { mode: 'video' } },
    nextClient(),
  );
  assert.equal(wrongOptionalType.status, 400);
  assert.deepEqual(await wrongOptionalType.json(), {
    ok: false,
    message: 'walkthroughPreference must be text.',
  });

  for (const agree of [false, 'true', 1, null]) {
    const response = await submit(server, cookie, { ...validApplication, agree }, nextClient());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, message: 'Agreement is required.' });
  }

  const invalidEmail = await submit(
    server,
    cookie,
    { ...validApplication, email: 'not-an-email' },
    nextClient(),
  );
  assert.equal(invalidEmail.status, 400);
  assert.deepEqual(await invalidEmail.json(), {
    ok: false,
    message: 'Enter a valid email address.',
  });

  const multipleFailures = await submit(
    server,
    cookie,
    {
      ...validApplication,
      agree: false,
      billingCycle: null,
      name: null,
      paymentPreference: null,
      plan: null,
    },
    nextClient(),
  );
  assert.deepEqual(await multipleFailures.json(), { ok: false, message: 'plan must be text.' });

  const agreementPrecedesLaterFields = await submit(
    server,
    cookie,
    {
      ...validApplication,
      agree: false,
      billingCycle: null,
      name: null,
      paymentPreference: null,
    },
    nextClient(),
  );
  assert.deepEqual(await agreementPrecedesLaterFields.json(), {
    ok: false,
    message: 'Agreement is required.',
  });

  const paymentPrecedesApplicantFields = await submit(
    server,
    cookie,
    { ...validApplication, name: null, paymentPreference: null },
    nextClient(),
  );
  assert.deepEqual(await paymentPrecedesApplicantFields.json(), {
    ok: false,
    message: 'paymentPreference must be text.',
  });
});

test('current auth/parser/origin ordering, 64 KiB boundary, and 30-request intake limit are pinned', async (t) => {
  const fixture = await createCurrentFixture(t);
  const now = Date.now();
  const clock = await createCurrentClock(fixture, now);
  const server = await startCurrentServer(fixture, { clockFile: clock.filePath });
  const cookie = cookiePair(await login(server, { forwardedFor: '198.51.100.80' }));

  const signedOutMalformed = await localFetch(`${server.baseUrl}/api/apply`, {
    body: '{',
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(signedOutMalformed.status, 401);
  assert.deepEqual(await signedOutMalformed.json(), { ok: false, message: 'Login required.' });

  const signedOutOversized = await localFetch(`${server.baseUrl}/api/apply`, {
    body: jsonBodyWithExactBytes(validApplication, 64 * 1024 + 1),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(signedOutOversized.status, 401);
  assert.deepEqual(await signedOutOversized.json(), { ok: false, message: 'Login required.' });

  const malformed = await localFetch(`${server.baseUrl}/api/apply`, {
    body: '{',
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, message: 'Request body is invalid.' });

  const jsonNull = await localFetch(`${server.baseUrl}/api/apply`, {
    body: 'null',
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  });
  assert.equal(jsonNull.status, 400);
  assert.deepEqual(await jsonNull.json(), { ok: false, message: 'Request body is invalid.' });

  const jsonArray = await localFetch(`${server.baseUrl}/api/apply`, {
    body: '[]',
    headers: { 'content-type': 'application/json', cookie },
    method: 'POST',
  });
  assert.equal(jsonArray.status, 400);
  assert.deepEqual(await jsonArray.json(), { ok: false, message: 'plan must be text.' });

  const wrongMediaType = await localFetch(`${server.baseUrl}/api/apply`, {
    body: JSON.stringify(validApplication),
    headers: { 'content-type': 'text/plain', cookie },
    method: 'POST',
  });
  assert.equal(wrongMediaType.status, 400);
  assert.deepEqual(await wrongMediaType.json(), { ok: false, message: 'plan must be text.' });

  const exactBody = await localFetch(`${server.baseUrl}/api/apply`, {
    body: jsonBodyWithExactBytes(validApplication, 64 * 1024),
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-forwarded-for': '198.51.100.81',
    },
    method: 'POST',
  });
  assert.equal(exactBody.status, 201);

  const oversized = await localFetch(`${server.baseUrl}/api/apply`, {
    body: jsonBodyWithExactBytes(validApplication, 64 * 1024 + 1),
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-forwarded-for': '198.51.100.82',
    },
    method: 'POST',
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    ok: false,
    message: 'Request body is too large.',
  });

  const parserFailureClient = '203.0.113.209';
  const oversizedBody = jsonBodyWithExactBytes(validApplication, 64 * 1024 + 1);
  for (let attempt = 1; attempt <= 31; attempt += 1) {
    const malformedBeforeLimiter = await localFetch(`${server.baseUrl}/api/apply`, {
      body: '{',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-forwarded-for': parserFailureClient,
      },
      method: 'POST',
    });
    assert.equal(malformedBeforeLimiter.status, 400, `malformed parser failure ${attempt}`);

    const oversizedBeforeLimiter = await localFetch(`${server.baseUrl}/api/apply`, {
      body: oversizedBody,
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-forwarded-for': parserFailureClient,
      },
      method: 'POST',
    });
    assert.equal(oversizedBeforeLimiter.status, 413, `oversized parser failure ${attempt}`);
  }
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const reachesLimiter = await submit(server, cookie, {}, parserFailureClient);
    assert.equal(reachesLimiter.status, 400, `post-parser intake attempt ${attempt}`);
  }
  const parserFailuresDidNotConsumeCapacity = await submit(
    server,
    cookie,
    validApplication,
    parserFailureClient,
  );
  assert.equal(parserFailuresDidNotConsumeCapacity.status, 429);
  assert.deepEqual(await parserFailuresDidNotConsumeCapacity.json(), {
    ok: false,
    message: 'Too many applications. Try again later.',
  });

  // Intentional legacy fact: authenticated cross-origin mutations are accepted. The target shared
  // gate owns a fail-closed origin contract, so this expectation is deliberately migration-facing.
  const crossOrigin = await localFetch(`${server.baseUrl}/api/apply`, {
    body: JSON.stringify(validApplication),
    headers: {
      'content-type': 'application/json',
      cookie,
      origin: 'https://attacker.invalid',
      'x-forwarded-for': '198.51.100.83',
    },
    method: 'POST',
  });
  assert.equal(crossOrigin.status, 201);
  assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null);

  const limitedClient = '203.0.113.210';
  const beforeLimit = (await storedRecords(fixture)).length;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await submit(server, cookie, {}, limitedClient);
    assert.equal(response.status, 400, `intake attempt ${attempt}`);
    assert.deepEqual(await response.json(), { ok: false, message: 'plan must be text.' });
  }
  const blocked = await submit(server, cookie, validApplication, limitedClient);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), {
    ok: false,
    message: 'Too many applications. Try again later.',
  });
  assert.equal((await storedRecords(fixture)).length, beforeLimit);

  await clock.set(now + 60 * 60 * 1000 - 1);
  const blockedOneMillisecondBeforeReset = await submit(
    server,
    cookie,
    validApplication,
    limitedClient,
  );
  assert.equal(blockedOneMillisecondBeforeReset.status, 429);

  await clock.set(now + 60 * 60 * 1000);
  const allowedAtExactReset = await submit(server, cookie, validApplication, limitedClient);
  assert.equal(allowedAtExactReset.status, 201);
  assert.equal((await storedRecords(fixture)).length, beforeLimit + 1);

  // Login and intake are separate scopes even for the same forwarded client address.
  const separateLoginScope = await login(server, {
    forwardedFor: limitedClient,
    password: CURRENT_PASSWORD,
  });
  assert.equal(separateLoginScope.status, 302);
  assert.equal(separateLoginScope.headers.get('location'), '/');
});

test('current concurrent intake is line-safe while legacy SIGTERM drops a partially received request', async (t) => {
  const fixture = await createCurrentFixture(t);
  const server = await startCurrentServer(fixture);
  const cookie = cookiePair(await login(server, { forwardedFor: '198.51.100.90' }));

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      submit(
        server,
        cookie,
        { ...validApplication, name: `Concurrent maker ${index}` },
        '198.51.100.91',
      ),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    Array(20).fill(201),
  );
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(results.map((result) => result.id)).size, 20);
  const concurrentRecords = await storedRecords(fixture);
  assert.equal(concurrentRecords.length, 20);
  assert.deepEqual(
    new Set(concurrentRecords.map((record) => record.name)),
    new Set(Array.from({ length: 20 }, (_, index) => `Concurrent maker ${index}`)),
  );

  const drainingPayload = {
    ...validApplication,
    craftSummary: 'x'.repeat(9_000),
    name: 'Shutdown-drained maker',
  };
  const rawResponse = await postSlowApplicationAndSignal(server, cookie, drainingPayload);
  assert.match(rawResponse, /HTTP\/1\.1 100 Continue\r\n/);
  // Intentional legacy fact: server.close() closes this accepted, partially received request and
  // exits successfully without a final response. The target shared shutdown contract must drain
  // accepted mutation requests rather than preserving this behavior through a compatibility path.
  assert.doesNotMatch(rawResponse, /HTTP\/1\.1 201 Created\r\n/);
  const exit = await waitForExit(server);
  assert.deepEqual(exit, { code: 0, signal: null }, server.output());
  assert.match(server.output(), /shutting down \(SIGTERM\)/);

  const finalRecords = await storedRecords(fixture);
  assert.equal(finalRecords.length, 20);
  assert.equal(
    finalRecords.some((record) => record.name === 'Shutdown-drained maker'),
    false,
  );
});

test('current SIGTERM drains a fully parsed application already writing to storage', async (t) => {
  const fixture = await createCurrentFixture(t);
  const server = await startCurrentServer(fixture);
  const cookie = cookiePair(await login(server, { forwardedFor: '198.51.100.93' }));
  const createdAt = new Date().toISOString();
  const existingRecords = Array.from({ length: 9_999 }, (_, index) => ({
    createdAt,
    id: `shutdown-existing-${index}`,
  }));
  await writeFile(
    path.join(fixture.dataDir, 'applications.jsonl'),
    `${existingRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );

  const responsePromise = submit(
    server,
    cookie,
    { ...validApplication, name: 'Fully received shutdown maker' },
    '198.51.100.94',
  );
  await waitForCompactionTemp(server);
  server.child.kill('SIGTERM');

  const response = await responsePromise;
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.id, /^HM-[A-F0-9]{8}$/);
  const exit = await waitForExit(server);
  assert.deepEqual(exit, { code: 0, signal: null }, server.output());
  assert.match(server.output(), /shutting down \(SIGTERM\)/);

  const finalRecords = await storedRecords(fixture);
  assert.equal(finalRecords.length, 10_000);
  assert.equal(finalRecords.at(-1).id, result.id);
  assert.equal(finalRecords.at(-1).name, 'Fully received shutdown maker');
});

test('current unhealthy and full JSONL storage keep health green but reject intake without a write', async (t) => {
  await t.test('unhealthy path returns the current 503 storage envelope', async (storageTest) => {
    const fixture = await createCurrentFixture(storageTest);
    await mkdir(path.join(fixture.dataDir, 'applications.jsonl'));
    const server = await startCurrentServer(fixture);
    assert.equal((await localFetch(`${server.baseUrl}/healthz`)).status, 200);
    const cookie = cookiePair(await login(server, { forwardedFor: '198.51.100.100' }));
    const response = await submit(server, cookie, validApplication, '198.51.100.101');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: 'application_storage_error',
      message: 'Application storage needs administrator attention. No application was written.',
      ok: false,
    });
    assert.match(server.output(), /application storage needs attention/);
  });

  await t.test(
    '10,000 retained records return the current 507 capacity envelope',
    async (storageTest) => {
      const fixture = await createCurrentFixture(storageTest);
      const createdAt = new Date().toISOString();
      const originalRecords = Array.from({ length: 10_000 }, (_, index) => ({
        createdAt,
        id: `synthetic-${index}`,
      }));
      await writeFile(
        path.join(fixture.dataDir, 'applications.jsonl'),
        `${originalRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
        { mode: 0o600 },
      );
      const server = await startCurrentServer(fixture);
      assert.equal((await localFetch(`${server.baseUrl}/healthz`)).status, 200);
      const cookie = cookiePair(await login(server, { forwardedFor: '198.51.100.102' }));
      const response = await submit(server, cookie, validApplication, '198.51.100.103');
      assert.equal(response.status, 507);
      assert.deepEqual(await response.json(), {
        code: 'storage_full',
        message:
          'Handmark cannot accept another application because application storage is full. Please try again later.',
        ok: false,
      });
      const after = await storedRecords(fixture);
      assert.equal(after.length, 10_000);
      assert.equal(after.at(0).id, 'synthetic-0');
      assert.equal(after.at(-1).id, 'synthetic-9999');
    },
  );
});

async function submit(server, cookie, payload, forwardedFor) {
  return await localFetch(`${server.baseUrl}/api/apply`, {
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-forwarded-for': forwardedFor,
    },
    method: 'POST',
  });
}

async function storedRecords(fixture) {
  const filePath = path.join(fixture.dataDir, 'applications.jsonl');
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return contents
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function postSlowApplicationAndSignal(server, cookie, payload) {
  const body = JSON.stringify(payload);
  const midpoint = Math.floor(body.length / 2);
  let response = '';
  const socket = net.createConnection({ host: '127.0.0.1', port: server.port });
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    response += chunk;
  });
  const closed = new Promise((resolveClose, reject) => {
    socket.once('error', reject);
    socket.once('close', resolveClose);
  });
  await new Promise((resolveConnect, reject) => {
    socket.once('connect', resolveConnect);
    socket.once('error', reject);
  });
  socket.write(
    [
      'POST /api/apply HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      `Cookie: ${cookie}`,
      'X-Forwarded-For: 198.51.100.92',
      'Expect: 100-continue',
      'Connection: close',
      '',
      '',
    ].join('\r\n'),
  );

  const continueDeadline = Date.now() + 2_000;
  while (!response.includes('HTTP/1.1 100 Continue\r\n\r\n')) {
    if (Date.now() >= continueDeadline) {
      throw new Error(`Handmark did not accept the streaming request.\n${response}`);
    }
    await delay(10);
  }
  socket.write(body.slice(0, midpoint));
  await delay(20);
  server.child.kill('SIGTERM');
  await waitForOutput(server, /shutting down \(SIGTERM\)/);
  socket.end(body.slice(midpoint));
  await closed;
  return response;
}

async function waitForCompactionTemp(server, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(server.fixture.dataDir);
    if (entries.some((entry) => entry.startsWith('applications.jsonl.compact-'))) return;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Handmark exited before the storage write began.\n${server.output()}`);
    }
    await delay(2);
  }
  throw new Error(`Timed out waiting for the accepted storage write.\n${server.output()}`);
}

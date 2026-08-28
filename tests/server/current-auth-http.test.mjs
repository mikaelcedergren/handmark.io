import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cookiePair,
  createCurrentClock,
  createCurrentFixture,
  CURRENT_PASSWORD,
  CURRENT_SESSION_SECRET,
  formBodyWithExactBytes,
  localFetch,
  login,
  SESSION_MAX_AGE_MS,
  signedSessionCookie,
  startCurrentServer,
  stopCurrentServer,
} from './current-server-harness.mjs';

test('current branded gate and public/protected cache matrix remain explicit before migration', async (t) => {
  const fixture = await createCurrentFixture(t);
  const server = await startCurrentServer(fixture);

  const health = await localFetch(`${server.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    app: 'handmark.io',
    ok: true,
    port: server.port,
  });
  assertSecurityHeaders(health);
  assert.equal(health.headers.get('cache-control'), null);
  assert.equal(health.headers.get('x-robots-tag'), null);

  const loginPage = await localFetch(`${server.baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers.get('cache-control'), 'no-cache');
  assert.equal(loginPage.headers.get('x-robots-tag'), null);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /<title>Handmark access \| human-made work verification<\/title>/);
  assert.match(
    loginHtml,
    /content="Private access to the Handmark proof of concept for human-made work verification\."/,
  );
  assert.match(loginHtml, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.match(loginHtml, /<link rel="stylesheet" href="\/styles\.css" \/>/);
  assert.match(
    loginHtml,
    /<link rel="icon" href="\/assets\/handmark-symbol\.svg\?v=20260603-2" type="image\/svg\+xml" \/>/,
  );
  assert.match(
    loginHtml,
    /<img class="login-mark" src="\/assets\/handmark-logo\.svg\?v=20260603-2" alt="" \/>/,
  );
  assert.match(loginHtml, /Human-made work, verified\./);
  assert.match(loginHtml, /Private proof of concept/);
  assert.match(loginHtml, /<form class="login-form" method="post" action="\/login">/);
  assert.match(loginHtml, /<label for="password" class="login-label">Access password<\/label>/);
  assert.match(loginHtml, /name="password"/);
  assert.match(loginHtml, /type="password"/);
  assert.match(loginHtml, /autocomplete="current-password"/);
  assert.match(loginHtml, /required\s+autofocus/);
  assert.match(
    loginHtml,
    /<p class="login-error cx-text-body-sm" data-error>Incorrect password\. Try again\.<\/p>/,
  );
  assert.match(loginHtml, /Enter Handmark/);
  assert.match(loginHtml, /new URLSearchParams\(window\.location\.search\)\.has\('error'\)/);
  assert.match(
    loginHtml,
    /document\.documentElement\.toggleAttribute\('data-login-error', hasError\)/,
  );

  const wrongPassword = await login(server, {
    forwardedFor: '198.51.100.11',
    password: 'wrong-current-password',
  });
  assert.equal(wrongPassword.status, 302);
  assert.equal(wrongPassword.headers.get('location'), '/login?error=1');
  const errorPage = await localFetch(`${server.baseUrl}/login?error=1`);
  assert.equal(errorPage.status, 200);
  assert.equal(await errorPage.text(), loginHtml);

  const publicFiles = [
    ['/styles.css', 'public, max-age=0'],
    ['/robots.txt', 'public, max-age=0'],
    ['/sitemap.xml', 'public, max-age=0'],
    ['/site.webmanifest', 'public, max-age=0'],
    ['/cx-build.json', 'no-cache'],
  ];
  for (const [requestPath, cacheControl] of publicFiles) {
    const response = await localFetch(`${server.baseUrl}${requestPath}`);
    assert.equal(response.status, 200, requestPath);
    assert.equal(response.headers.get('cache-control'), cacheControl, requestPath);
    assert.equal(response.headers.get('x-robots-tag'), null, requestPath);
  }

  const publicAsset = await localFetch(`${server.baseUrl}/assets/handmark-logo.svg`);
  assert.equal(publicAsset.status, 200);
  assert.equal(publicAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(publicAsset.headers.get('content-type'), /^image\/svg\+xml/);

  const publicSymbol = await localFetch(`${server.baseUrl}/assets/handmark-symbol.svg`);
  assert.equal(publicSymbol.status, 200);
  assert.equal(publicSymbol.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(publicSymbol.headers.get('content-type'), /^image\/svg\+xml/);

  for (const requestPath of ['/', '/private-route', '/index.html', '/login.html']) {
    const response = await localFetch(`${server.baseUrl}${requestPath}`, {
      redirect: 'manual',
    });
    assert.equal(response.status, 302, requestPath);
    assert.equal(response.headers.get('location'), '/login', requestPath);
    assert.equal(response.headers.get('cache-control'), null, requestPath);
    assert.equal(response.headers.get('x-robots-tag'), null, requestPath);
  }

  const signedOutApply = await localFetch(`${server.baseUrl}/api/apply`, {
    method: 'POST',
  });
  assert.equal(signedOutApply.status, 401);
  assert.deepEqual(await signedOutApply.json(), { ok: false, message: 'Login required.' });
  assert.equal(signedOutApply.headers.get('cache-control'), null);
  assert.equal(signedOutApply.headers.get('x-robots-tag'), null);

  const signedOutUnknownApi = await localFetch(`${server.baseUrl}/api/not-a-route`);
  assert.equal(signedOutUnknownApi.status, 401);
  assert.deepEqual(await signedOutUnknownApi.json(), {
    ok: false,
    message: 'Login required.',
  });

  const authResponse = await login(server, { forwardedFor: '198.51.100.10' });
  assert.equal(authResponse.status, 302);
  const cookie = cookiePair(authResponse);

  const protectedPage = await localFetch(`${server.baseUrl}/`, { headers: { cookie } });
  assert.equal(protectedPage.status, 200);
  assert.equal(protectedPage.headers.get('cache-control'), 'no-cache');
  assert.equal(protectedPage.headers.get('x-robots-tag'), null);
  assert.match(await protectedPage.text(), /<meta name="robots" content="index, follow" \/>/);

  const protectedFallback = await localFetch(`${server.baseUrl}/private-route`, {
    headers: { cookie },
  });
  assert.equal(protectedFallback.status, 200);
  assert.equal(protectedFallback.headers.get('cache-control'), 'no-cache');

  const authenticatedUnknownApi = await localFetch(`${server.baseUrl}/api/not-a-route`, {
    headers: { cookie },
  });
  assert.equal(authenticatedUnknownApi.status, 404);
  assert.deepEqual(await authenticatedUnknownApi.json(), {
    ok: false,
    message: 'API route not found.',
  });

  const hashedAsset = await localFetch(`${server.baseUrl}/main-CURRENT123.js`, {
    headers: { cookie },
  });
  assert.equal(hashedAsset.status, 200);
  assert.equal(hashedAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const missingAsset = await localFetch(`${server.baseUrl}/main-MISSING123.js`, {
    headers: { cookie },
  });
  assert.equal(missingAsset.status, 404);
  assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
  assert.equal(await missingAsset.text(), 'Asset not found');
});

test('current login parsing, cookie attributes, origin policy, and 20-request limit stay characterized', async (t) => {
  const fixture = await createCurrentFixture(t);
  const now = Date.now();
  const clock = await createCurrentClock(fixture, now);
  const server = await startCurrentServer(fixture, { clockFile: clock.filePath });

  const wrong = await login(server, {
    forwardedFor: '198.51.100.20',
    password: 'definitely-wrong',
  });
  assert.equal(wrong.status, 302);
  assert.equal(wrong.headers.get('location'), '/login?error=1');
  assert.equal(wrong.headers.get('set-cookie'), null);

  const missing = await localFetch(`${server.baseUrl}/login`, {
    body: '',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '198.51.100.21',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(missing.status, 302);
  assert.equal(missing.headers.get('location'), '/login?error=1');

  const jsonIsNotParsedAsAForm = await localFetch(`${server.baseUrl}/login`, {
    body: JSON.stringify({ password: CURRENT_PASSWORD }),
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.22',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(jsonIsNotParsedAsAForm.status, 302);
  assert.equal(jsonIsNotParsedAsAForm.headers.get('location'), '/login?error=1');

  const malformedEncoding = await localFetch(`${server.baseUrl}/login`, {
    body: 'password=%E0%A4%A',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '198.51.100.23',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(malformedEncoding.status, 302);
  assert.equal(malformedEncoding.headers.get('location'), '/login?error=1');

  const duplicatePassword = await localFetch(`${server.baseUrl}/login`, {
    body: new URLSearchParams([
      ['password', CURRENT_PASSWORD],
      ['password', CURRENT_PASSWORD],
    ]),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '198.51.100.24',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(duplicatePassword.status, 302);
  assert.equal(duplicatePassword.headers.get('location'), '/login?error=1');

  const exactBody = await localFetch(`${server.baseUrl}/login`, {
    body: formBodyWithExactBytes(CURRENT_PASSWORD, 16 * 1024),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '198.51.100.25',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(exactBody.status, 302);
  assert.equal(exactBody.headers.get('location'), '/');

  const oversizedBody = await localFetch(`${server.baseUrl}/login`, {
    body: formBodyWithExactBytes(CURRENT_PASSWORD, 16 * 1024 + 1),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '198.51.100.26',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(oversizedBody.status, 413);
  assert.equal(await oversizedBody.text(), 'Request body is too large.');

  const plainHttp = await login(server, { forwardedFor: '198.51.100.27' });
  assert.equal(plainHttp.status, 302);
  const plainSetCookie = plainHttp.headers.get('set-cookie');
  assert.ok(plainSetCookie);
  const [plainCookiePair, ...plainAttributes] = plainSetCookie.split('; ');
  assert.match(plainCookiePair, /^hm_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(plainAttributes, [
    'Max-Age=43200',
    'Path=/',
    `Expires=${new Date(now + SESSION_MAX_AGE_MS).toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ]);

  const forwardedHttps = await login(server, {
    forwardedFor: '198.51.100.28',
    proto: 'https',
  });
  assert.equal(forwardedHttps.status, 302);
  const forwardedSetCookie = forwardedHttps.headers.get('set-cookie');
  assert.ok(forwardedSetCookie);
  const [forwardedCookiePair, ...forwardedAttributes] = forwardedSetCookie.split('; ');
  assert.match(forwardedCookiePair, /^hm_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(forwardedAttributes, [
    'Max-Age=43200',
    'Path=/',
    `Expires=${new Date(now + SESSION_MAX_AGE_MS).toUTCString()}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ]);

  // Intentional legacy fact: there is no request-origin check yet. The shared gate migration is
  // expected to replace this with the common fail-closed mutation-origin policy.
  const crossOrigin = await login(server, {
    forwardedFor: '198.51.100.29',
    origin: 'https://attacker.invalid',
  });
  assert.equal(crossOrigin.status, 302);
  assert.equal(crossOrigin.headers.get('location'), '/');
  assert.ok(crossOrigin.headers.get('set-cookie'));
  assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null);

  const limitedClient = '203.0.113.200';
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await login(server, {
      forwardedFor: limitedClient,
      password: `wrong-${attempt}`,
    });
    assert.equal(response.status, 302, `login attempt ${attempt}`);
    assert.equal(response.headers.get('location'), '/login?error=1');
  }
  const blocked = await login(server, {
    forwardedFor: limitedClient,
    password: CURRENT_PASSWORD,
  });
  assert.equal(blocked.status, 429);
  assert.equal(await blocked.text(), 'Too many login attempts. Try again later.');

  await clock.set(now + 15 * 60 * 1000 - 1);
  const blockedOneMillisecondBeforeReset = await login(server, {
    forwardedFor: limitedClient,
    password: CURRENT_PASSWORD,
  });
  assert.equal(blockedOneMillisecondBeforeReset.status, 429);

  await clock.set(now + 15 * 60 * 1000);
  const allowedAtExactReset = await login(server, {
    forwardedFor: limitedClient,
    password: CURRENT_PASSWORD,
  });
  assert.equal(allowedAtExactReset.status, 302);
  assert.equal(allowedAtExactReset.headers.get('location'), '/');

  const distinctForwardedClient = await login(server, {
    forwardedFor: '203.0.113.201',
  });
  assert.equal(distinctForwardedClient.status, 302);
  assert.equal(distinctForwardedClient.headers.get('location'), '/');
});

test('current signed-cookie boundary, restart, secret, tamper, and legacy duplicate behavior are pinned', async (t) => {
  const now = Date.parse('2026-08-25T08:00:00.000Z');
  const fixture = await createCurrentFixture(t);
  let server = await startCurrentServer(fixture, { nowMs: now });

  async function protectedStatus(cookie) {
    const response = await localFetch(`${server.baseUrl}/`, {
      headers: { cookie },
      redirect: 'manual',
    });
    return response.status;
  }

  const current = signedSessionCookie({ issuedAt: now, nonce: 'current' });
  const exactExpiry = signedSessionCookie({
    issuedAt: now - SESSION_MAX_AGE_MS,
    nonce: 'boundary',
  });
  const expired = signedSessionCookie({
    issuedAt: now - SESSION_MAX_AGE_MS - 1,
    nonce: 'expired',
  });
  const future = signedSessionCookie({ issuedAt: now + 1, nonce: 'future' });
  assert.equal(await protectedStatus(current), 200);
  assert.equal(await protectedStatus(exactExpiry), 200);
  assert.equal(await protectedStatus(expired), 302);
  assert.equal(await protectedStatus(future), 302);

  // Intentional legacy facts: the payload nonce is not validated and a third token segment is
  // ignored. Both disappear when the shared signed-gate cookie replaces this bespoke reader.
  assert.equal(await protectedStatus(signedSessionCookie({ issuedAt: now })), 200);
  assert.equal(
    await protectedStatus(
      signedSessionCookie({ issuedAt: now, nonce: 'extra-segment' }, CURRENT_SESSION_SECRET, '.x'),
    ),
    200,
  );

  const tamperedSignature = `${current.slice(0, -1)}${current.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(await protectedStatus(tamperedSignature), 302);
  assert.equal(await protectedStatus('hm_session=%'), 302);
  assert.equal(await protectedStatus('hm_session=not-a-token'), 302);

  // Intentional legacy fact: the first duplicate wins. The target common cookie parser rejects
  // duplicate session cookies instead of allowing header order to decide authentication.
  assert.equal(await protectedStatus(`${current}; hm_session=tampered`), 200);
  assert.equal(await protectedStatus(`hm_session=tampered; ${current}`), 302);

  const loginResponse = await login(server, { forwardedFor: '198.51.100.40' });
  const issuedCookie = cookiePair(loginResponse);
  const [encodedPayload] = issuedCookie.slice('hm_session='.length).split('.');
  const issuedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(issuedPayload), ['issuedAt', 'nonce']);
  assert.equal(issuedPayload.issuedAt, now);
  assert.match(issuedPayload.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(issuedPayload.nonce, 'base64url').byteLength, 16);
  assert.equal(issuedCookie, signedSessionCookie(issuedPayload));
  assert.equal(await protectedStatus(issuedCookie), 200);

  const anonymousLogout = await localFetch(`${server.baseUrl}/logout`, {
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(anonymousLogout.status, 302);
  assert.equal(anonymousLogout.headers.get('location'), '/login');
  const cleared = anonymousLogout.headers.get('set-cookie');
  assert.ok(cleared);
  assert.deepEqual(cleared.split('; '), [
    'hm_session=',
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ]);

  await stopCurrentServer(server);
  server = await startCurrentServer(fixture, { nowMs: now });
  assert.equal(await protectedStatus(issuedCookie), 200);

  await stopCurrentServer(server);
  server = await startCurrentServer(fixture, {
    nowMs: now,
    sessionSecret: 'different-current-session-secret-for-tests',
  });
  assert.equal(await protectedStatus(issuedCookie), 302);
});

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(
    response.headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=()',
  );
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('origin-agent-cluster'), '?1');
  assert.equal(response.headers.get('x-powered-by'), null);
}

const { test, expect } = require('@playwright/test');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const unexpectedExternalRequests = new WeakMap();

const baseUrl = requiredEnvironment('HANDMARK_BASE_URL');
const password = requiredEnvironment('HANDMARK_TEST_PASSWORD');
const runtimeRoot = path.resolve(requiredEnvironment('HANDMARK_E2E_RUNTIME_ROOT'));
const databasePath = path.resolve(requiredEnvironment('HANDMARK_E2E_DB_PATH'));
const screenshotDir = path.resolve(requiredEnvironment('HANDMARK_E2E_SCREENSHOT_DIR'));
const repoDataDir = path.resolve(__dirname, '..', '..', 'data');
const dataDir = path.resolve(requiredEnvironment('HANDMARK_E2E_DATA_DIR'));
const parsedBaseUrl = new URL(baseUrl);
const ownedE2EPort = Number(parsedBaseUrl.port);
const otherE2EOrigin = `http://127.0.0.1:${ownedE2EPort === 49_152 ? 49_153 : 49_152}`;
if (
  parsedBaseUrl.origin !== baseUrl ||
  parsedBaseUrl.hostname !== '127.0.0.1' ||
  parsedBaseUrl.port === '3000' ||
  dataDir === repoDataDir ||
  !isContainedPath(runtimeRoot, dataDir) ||
  !isContainedPath(runtimeRoot, databasePath) ||
  !isContainedPath(runtimeRoot, screenshotDir)
) {
  throw new Error('Handmark E2E refuses non-owned, production, or non-loopback runtime state.');
}

test.beforeEach(async ({ context }) => {
  const unexpected = [];
  unexpectedExternalRequests.set(context, unexpected);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseUrl) {
      await route.continue();
      return;
    }

    unexpected.push(`${request.method()} ${url.href}`);
    await route.abort('blockedbyclient');
  });
});

test.afterEach(async ({ context }) => {
  expect(unexpectedExternalRequests.get(context) ?? []).toEqual([]);
});

test('the browser records and blocks every origin except its exact E2E server', async ({
  context,
  page,
}) => {
  const blockedUrls = [
    'http://127.0.0.1:3000/healthz',
    `${otherE2EOrigin}/healthz`,
    'https://cx-network-isolation.invalid/probe',
  ];
  for (const blockedUrl of blockedUrls) {
    const failedRequest = page.waitForEvent(
      'requestfailed',
      (request) => request.url() === blockedUrl,
    );
    await page.goto(blockedUrl).catch(() => undefined);
    expect((await failedRequest).failure()?.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');
  }
  const recorded = unexpectedExternalRequests.get(context);
  expect(recorded).toEqual(blockedUrls.map((url) => `GET ${url}`));
  recorded?.splice(0);
});

test('browser launch transport sends production through the owned proxy', async ({
  context,
  page,
}) => {
  await context.unroute('**/*');
  const response = await page.goto('http://127.0.0.1:3000/cx-e2e-launch-proxy-proof');
  expect(response?.status()).toBe(403);
  expect(await response?.text()).toContain('E2E proxy denied this origin.');
});

test('API and test-process transports cannot reach another origin', async ({ request }) => {
  for (const url of [
    'http://127.0.0.1:3000/healthz',
    `${otherE2EOrigin}/healthz`,
    'http://cx-network-isolation.invalid/probe',
  ]) {
    const response = await request.get(url, { maxRedirects: 0 });
    expect(response.status()).toBe(403);
  }
  const blockedHttpsUrl = 'https://cx-network-isolation.invalid/probe';
  const blockedHttpsResponse = await request.get(blockedHttpsUrl, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  expect(blockedHttpsResponse.url()).toBe(blockedHttpsUrl);
  expect(blockedHttpsResponse.status()).toBe(403);
  await expect(fetch('http://127.0.0.1:3000/healthz')).rejects.toThrow(
    'E2E network isolation blocked',
  );
});

test('Handmark night-mode membership flow', async ({ page, request }) => {
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await fs.mkdir(screenshotDir, { recursive: true });

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(`${baseUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Human-made work, verified.' })).toBeVisible();
  await expect(page.getByLabel('Access password')).toBeVisible();
  await expect(page.locator('script')).toHaveCount(0);

  const publicLogo = await request.get(`${baseUrl}/assets/handmark-logo.svg`, {
    maxRedirects: 0,
  });
  expect(publicLogo.status()).toBe(200);
  for (const lockedPath of [
    '/assets/handmark-stamp.svg',
    '/assets/handmark-seal.svg',
    '/assets/handmark-og.png',
    '/assets/arbitrary.svg',
  ]) {
    const lockedAsset = await request.get(`${baseUrl}${lockedPath}`, { maxRedirects: 0 });
    expect(lockedAsset.status(), lockedPath).toBe(302);
    expect(lockedAsset.headers().location, lockedPath).toBe('/login');
  }

  const loginMetrics = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  // Night theme surface from the framework tokens.
  expect(loginMetrics.background).toBe('rgb(0, 0, 0)');
  expect(loginMetrics.overflow).toBe(false);

  await page.screenshot({
    path: path.join(screenshotDir, 'handmark-login.png'),
    fullPage: true,
  });

  await page.getByLabel('Access password').fill('incorrect-handmark-password');
  await page.getByRole('button', { name: 'Enter Handmark' }).click();
  await expect(page).toHaveURL(`${baseUrl}/login?error=1`);
  await expect(page.getByRole('alert')).toHaveText('Incorrect password. Try again.');
  await expect(page.locator('script')).toHaveCount(0);

  await page.getByLabel('Access password').fill(password);
  await page.getByRole('button', { name: 'Enter Handmark' }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await page.setViewportSize({ width: 2048, height: 1152 });

  await expect(page.getByRole('heading', { name: 'Handmark', exact: true })).toBeVisible();
  await expect(page.getByText('A public trust mark for work made by a person.')).toBeVisible();
  await expect(page.getByText('The $99 fee starts the review. Approval is earned.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Walkthrough required' })).toBeVisible();
  await expect(page.getByText(/Submitted proof is only the beginning/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'More than a badge on a page.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Selective by design.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No proof, no stamp' })).toBeVisible();
  await expect(page.locator('.proof-page-top').getByText('Public proof page')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'One subscription. One standard.' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Handmark Verification' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Starter', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Studio', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'House', exact: true })).toHaveCount(0);

  const seo = await page.evaluate(() => {
    const schema = JSON.parse(
      document.querySelector('script[type="application/ld+json"]').textContent,
    );
    const heroRect = document.querySelector('.hero-grid').getBoundingClientRect();
    const storyRect = document.querySelector('.section-grid').getBoundingClientRect();
    const membershipRect = document.querySelector('.membership-card').getBoundingClientRect();
    const storyParagraph = document.querySelector('.story-copy p').getBoundingClientRect();
    const formRect = document.querySelector('.application-form').getBoundingClientRect();
    const conversionRect = document.querySelector('.conversion-strip').getBoundingClientRect();
    const heroSection = document.querySelector('.hero');
    const firstSection = document.querySelector('.section');
    const conversionStrip = document.querySelector('.conversion-strip');
    const formEl = document.querySelector('.application-form');
    const heroTitle = document.querySelector('.hero h1');
    const heroTitleStyles = getComputedStyle(heroTitle);
    const styles = (el) => {
      const computed = getComputedStyle(el);
      return {
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        gap: computed.gap,
      };
    };
    return {
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content,
      canonical: document.querySelector('link[rel="canonical"]')?.href,
      offerName: schema.offers.name,
      offerPrice: schema.offers.price,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      heroWidth: Math.round(heroRect.width),
      storyWidth: Math.round(storyRect.width),
      membershipWidth: Math.round(membershipRect.width),
      storyLineWidth: Math.round(storyParagraph.width),
      formWidth: Math.round(formRect.width),
      conversionTop: Math.round(conversionRect.top),
      heroStyles: styles(heroSection),
      sectionStyles: styles(firstSection),
      conversionStyles: styles(conversionStrip),
      membershipSurface: document.querySelector('.membership-card')?.tagName,
      applicationSurface: formEl.querySelector('.application-card')?.tagName,
      buyerSurfaceCount: document.querySelectorAll('.buyer-card > cx-card').length,
      heroTitleSize: Number.parseFloat(heroTitleStyles.fontSize),
      heroTitleLineHeight: Number.parseFloat(heroTitleStyles.lineHeight),
    };
  });
  expect(seo.title).toContain('human-made work verification');
  expect(seo.description).toContain('public trust mark');
  expect(seo.canonical).toBe('https://handmark.io/');
  expect(seo.offerName).toBe('Handmark Human Review');
  expect(seo.offerPrice).toBe('99');
  expect(seo.overflow).toBe(false);
  // Content column caps at the framework page measure (--measure-xl).
  expect(seo.heroWidth).toBeLessThanOrEqual(1180);
  expect(seo.storyWidth).toBeLessThanOrEqual(1180);
  expect(seo.membershipWidth).toBeLessThanOrEqual(1180);
  expect(seo.storyLineWidth).toBeLessThanOrEqual(1180);
  // Application form caps at the framework --measure-md (640px).
  expect(seo.formWidth).toBeLessThanOrEqual(640);
  expect(seo.conversionTop).toBeLessThan(1080);
  // Primary hero call to action is the framework cx-button.
  await expect(page.getByRole('button', { name: 'Start human review' })).toBeVisible();
  // Section rhythm uses the framework spacing scale (--space-2xl = 64px).
  expect(seo.heroStyles.paddingTop).toBe('64px');
  expect(seo.heroStyles.paddingBottom).toBe('64px');
  expect(seo.sectionStyles.paddingTop).toBe('64px');
  expect(seo.sectionStyles.paddingBottom).toBe('64px');
  expect(seo.conversionStyles.paddingTop).toBe('64px');
  expect(seo.conversionStyles.paddingBottom).toBe('64px');
  // Self-contained marketing and application surfaces use the framework card.
  expect(seo.membershipSurface).toBe('CX-CARD');
  expect(seo.applicationSurface).toBe('CX-CARD');
  expect(seo.buyerSurfaceCount).toBe(2);
  expect(seo.heroTitleSize).toBeCloseTo(72, 1);
  expect(seo.heroTitleLineHeight / seo.heroTitleSize).toBeCloseTo(1.05, 2);

  await page.screenshot({
    path: path.join(screenshotDir, 'handmark-desktop.png'),
    fullPage: true,
  });

  // Submit-time validation stays with each framework field and moves focus to
  // the first invalid control.
  await page.getByRole('button', { name: 'Apply for review' }).click();
  await expect(page.locator('input[name="name"]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('input[name="name"]')).toBeFocused();
  await expect(page.getByText('Confirm the review terms to continue.')).toBeVisible();
  await expect(page.locator('#form-status')).toHaveCount(0);

  // Text fields forward their name to the native input; textareas and the
  // checkbox are framework primitives addressed by their accessible label.
  await page.locator('input[name="name"]').fill('Playwright Maker');
  await page.locator('input[name="email"]').fill('maker@example.com');
  await page.locator('input[name="contactPreference"]').fill('Email first, then video call');
  await page.locator('input[name="brand"]').fill('Playwright Maker Studio');
  await page.locator('input[name="category"]').fill('Furniture');
  await page.locator('input[name="website"]').fill('https://example.com');
  await page
    .getByLabel('What do you make?')
    .fill('A human-authored craft process verified through Playwright.');
  await page.getByLabel('Proof links').fill('https://example.com/proof');
  await page.locator('input[name="walkthroughPreference"]').fill('Video call');
  await page.getByRole('checkbox', { name: /I confirm this application/ }).check();
  await page.getByRole('button', { name: 'Apply for review' }).click();
  await expect(page.locator('#form-status')).toContainText('Application HM-');
  const storedApplication = readStoredApplication(databasePath);
  expect(storedApplication.intakeSequence).toBe(1);
  expect(Object.keys(storedApplication.record)).toEqual([
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
  expect(storedApplication.record.contactPreference).toBe('Email first, then video call');
  expect(storedApplication.record.brand).toBe('Playwright Maker Studio');
  expect(storedApplication.record.walkthroughPreference).toBe('Video call');
  expect(storedApplication.recordHash).toMatch(/^[0-9a-f]{64}$/);

  const basePayload = {
    plan: 'verification',
    billingCycle: 'monthly',
    agree: true,
    name: 'Playwright Maker',
    email: 'maker@example.com',
    contactPreference: 'Email first, then video call',
    brand: 'Playwright Maker Studio',
    category: 'Furniture',
    website: 'https://example.com',
    craftSummary: 'A human-authored craft process verified through Playwright.',
    proofLinks: 'https://example.com/proof',
    paymentPreference: 'after-approval',
  };
  const missingWebsite = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, website: '' },
    headers: { Origin: baseUrl },
  });
  await expectJsonError(missingWebsite, 400, 'invalid_application', 'website is required.');
  const badEmail = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, email: 'not-an-email' },
    headers: { Origin: baseUrl },
  });
  await expectJsonError(badEmail, 400, 'invalid_application', 'Enter a valid email address.');
  const invalidAgreement = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, agree: 'true' },
    headers: { Origin: baseUrl },
  });
  await expectJsonError(invalidAgreement, 400, 'invalid_application', 'Agreement is required.');
  const invalidBillingCycle = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, billingCycle: 'annual' },
    headers: { Origin: baseUrl },
  });
  await expectJsonError(
    invalidBillingCycle,
    400,
    'invalid_application',
    'Choose a valid billing cycle.',
  );
  const invalidFieldType = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, website: { href: 'https://example.com' } },
    headers: { Origin: baseUrl },
  });
  await expectJsonError(invalidFieldType, 400, 'invalid_application', 'website must be text.');
  const malformedJson = await page.request.post(`${baseUrl}/api/apply`, {
    data: '{',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
  });
  await expectJsonError(malformedJson, 400, 'invalid_json', 'The request body is not valid JSON.');

  const malformedCookie = await page.request.get(`${baseUrl}/`, {
    headers: { Cookie: 'hm_session=%' },
    maxRedirects: 0,
  });
  expect(malformedCookie.status()).toBe(302);
  expect(malformedCookie.headers().location).toBe('/login');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  const mobileMenu = page.getByRole('button', { name: 'Primary menu' });
  await expect(mobileMenu).toBeVisible();
  await expect(mobileMenu).toHaveAttribute('aria-expanded', 'false');
  await mobileMenu.click();
  await expect(mobileMenu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Why', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apply for Handmark' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Why', exact: true }).click();
  await expect(mobileMenu).toHaveAttribute('aria-expanded', 'false');
  const mobileMetrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    hasMembership: document.body.textContent.includes('Handmark Verification'),
    heroTitleSize: Number.parseFloat(getComputedStyle(document.querySelector('.hero h1')).fontSize),
    heroTitleLineHeight: Number.parseFloat(
      getComputedStyle(document.querySelector('.hero h1')).lineHeight,
    ),
  }));
  expect(mobileMetrics.overflow).toBe(false);
  expect(mobileMetrics.hasMembership).toBe(true);
  expect(mobileMetrics.heroTitleSize).toBeCloseTo(40, 1);
  expect(mobileMetrics.heroTitleLineHeight / mobileMetrics.heroTitleSize).toBeCloseTo(1.05, 2);

  await page.screenshot({
    path: path.join(screenshotDir, 'handmark-mobile.png'),
    fullPage: true,
  });

  const robots = await request.get(`${baseUrl}/robots.txt`);
  expect(await robots.text()).toContain('Sitemap: https://handmark.io/sitemap.xml');
  const sitemap = await request.get(`${baseUrl}/sitemap.xml`);
  expect(await sitemap.text()).toContain('https://handmark.io/');

  const missingAsset = await page.request.get(`${baseUrl}/chunk-MISSING123.js`);
  expect(missingAsset.status()).toBe(404);
  expect(missingAsset.headers()['cache-control']).toBe('no-store');
  expect(await missingAsset.text()).toBe('Asset not found');

  await mobileMenu.click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(`${baseUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Human-made work, verified.' })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

async function expectJsonError(response, status, code, message) {
  expect(response.status()).toBe(status);
  expect(response.headers()['cache-control']).toBe('private, no-store');
  const requestId = response.headers()['x-request-id'];
  expect(requestId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/);
  expect(await response.json()).toEqual({
    error: { code, message, requestId },
  });
}

function readStoredApplication(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        'SELECT intake_sequence, record_json, record_hash FROM applications ORDER BY intake_sequence',
      )
      .get();
    if (!row) throw new Error('Handmark E2E application row is missing.');
    const canonical = Buffer.from(row.record_json);
    const canonicalHash = createHash('sha256').update(canonical).digest('hex');
    if (canonicalHash !== row.record_hash) {
      throw new Error('Handmark E2E canonical application hash does not match its stored hash.');
    }
    return {
      intakeSequence: row.intake_sequence,
      record: JSON.parse(canonical.toString('utf8')),
      recordHash: row.record_hash,
    };
  } finally {
    database.close();
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for isolated Handmark E2E.`);
  return value;
}

function isContainedPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

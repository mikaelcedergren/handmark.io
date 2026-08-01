const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

const baseUrl = process.env.HANDMARK_BASE_URL || 'http://127.0.0.1:3000';
const password = process.env.HANDMARK_TEST_PASSWORD || 'handmark-dev-password';
const repoDataDir = path.resolve(__dirname, '..', '..', 'data');
const configuredDataDir = process.env.HANDMARK_E2E_DATA_DIR;
if (!configuredDataDir) {
  throw new Error(
    'HANDMARK_E2E_DATA_DIR is required; run this suite through its Playwright config.',
  );
}
const dataDir = path.resolve(configuredDataDir);
const parsedBaseUrl = new URL(baseUrl);
if (
  !['127.0.0.1', 'localhost', '::1'].includes(parsedBaseUrl.hostname) ||
  parsedBaseUrl.port === '3000' ||
  dataDir === repoDataDir
) {
  throw new Error('Handmark E2E refuses the production endpoint or production data directory.');
}

test.afterAll(async () => {
  await fs.rm(path.join(dataDir, 'applications.jsonl'), { force: true });
  await fs.rmdir(dataDir).catch((error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  });
});

test('Handmark night-mode membership flow', async ({ page, request }) => {
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(`${baseUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Human-made work, verified.' })).toBeVisible();
  await expect(page.getByLabel('Access password')).toBeVisible();

  const loginMetrics = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  // Night theme surface from the framework tokens.
  expect(loginMetrics.background).toBe('rgb(0, 0, 0)');
  expect(loginMetrics.overflow).toBe(false);

  await page.screenshot({
    path: '/private/tmp/handmark-login.png',
    fullPage: true,
  });

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
    path: '/private/tmp/handmark-desktop.png',
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
  const savedApplications = await fs.readFile(path.join(dataDir, 'applications.jsonl'), 'utf8');
  expect(savedApplications).toContain('"contactPreference":"Email first, then video call"');
  expect(savedApplications).toContain('"brand":"Playwright Maker Studio"');
  expect(savedApplications).toContain('"walkthroughPreference":"Video call"');

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
  });
  expect(missingWebsite.status()).toBe(400);
  expect((await missingWebsite.json()).message).toBe('website is required.');
  const badEmail = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, email: 'not-an-email' },
  });
  expect(badEmail.status()).toBe(400);
  expect((await badEmail.json()).message).toBe('Enter a valid email address.');
  const invalidAgreement = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, agree: 'true' },
  });
  expect(invalidAgreement.status()).toBe(400);
  expect((await invalidAgreement.json()).message).toBe('Agreement is required.');
  const invalidBillingCycle = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, billingCycle: 'annual' },
  });
  expect(invalidBillingCycle.status()).toBe(400);
  expect((await invalidBillingCycle.json()).message).toBe('Choose a valid billing cycle.');
  const invalidFieldType = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, website: { href: 'https://example.com' } },
  });
  expect(invalidFieldType.status()).toBe(400);
  expect((await invalidFieldType.json()).message).toBe('website must be text.');
  const malformedJson = await page.request.post(`${baseUrl}/api/apply`, {
    data: '{',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(malformedJson.status()).toBe(400);
  expect(await malformedJson.json()).toEqual({ ok: false, message: 'Request body is invalid.' });

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
    path: '/private/tmp/handmark-mobile.png',
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

  expect(consoleErrors).toEqual([]);
});

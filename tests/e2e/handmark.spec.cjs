const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");

const baseUrl = "http://127.0.0.1:3000";
const password = process.env.HANDMARK_TEST_PASSWORD || "handmark-dev-password";
// The intake files live in the repo's own data/, resolved from this spec's location so the
// suite works on the production Mac mini and on a development mirror alike.
const dataDir = path.resolve(__dirname, "..", "..", "data");

test.afterAll(async () => {
  await fs.rm(path.join(dataDir, "applications.json"), { force: true });
  await fs.rm(path.join(dataDir, "applications.jsonl"), { force: true });
});

test("Handmark night-mode membership flow", async ({ page, request }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(`${baseUrl}/login`);
  await expect(page.getByRole("heading", { name: "Human-made work, verified." })).toBeVisible();
  await expect(page.getByLabel("Access password")).toBeVisible();

  const loginMetrics = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1
  }));
  // Night theme surface-mid from the framework tokens.
  expect(loginMetrics.background).toBe("rgb(0, 0, 0)");
  expect(loginMetrics.overflow).toBe(false);

  await page.screenshot({
    path: "/private/tmp/handmark-login.png",
    fullPage: true
  });

  await page.getByLabel("Access password").fill(password);
  await page.getByRole("button", { name: "Enter Handmark" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await page.setViewportSize({ width: 2048, height: 1152 });

  await expect(page.getByRole("heading", { name: "Handmark", exact: true })).toBeVisible();
  await expect(page.getByText("A public trust mark for work made by a person.")).toBeVisible();
  await expect(page.getByText("The $99 fee starts the review. Approval is earned.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Walkthrough required" })).toBeVisible();
  await expect(page.getByText(/Submitted proof is only the beginning/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "More than a badge on a page." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Selective by design." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No proof, no stamp" })).toBeVisible();
  await expect(page.locator(".proof-page-top").getByText("Public proof page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "One subscription. One standard." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Handmark Verification" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Starter", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Studio", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "House", exact: true })).toHaveCount(0);

  const seo = await page.evaluate(() => {
    const schema = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
    const heroRect = document.querySelector(".hero-grid").getBoundingClientRect();
    const storyRect = document.querySelector(".section-grid").getBoundingClientRect();
    const membershipRect = document.querySelector(".membership-card").getBoundingClientRect();
    const storyParagraph = document.querySelector(".story-copy p").getBoundingClientRect();
    const formRect = document.querySelector(".application-form").getBoundingClientRect();
    const conversionRect = document.querySelector(".conversion-strip").getBoundingClientRect();
    const heroSection = document.querySelector(".hero");
    const firstSection = document.querySelector(".section");
    const conversionStrip = document.querySelector(".conversion-strip");
    const pricing = document.querySelector(".pricing-card");
    const formEl = document.querySelector(".application-form");
    const styles = (el) => {
      const computed = getComputedStyle(el);
      return {
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        gap: computed.gap
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
      pricingStyles: styles(pricing),
      formStyles: styles(formEl)
    };
  });
  expect(seo.title).toContain("Human-Made Work Verification");
  expect(seo.description).toContain("public trust mark");
  expect(seo.canonical).toBe("https://handmark.io/");
  expect(seo.offerName).toBe("Handmark Human Review");
  expect(seo.offerPrice).toBe("99");
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
  await expect(page.getByRole("button", { name: "Start human review" })).toBeVisible();
  // Section rhythm uses the framework spacing scale (--space-2xl = 64px).
  expect(seo.heroStyles.paddingTop).toBe("64px");
  expect(seo.heroStyles.paddingBottom).toBe("64px");
  expect(seo.sectionStyles.paddingTop).toBe("64px");
  expect(seo.sectionStyles.paddingBottom).toBe("64px");
  expect(seo.conversionStyles.paddingTop).toBe("64px");
  expect(seo.conversionStyles.paddingBottom).toBe("64px");
  // Card padding uses the framework --space-xl (32px).
  expect(seo.pricingStyles.paddingLeft).toBe("32px");
  expect(seo.formStyles.paddingLeft).toBe("32px");

  await page.screenshot({
    path: "/private/tmp/handmark-desktop.png",
    fullPage: true
  });

  // Text fields forward their name to the native input; textareas and the
  // checkbox are framework primitives addressed by their accessible label.
  await page.locator('input[name="name"]').fill("Playwright Maker");
  await page.locator('input[name="email"]').fill("maker@example.com");
  await page.locator('input[name="contactPreference"]').fill("Email first, then video call");
  await page.locator('input[name="brand"]').fill("Playwright Maker Studio");
  await page.locator('input[name="category"]').fill("Furniture");
  await page.locator('input[name="website"]').fill("https://example.com");
  await page.getByLabel("What do you make?").fill("A human-authored craft process verified through Playwright.");
  await page.getByLabel("Proof links").fill("https://example.com/proof");
  await page.locator('input[name="walkthroughPreference"]').fill("Video call");
  await page.getByRole("checkbox", { name: /I confirm this application/ }).check();
  await page.getByRole("button", { name: "Apply for review" }).click();
  await expect(page.locator("#form-status")).toContainText("Application HM-");
  const savedApplications = await fs.readFile(
    path.join(dataDir, "applications.jsonl"),
    "utf8"
  );
  expect(savedApplications).toContain('"contactPreference":"Email first, then video call"');
  expect(savedApplications).toContain('"brand":"Playwright Maker Studio"');
  expect(savedApplications).toContain('"walkthroughPreference":"Video call"');

  const basePayload = {
    plan: "verification",
    agree: true,
    name: "Playwright Maker",
    email: "maker@example.com",
    contactPreference: "Email first, then video call",
    brand: "Playwright Maker Studio",
    category: "Furniture",
    website: "https://example.com",
    craftSummary: "A human-authored craft process verified through Playwright.",
    proofLinks: "https://example.com/proof",
    paymentPreference: "after-approval"
  };
  const missingWebsite = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, website: "" }
  });
  expect(missingWebsite.status()).toBe(400);
  expect((await missingWebsite.json()).message).toBe("website is required.");
  const badEmail = await page.request.post(`${baseUrl}/api/apply`, {
    data: { ...basePayload, email: "not-an-email" }
  });
  expect(badEmail.status()).toBe(400);
  expect((await badEmail.json()).message).toBe("Enter a valid email address.");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("button", { name: "Close menu" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Why", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Apply for Handmark" })).toHaveCount(0);
  await page.getByRole("link", { name: "Why", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  const mobileMetrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    hasMembership: document.body.textContent.includes("Handmark Verification")
  }));
  expect(mobileMetrics.overflow).toBe(false);
  expect(mobileMetrics.hasMembership).toBe(true);

  await page.screenshot({
    path: "/private/tmp/handmark-mobile.png",
    fullPage: true
  });

  const robots = await request.get(`${baseUrl}/robots.txt`);
  expect(await robots.text()).toContain("Sitemap: https://handmark.io/sitemap.xml");
  const sitemap = await request.get(`${baseUrl}/sitemap.xml`);
  expect(await sitemap.text()).toContain("https://handmark.io/");

  expect(consoleErrors).toEqual([]);
});

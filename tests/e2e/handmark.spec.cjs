const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");

const baseUrl = "http://127.0.0.1:3000";
const password = process.env.HANDMARK_TEST_PASSWORD || "handmark-dev-password";

test.afterAll(async () => {
  await fs.rm("/Users/cortex/Development/handmark.io/data/applications.json", {
    force: true
  });
  await fs.rm("/Users/cortex/Development/handmark.io/data/applications.jsonl", {
    force: true
  });
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
  expect(loginMetrics.background).toBe("rgb(5, 5, 5)");
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
      primaryLinks: Array.from(document.querySelectorAll("a.button-primary")).map((link) => link.textContent.trim()),
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
  expect(seo.heroWidth).toBeLessThanOrEqual(1180);
  expect(seo.storyWidth).toBeLessThanOrEqual(1180);
  expect(seo.membershipWidth).toBeLessThanOrEqual(580);
  expect(seo.storyLineWidth).toBeLessThanOrEqual(760);
  expect(seo.formWidth).toBeLessThanOrEqual(740);
  expect(seo.conversionTop).toBeLessThan(1080);
  expect(seo.primaryLinks).toEqual(["Start human review"]);
  expect(seo.heroStyles.paddingTop).toBe("112px");
  expect(seo.heroStyles.paddingBottom).toBe("112px");
  expect(seo.sectionStyles.paddingTop).toBe("112px");
  expect(seo.sectionStyles.paddingBottom).toBe("112px");
  expect(seo.conversionStyles.paddingTop).toBe("80px");
  expect(seo.conversionStyles.paddingBottom).toBe("80px");
  expect(seo.pricingStyles.paddingLeft).toBe("40px");
  expect(seo.formStyles.paddingLeft).toBe("40px");

  await page.screenshot({
    path: "/private/tmp/handmark-desktop.png",
    fullPage: true
  });

  await page.locator('input[name="name"]').fill("Playwright Maker");
  await page.locator('input[name="email"]').fill("maker@example.com");
  await page.locator('input[name="contactPreference"]').fill("Email first, then video call");
  await page.locator('input[name="brand"]').fill("Playwright Maker Studio");
  await page.locator('input[name="category"]').fill("Furniture");
  await page.locator('input[name="website"]').fill("https://example.com");
  await page.locator('textarea[name="craftSummary"]').fill("A human-authored craft process verified through Playwright.");
  await page.locator('textarea[name="proofLinks"]').fill("https://example.com/proof");
  await page.locator('input[name="walkthroughPreference"]').fill("Video call");
  await page.locator('input[name="agree"]').check();
  await page.getByRole("button", { name: "Apply for review" }).click();
  await expect(page.locator("#form-status")).toContainText("Application HM-");
  const savedApplications = await fs.readFile(
    "/Users/cortex/Development/handmark.io/data/applications.jsonl",
    "utf8"
  );
  expect(savedApplications).toContain('"contactPreference":"Email first, then video call"');
  expect(savedApplications).toContain('"brand":"Playwright Maker Studio"');
  expect(savedApplications).toContain('"walkthroughPreference":"Video call"');

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

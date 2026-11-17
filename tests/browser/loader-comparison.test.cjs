const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

test("legacy and sprite loaders render at each size and animate only with motion enabled", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(`${base}/animation-comparison.html`);
    for (const [size, pixels, legacySelector] of [
      ["md", 24, '.panel .loader[data-size="md"]'],
      ["lg", 40, '.panel .loader[data-size="lg"]'],
      ["xl", 96, '.panel .loader[data-size="xl"]'],
    ]) {
      const legacy = page.locator(legacySelector);
      const migrated = page.locator(`use[href="#icon-loader-${size}"]`).locator("..");
      for (const element of [legacy, migrated]) {
        const box = await element.boundingBox();
        assert.equal(box.width, pixels);
        assert.equal(box.height, pixels);
        const image = await element.screenshot();
        await page.waitForTimeout(100);
        assert.ok(
          image.equals(await element.screenshot()),
          `${size} loader is still under reduced motion`,
        );
      }
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const selector of ['.panel .loader[data-size="xl"]', 'use[href="#icon-loader-xl"]']) {
      const element = page.locator(selector);
      const stableElement = selector.startsWith("use") ? element.locator("..") : element;
      const image = await stableElement.screenshot();
      await page.waitForTimeout(250);
      assert.ok(!image.equals(await stableElement.screenshot()), `${selector} animates`);
    }
  } finally {
    await browser.close();
  }
});

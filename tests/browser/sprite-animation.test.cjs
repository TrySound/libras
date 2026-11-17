const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium } = require("playwright");

const sprite = readFileSync("src/sprite.svg", "utf8");

test("sprite animations run only in visible instances and respect reduced motion", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    await page.setContent(
      `<div hidden>${sprite}</div><svg width="120" height="120"><use href="#icon-sound-bars"></use></svg>`,
    );
    const icon = page.locator("body > svg");
    const frames = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(110);
      frames.push(await icon.screenshot());
    }
    assert.ok(
      frames.some((frame) => !frame.equals(frames[0])),
      "visible symbol animates",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(100);
    const still = await icon.screenshot();
    await page.waitForTimeout(200);
    assert.ok(still.equals(await icon.screenshot()), "reduced motion leaves a static symbol");
    await icon.evaluate((node) => node.remove());
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.waitForTimeout(300);
    const before = (await cdp.send("Performance.getMetrics")).metrics;
    await page.waitForTimeout(1000);
    const after = (await cdp.send("Performance.getMetrics")).metrics;
    for (const name of ["LayoutCount", "RecalcStyleCount"]) {
      const value = (metrics) => metrics.find((metric) => metric.name === name).value;
      assert.equal(value(after) - value(before), 0, `${name} remains idle`);
    }
  } finally {
    await browser.close();
  }
});

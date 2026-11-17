const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium } = require("playwright");

const sprite = readFileSync("src/sprite.svg", "utf8");

test("extra-large loader matches the legacy four-pixel gaps", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce", deviceScaleFactor: 1 });
    await page.setContent(`<style>
      body { background: white; --loader-bg: #8f7073; --accent: #ffcc00; }
      .legacy { display: inline-grid; width: 96px; height: 96px; grid-template-columns: repeat(5, 1fr); align-items: center; gap: 4px; }
      .legacy span { height: 100%; background: var(--loader-bg); scale: 1 .35; }
      .legacy span:nth-child(2), .legacy span:nth-child(4) { scale: 1 .65; }
      .legacy span:nth-child(3) { scale: 1; background: var(--accent); }
    </style><div hidden>${sprite}</div><span class="legacy">${"<span></span>".repeat(5)}</span><svg width="96" height="96" style="--loader-gap: 4px"><use href="#icon-loader"></use></svg>`);
    const legacy = await page.locator(".legacy").screenshot();
    const migrated = await page.locator("body > svg").screenshot();
    assert.ok(legacy.equals(migrated), "the full-size bars and gaps match the legacy loader");
  } finally {
    await browser.close();
  }
});

test("sprite animations run only in visible instances and respect reduced motion", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    await page.setContent(
      `<style>body { --loader-bg: #8f7073; --accent: #ffcc00; --motion-ease: cubic-bezier(.445,.05,.55,.95); }</style><div hidden>${sprite}</div><svg width="120" height="120"><use href="#icon-sound-bars"></use></svg><svg width="96" height="96"><use href="#icon-loader"></use></svg>`,
    );
    const icons = page.locator("body > svg");
    for (const icon of await icons.all()) {
      const frames = [];
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(110);
        frames.push(await icon.screenshot());
      }
      assert.ok(
        frames.some((frame) => !frame.equals(frames[0])),
        "visible symbol animates",
      );
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(100);
    for (const icon of await icons.all()) {
      const still = await icon.screenshot();
      await page.waitForTimeout(200);
      assert.ok(still.equals(await icon.screenshot()), "reduced motion leaves a static symbol");
    }
    await icons.evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
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

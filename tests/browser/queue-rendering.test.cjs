// Real CSS/native-dialog coverage; no server or Subsonic connection required.
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(
    `deferred queue groups preserve layout and keyboard access (${reducedMotion})`,
    { timeout: 15000 },
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 393, height: 760 },
          reducedMotion,
        });
        await page.setContent('<div class="app-root"></div>');
        await page.addStyleTag({ path: resolve(__dirname, "../../src/edgerunner.css") });
        await page.locator(".app-root").evaluate((root) => {
          const groups = Array.from({ length: 26 }, (_, group) => {
            const count = group === 25 ? 3 : 40;
            const rows = Array.from({ length: count }, (_, offset) => {
              const index = group * 40 + offset;
              return `<div class="menu-item track-row">
              <div class="row-sm">
                <span class="artwork" data-size="sm"></span>
                <div><p class="label">Track ${index}</p><p class="caption">Artist</p></div>
              </div>
              <button class="link-target" aria-label="Play track ${index}"></button>
            </div>`;
            }).join("");
            return `<div class="stack-sm track-group" style="--track-group-rows:${count}">${rows}</div>`;
          }).join("");
          root.innerHTML = `<dialog class="large-player" aria-label="Queue test"><div class="stack-sm">${groups}</div></dialog>`;
          root.querySelector("dialog").showModal();
        });
        await page.locator("dialog").evaluate(async (node) => {
          await Promise.all(node.getAnimations().map((animation) => animation.finished));
        });
        const rows = page.locator(".track-group > .track-row");
        const groups = page.locator(".track-group");
        assert.equal(await rows.count(), 1003);
        assert.equal(await groups.count(), 26);
        assert.equal(
          await groups.nth(1).evaluate((node) => getComputedStyle(node).contentVisibility),
          "auto",
        );
        assert.equal(
          await rows.nth(40).evaluate((node) => getComputedStyle(node).contentVisibility),
          "visible",
        );
        assert.equal(
          await rows.nth(40).evaluate((node) => getComputedStyle(node).animationName),
          "none",
        );
        assert.notEqual(
          await groups.nth(1).evaluate((node) => getComputedStyle(node).containIntrinsicBlockSize),
          "none",
        );
        assert.ok(await page.locator("dialog").evaluate((node) => node.scrollHeight > 38000));
        await rows.nth(39).locator("button").focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await rows
            .nth(40)
            .locator("button")
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.keyboard.press("Shift+Tab");
        assert.equal(
          await rows
            .nth(39)
            .locator("button")
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await rows.nth(1002).locator("button").focus();
        assert.equal(
          await rows
            .nth(1002)
            .locator("button")
            .evaluate((node) => node === document.activeElement),
          true,
        );
        assert.ok(await page.locator("dialog").evaluate((node) => node.scrollTop > 0));
        await page.locator("dialog").evaluate((node) => {
          node.scrollTop = 0;
          node.close();
          node.showModal();
        });
        assert.equal(await page.locator("dialog").evaluate((node) => node.open), true);
      } finally {
        await browser.close();
      }
    },
  );
}

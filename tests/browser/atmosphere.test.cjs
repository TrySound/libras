const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium } = require("playwright");

const css = readFileSync(
  new URL("../../src/edgerunner.css", `file://${__filename}`),
  "utf8",
).replace(/@import[^;]+;/g, "");
const backdrop = `<div class="atmosphere-frame" aria-hidden="true">
  <img class="atmosphere" alt=""
    src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='red'/%3E%3C/svg%3E">
  <div class="atmosphere-lines"></div></div>
  <div class="foreground" style="height:2400px; flex-shrink:0">Foreground</div>`;

async function fixture(browser, mode) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
    reducedMotion: "no-preference",
  });
  const content =
    mode === "dialog"
      ? `<dialog class="large-player"><div class="large-player-stage">${backdrop}</div></dialog>`
      : `<div class="app-shell" ${mode === "embedded" ? "data-embedded" : ""}>
        <div class="app-stage">${backdrop}</div></div>`;
  const root =
    mode === "embedded"
      ? `<div class="app-root" style="height:600px">${content}</div>`
      : `<div class="app-root standalone">${content}</div>`;
  await page.setContent(`<!doctype html><style>${css} body { margin:0; }</style>${root}`);
  await page.evaluate((mode) => {
    if (mode === "dialog") document.querySelector("dialog").showModal();
    window.scrollOwner =
      mode === "document"
        ? document.scrollingElement
        : document.querySelector(mode === "embedded" ? ".app-shell" : "dialog");
  }, mode);
  return page;
}

async function position(page, scroll) {
  await page.evaluate((scroll) => {
    window.scrollOwner.scrollTop = scroll;
  }, scroll);
  // Let the native scroll timeline catch up, without adding application JS.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page.evaluate(() => {
    const owner = window.scrollOwner;
    const frame = document.querySelector(".atmosphere-frame").getBoundingClientRect();
    const image = document.querySelector(".atmosphere").getBoundingClientRect();
    const lines = document.querySelector(".atmosphere-lines").getBoundingClientRect();
    const viewport =
      owner === document.scrollingElement
        ? { top: 0, bottom: innerHeight }
        : owner.getBoundingClientRect();
    return {
      scroll: owner.scrollTop,
      extent: owner.scrollHeight,
      range: owner.scrollHeight - owner.clientHeight,
      viewportHeight: owner.clientHeight,
      imageOffset: image.top - frame.top,
      linesOffset: lines.top - frame.top,
      covered: [image, lines].every(
        (box) => box.top <= viewport.top + 1 && box.bottom >= viewport.bottom - 1,
      ),
    };
  });
}

for (const mode of ["document", "embedded", "dialog"]) {
  test(`${mode}: CSS-only depth stays proportional across the full scroll range`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await fixture(browser, mode);
      // Native dialog entry transitions must finish before geometry assertions.
      await page.waitForTimeout(300);
      for (const height of [2400, 3200]) {
        await page.locator(".foreground").evaluate((node, height) => {
          node.style.height = `${height}px`;
        }, height);
        const start = await position(page, 0);
        for (const scroll of [1, 100, 700, start.range]) {
          const current = await position(page, scroll);
          assert.ok(
            Math.abs(current.imageOffset - start.imageOffset - current.scroll * 0.85) < 1,
            `${mode}: artwork must move at 15% apparent speed`,
          );
          assert.ok(
            Math.abs(current.linesOffset - start.linesOffset - current.scroll * 0.45) < 1,
            `${mode}: lines must move at 55% apparent speed`,
          );
          assert.equal(current.extent, start.extent, "decoration must not grow the scroll range");
          assert.equal(current.covered, true, "both layers must cover the visible viewport");
        }
      }
      await page.setViewportSize({ width: 800, height: 650 });
      const resized = await position(page, 0);
      const moved = await position(page, 100);
      assert.ok(Math.abs(moved.linesOffset - resized.linesOffset - 45) < 1);
      assert.ok(Math.abs(moved.imageOffset - resized.imageOffset - 85) < 1);

      // A page that overflows by one pixel must not run the whole animation.
      await page.locator(".foreground").evaluate((node, height) => {
        node.style.height = `${height + 1}px`;
      }, resized.viewportHeight);
      const shortStart = await position(page, 0);
      const shortEnd = await position(page, 1);
      assert.equal(shortEnd.range, 1);
      assert.ok(Math.abs(shortEnd.imageOffset - shortStart.imageOffset - 0.85) < 0.1);
      assert.ok(Math.abs(shortEnd.linesOffset - shortStart.linesOffset - 0.45) < 0.1);

      await page.locator(".foreground").evaluate((node, height) => {
        node.style.height = `${height}px`;
      }, resized.viewportHeight);
      const unscrollable = await position(page, 0);
      assert.equal(unscrollable.range, 0);
      assert.equal(unscrollable.covered, true);

      // Lines survive without artwork, and neither layer moves for reduced motion.
      await page.locator(".atmosphere").evaluate((node) => {
        node.hidden = true;
      });
      assert.equal(await page.locator(".atmosphere-lines").isVisible(), true);
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const selector of [".atmosphere", ".atmosphere-lines"]) {
        assert.equal(
          await page.locator(selector).evaluate((node) => getComputedStyle(node).animationName),
          "none",
        );
      }
    } finally {
      await browser.close();
    }
  });
}

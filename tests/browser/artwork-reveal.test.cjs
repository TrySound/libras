const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`artwork reveals only when ready (${reducedMotion})`, { timeout: 10000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ reducedMotion });
      await page.setContent('<div class="app-root"></div>');
      await page.addStyleTag({ path: resolve(__dirname, "../../src/edgerunner.css") });
      await page.locator(".app-root").evaluate((node) => {
        node.innerHTML = `<span class="artwork" data-pending>
            <img hidden alt="">
            <svg class="artwork-placeholder" width="24" height="24"></svg>
          </span>`;
      });
      const artwork = page.locator(".artwork");
      const initialSize = await artwork.boundingBox();
      assert.equal(await artwork.evaluate((node) => getComputedStyle(node).opacity), "0");
      assert.equal(
        await artwork.evaluate((node) => getComputedStyle(node).transitionDuration),
        reducedMotion === "reduce" ? "0s" : "0.18s",
      );
      // Hiding must not prevent lazy acquisition, unlike clipping the observed element.
      await artwork.evaluate(
        (node) =>
          new Promise((resolve) => {
            const observer = new IntersectionObserver((entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) return;
              observer.disconnect();
              resolve();
            });
            observer.observe(node);
          }),
      );
      await artwork.evaluate((node) => {
        node.querySelector("img").hidden = false;
        node.removeAttribute("data-pending");
      });
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector(".artwork")).opacity === "1",
      );
      assert.equal(
        await artwork
          .locator(".artwork-placeholder")
          .evaluate((node) => getComputedStyle(node).display),
        "none",
      );
      assert.deepEqual(await artwork.boundingBox(), initialSize);
      // Missing/failed covers reveal the icon rather than staying invisible.
      await artwork.evaluate((node) => {
        node.querySelector("img").hidden = true;
      });
      assert.equal(await artwork.evaluate((node) => getComputedStyle(node).opacity), "1");
      assert.notEqual(
        await artwork
          .locator(".artwork-placeholder")
          .evaluate((node) => getComputedStyle(node).display),
        "none",
      );
      // Tile artwork leaves the fade to its parent, avoiding compounded opacity.
      await artwork.evaluate((node) => {
        node.classList.add("tile-artwork");
        node.setAttribute("data-pending", "");
      });
      assert.equal(await artwork.evaluate((node) => getComputedStyle(node).opacity), "1");
    } finally {
      await browser.close();
    }
  });
}

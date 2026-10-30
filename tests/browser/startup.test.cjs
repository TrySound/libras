// Real startup routing: no Library flash or view transition before the first page.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

for (const hash of ["", "#/library", "#/settings"]) {
  test(`new user starts directly in Settings at ${hash || "the root"}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ reducedMotion: "no-preference" });
      await page.addInitScript(() => {
        window.startupTransitions = 0;
        window.libraryRendered = false;
        const original = document.startViewTransition.bind(document);
        document.startViewTransition = (...args) => {
          window.startupTransitions++;
          return original(...args);
        };
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (
                node instanceof Element &&
                (node.matches("#library-heading") || node.querySelector("#library-heading"))
              )
                window.libraryRendered = true;
            }
          }
        }).observe(document, { childList: true, subtree: true });
      });
      await page.goto(`${base.replace(/\/$/, "")}/${hash}`);
      await page.locator("#settings-heading").waitFor();
      assert.equal(new URL(page.url()).hash, "#/settings");
      assert.deepEqual(
        await page.evaluate(() => ({
          transitions: window.startupTransitions,
          library: window.libraryRendered,
        })),
        { transitions: 0, library: false },
      );
      await page.reload();
      await page.locator("#settings-heading").waitFor();
      assert.deepEqual(
        await page.evaluate(() => ({
          transitions: window.startupTransitions,
          library: window.libraryRendered,
        })),
        { transitions: 0, library: false },
      );
      await page.locator('a[aria-label="Libras home"]').filter({ visible: true }).first().click();
      await page.locator("#library-heading").waitFor({ state: "attached" });
      assert.equal(await page.evaluate(() => window.startupTransitions), 1);
      await page.waitForFunction(
        () => !document.documentElement.matches(":active-view-transition"),
      );
      await page.goBack();
      await page.locator("#settings-heading").waitFor();
      assert.equal(await page.evaluate(() => window.startupTransitions), 2);
    } finally {
      await browser.close();
    }
  });
}

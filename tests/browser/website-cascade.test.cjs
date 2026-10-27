// Optional real-browser coverage. Run against the website server, not the app.
// See CONTRIBUTING.md for external Playwright setup and PREVIEW_URL.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5180").replace(/\/$/, "")}/`;

test("website overrides coexist with scoped legacy and Edgerunner styles", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(base);
    const demo = page.locator("#live-demo-dialog");
    await demo.locator(".app-root").waitFor();
    const app = await demo.locator(".app-root").elementHandle();

    await t.test("website layout overrides shared utilities on desktop", async () => {
      const hero = await page.locator(".site-hero").evaluate((element) => {
        const style = getComputedStyle(element);
        return { display: style.display, direction: style.flexDirection };
      });
      assert.deepEqual(hero, { display: "flex", direction: "column" });
      assert.equal(await page.locator(".site-demo-launch").isVisible(), false);
      assert.equal(await demo.isVisible(), true);
      assert.equal(await demo.evaluate((element) => element.matches(":modal")), false);
      assert.equal(await page.locator("#main-content").count(), 1, "only the host main owns the skip-link ID");
      assert.equal(await page.locator(".site-skip-link").getAttribute("href"), "#main-content");
      assert.equal(await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim()
      ), "", "the embedded canvas must not repaint the host document");
    });

    await t.test("mobile launch and modal preserve the mounted demo across resizing", async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForFunction(() => !document.querySelector("#live-demo-dialog").open);
      assert.equal(await demo.isVisible(), false);
      assert.equal(await page.locator(".site-demo-launch").isVisible(), true);
      await page.locator(".site-demo-launch").click();
      assert.equal(await demo.evaluate((element) => element.matches(":modal")), true);
      await page.getByRole("button", { name: "Close demo", exact: true }).click();
      assert.equal(await demo.isVisible(), false);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => document.querySelector("#live-demo-dialog").open);
      assert.equal(await demo.isVisible(), true);
      assert.equal(await page.locator(".site-demo-launch").isVisible(), false);
      assert.equal(
        await app.evaluate((element) => element === document.querySelector("#demo .app-root")),
        true,
      );
    });

    await t.test(
      "Settings adapts to the narrow embedded app, not the desktop browser",
      async () => {
        assert.equal(await page.locator("#demo .app-sidebar").isVisible(), false);
        await page.locator("#demo").getByRole("button", { name: "Open menu", exact: true }).click();
        await page
          .locator("#navigation-dialog")
          .getByRole("link", { name: "Settings", exact: true })
          .click();
        await page.locator("#demo .settings-view").waitFor();
        const geometry = await page.locator("#demo .settings-view").evaluate((element) => {
          const server = element.querySelector("#settings-server").getBoundingClientRect();
          const offline = element.querySelector("#settings-offline-card").getBoundingClientRect();
          return {
            stacked: offline.top >= server.bottom,
            fits: element.scrollWidth <= element.clientWidth,
          };
        });
        assert.deepEqual(geometry, { stacked: true, fits: true });
        assert.equal(
          await app.evaluate((element) => element === document.querySelector("#demo .app-root")),
          true,
        );
      },
    );

    await t.test("website extensions stop at an Edgerunner boundary", async () => {
      await page.evaluate(() => {
        const island = document.createElement("section");
        island.id = "edgerunner-website-fixture";
        // Deliberately overlap a website class and a shared flow utility.
        island.className = "ui-edgerunner site-hero stack-lg";
        island.innerHTML = '<button class="button" data-variant="primary">New control</button>';
        document.querySelector(".website").append(island);
      });
      const island = await page.locator("#edgerunner-website-fixture").evaluate((element) => {
        const style = getComputedStyle(element);
        return { display: style.display, minHeight: style.minHeight, gap: style.gap };
      });
      assert.deepEqual(island, { display: "grid", minHeight: "0px", gap: "24px" });
      assert.equal(
        await page
          .locator("#edgerunner-website-fixture .button")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(129, 0, 0)",
      );
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("embedded error notifications stay inside the app on desktop and mobile", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: "reduce",
  });
  await page.route("**/catalog/search3.json", (route) =>
    route.fulfill({ status: 500, body: "Catalog unavailable" }),
  );
  const assertBounds = async () => {
    const geometry = await page.locator("#error-popover").evaluate((popover) => {
      const app = document.querySelector(".app-root").getBoundingClientRect();
      const box = popover.getBoundingClientRect();
      return {
        inside: box.left >= app.left && box.right <= app.right &&
          box.top >= app.top && box.bottom <= app.bottom,
        scrolls: popover.scrollHeight > popover.clientHeight,
      };
    });
    assert.deepEqual(geometry, { inside: true, scrolls: true });
  };
  try {
    await page.goto(base);
    await page.getByRole("button", { name: "Show errors", exact: true }).click();
    await page.locator("#error-popover").waitFor();
    // Exercise the app-height limit as well as its inline bounds.
    await page.locator("#error-popover [role=alert]").evaluate((message) => {
      message.textContent = "Long server failure details. ".repeat(200);
    });
    await assertBounds();
    await page.getByRole("button", { name: "Close errors", exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForFunction(() => !document.querySelector("#live-demo-dialog").open);
    await page.locator(".site-demo-launch").click();
    await page.getByRole("button", { name: "Show errors", exact: true }).click();
    await page.locator("#error-popover").waitFor();
    await assertBounds();
    await page.getByRole("button", { name: "Close errors", exact: true }).click();
    assert.equal(await page.locator("#error-popover").isVisible(), false);
  } finally {
    await browser.close();
  }
});

// Optional real-browser coverage. See CONTRIBUTING.md for external Playwright setup.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;

test("Edgerunner foundations and legacy coexistence", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });

  try {
    await page.goto(new URL("styleguide.html", base).href);
    await page.evaluate(() => document.fonts.ready);

    await t.test("shared styles, local fonts, and responsive geometry", async () => {
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.locator("h1").textContent(), "Edgerunner foundations");
      const styles = await page.evaluate(() => {
        const card = getComputedStyle(document.querySelector(".card"));
        const input = getComputedStyle(document.querySelector(".input"));
        const heading = getComputedStyle(document.querySelector("h1"));
        return {
          space: card.getPropertyValue("--space-xl").trim(),
          border: card.borderTopWidth,
          padding: card.paddingTop,
          background: card.backgroundImage,
          inputPadding: input.padding,
          font: heading.fontFamily,
          fontDisplays: [...document.fonts].map((font) => font.display),
        };
      });
      assert.equal(styles.space, "48px");
      assert.equal(styles.border, "2px");
      assert.equal(styles.padding, "24px");
      assert.match(styles.background, /linear-gradient/);
      assert.equal(styles.inputPadding, "8px 16px");
      assert.match(styles.font, /Rajdhani/);
      assert.equal(styles.fontDisplays.length, 3);
      assert.ok(styles.fontDisplays.every((display) => display === "optional"));
      assert.equal(await page.locator('link[rel="preload"][as="font"][crossorigin]').count(), 1);

      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
      // A customizable body role must not resize the browser root/rem scale.
      const sizing = await page.evaluate(() => {
        document.documentElement.style.setProperty("--body-size", "1.25rem");
        const result = [
          getComputedStyle(document.documentElement).fontSize,
          getComputedStyle(document.body).fontSize,
        ];
        document.documentElement.style.removeProperty("--body-size");
        return result;
      });
      assert.deepEqual(sizing, ["16px", "20px"]);
    });

    await t.test("slow fonts keep the fallback without a late layout swap", async () => {
      // A fresh context avoids warm font caches from the preceding specimens.
      const context = await browser.newContext();
      const slowPage = await context.newPage();
      try {
        await slowPage.route("**/*.woff2", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await route.continue();
        });
        await slowPage.goto(new URL("styleguide.html", base).href, {
          waitUntil: "domcontentloaded",
        });
        await slowPage.locator("h1").waitFor();
        // Let the short optional-font window expire before measuring text.
        await slowPage.waitForTimeout(200);
        const textWidth = () =>
          slowPage.locator("h1").evaluate((heading) => {
            const range = document.createRange();
            range.selectNodeContents(heading);
            return range.getBoundingClientRect().width;
          });
        const fallbackWidth = await textWidth();
        assert.ok(fallbackWidth > 0);
        await slowPage.evaluate(() => document.fonts.ready);
        assert.equal(await textWidth(), fallbackWidth);
      } finally {
        await context.close();
      }
    });

    await t.test("native controls, focus, and input errors", async () => {
      const toggle = page.getByRole("switch", { name: "Initially off", exact: true });
      await toggle.focus();
      await page.keyboard.press("Space");
      assert.equal(await toggle.isChecked(), true);
      const ring = await toggle.evaluate((element) => getComputedStyle(element).outlineWidth);
      assert.equal(ring, "4px");
      assert.equal(
        await page.getByRole("switch", { name: "Disabled on", exact: true }).isDisabled(),
        true,
      );
      assert.equal(await page.locator("#guide-host-error").isVisible(), false);
      assert.equal(await page.locator("#guide-invalid-error").isVisible(), true);
      await page.locator("#guide-invalid").focus();
      // Focus border feedback may transition when reduced motion is not requested.
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#guide-invalid")).borderTopColor ===
          "rgb(239, 191, 4)",
      );
    });

    await t.test("native hidden state and overlay focus restoration", async () => {
      assert.equal(await page.locator("#guide-dialog").isVisible(), false);
      assert.equal(await page.locator("#guide-popover").isVisible(), false);
      const invoker = page.getByRole("button", { name: "Open dialog", exact: true });
      await invoker.click();
      assert.equal(await page.locator("#guide-dialog").isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#guide-dialog").isVisible(), false);
      assert.equal(await invoker.evaluate((element) => document.activeElement === element), true);
      await page.getByRole("button", { name: "Open popover", exact: true }).click();
      assert.equal(await page.locator("#guide-popover").isVisible(), true);
      await page.getByRole("button", { name: "Close popover", exact: true }).click();
      assert.equal(await page.locator("#guide-popover").isVisible(), false);
    });

    await t.test("missing artwork and reduced-motion loading", async () => {
      const artwork = page.locator(".artwork");
      assert.equal(await artwork.first().locator(".artwork-placeholder").isVisible(), false);
      assert.equal(await artwork.nth(1).locator(".artwork-placeholder").isVisible(), true);
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await page
          .locator(".loader-bar")
          .first()
          .evaluate((element) => getComputedStyle(element).animationName),
        "none",
      );
      assert.equal(
        await page
          .locator(".loader-bar")
          .nth(2)
          .evaluate((element) => getComputedStyle(element).scale),
        "1",
      );
    });

    await t.test(
      "a migrated island and external overlays do not restyle legacy neighbors",
      async () => {
        // Exercise both stylesheets on the actual app document, not just the
        // all-Edgerunner styleguide. No domain state or server connection needed.
        await page.goto(base);
        await page.locator(".app-root").waitFor();
        await page.evaluate(() => {
          const fixture = document.createElement("div");
          fixture.id = "coexistence-fixture";
          fixture.innerHTML = `
          <div id="legacy-before" class="stack-xl"><button class="button" data-variant="primary">Legacy before</button></div>
          <section id="new-boundary" class="ui-edgerunner stack-md">
            <div id="new-layout" class="stack-xl">
              <button id="new-button" class="button" data-variant="primary">New</button>
              <input id="new-input" class="input" aria-label="New input" />
              <div id="new-card" class="card">New card</div>
              <button class="button" hidden>Hidden new control</button>
            </div>
          </section>
          <div id="legacy-after" class="stack-xl"><button class="button" data-variant="primary">Legacy after</button></div>
          <div id="hidden-boundary" class="ui-edgerunner stack-md" hidden>Hidden boundary</div>
          <dialog id="external-overlay" class="ui-edgerunner card"><button class="button" data-variant="primary">Overlay</button></dialog>`;
          document.body.append(fixture);
        });
        const styles = await page.evaluate(() => {
          const style = (selector) => {
            const value = getComputedStyle(document.querySelector(selector));
            return {
              gap: value.gap,
              padding: value.padding,
              background: value.backgroundColor,
              shadow: value.boxShadow,
              border: value.borderTopWidth,
            };
          };
          return {
            before: style("#legacy-before"),
            after: style("#legacy-after"),
            oldButton: style("#legacy-before .button"),
            boundary: style("#new-boundary"),
            newLayout: style("#new-layout"),
            newButton: style("#new-button"),
            newCard: style("#new-card"),
            newInput: style("#new-input"),
            overlay: style("#external-overlay"),
            overlayButton: style("#external-overlay .button"),
          };
        });
        assert.deepEqual(styles.before, styles.after);
        assert.equal(styles.before.gap, "32px");
        assert.equal(styles.boundary.gap, "16px");
        assert.equal(styles.newLayout.gap, "48px");
        assert.equal(styles.newButton.background, "rgb(129, 0, 0)");
        assert.notEqual(styles.oldButton.background, styles.newButton.background);
        assert.equal(styles.newButton.shadow, "none");
        assert.equal(styles.newButton.border, "0px");
        assert.equal(styles.newInput.padding, "8px 16px");
        assert.equal(styles.newCard.border, "2px");
        assert.equal(styles.overlay.border, "2px");
        assert.equal(styles.overlay.padding, "24px");
        assert.equal(styles.overlayButton.background, styles.newButton.background);
        assert.equal(await page.locator("#new-layout [hidden]").isVisible(), false);
        assert.equal(await page.locator("#hidden-boundary").isVisible(), false);
        assert.equal(await page.locator("#external-overlay").isVisible(), false);
        await page.evaluate(() => document.querySelector("#external-overlay").showModal());
        assert.equal(await page.locator("#external-overlay").isVisible(), true);
        await page.keyboard.press("Escape");
      },
    );

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

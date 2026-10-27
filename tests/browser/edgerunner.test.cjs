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
      assert.equal(await page.locator("#guide-host-error").count(), 0);
      assert.equal(
        await page
          .locator("#guide-host")
          .evaluate((input) => input.validity.valueMissing && !!input.validationMessage),
        true,
      );
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

    await t.test("shared navigation primitives work outside the app shell", async () => {
      for (const [width, height] of [[375, "60px"], [768, "76px"]]) {
        await page.setViewportSize({ width, height: 900 });
        const topbar = await page.locator(".topbar-example .topbar").evaluate((element) => {
          const style = getComputedStyle(element);
          return { minHeight: style.minHeight, display: style.display, blur: style.backdropFilter };
        });
        assert.deepEqual(topbar, { minHeight: height, display: "flex", blur: "blur(4px)" });
      }
      const sidebar = await page.locator('.sidebar[aria-label="Sidebar specimen"]').evaluate((element) => {
        const style = getComputedStyle(element);
        return { padding: style.paddingTop, border: style.borderRightWidth, blur: style.backdropFilter };
      });
      assert.deepEqual(sidebar, { padding: "24px", border: "2px", blur: "blur(4px)" });
      const invoker = page.getByRole("button", { name: "Open navigation specimen", exact: true });
      const sheet = page.locator("#guide-navigation");
      assert.equal(await sheet.isVisible(), false);
      await invoker.click();
      const geometry = await sheet.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.width, padding: style.padding, duration: style.transitionDuration };
      });
      assert.deepEqual(geometry, { width: "360px", padding: "24px", duration: "0.28s" });
      await page.getByRole("button", { name: "Close navigation specimen", exact: true }).click();
      assert.equal(await sheet.evaluate((element) => getComputedStyle(element).transitionDuration.split(", ").every((duration) => duration === "0.16s")), true);
      await sheet.waitFor({ state: "hidden" });
      assert.equal(await invoker.evaluate((element) => element === document.activeElement), true);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 320, height: 900 });
      await invoker.click();
      assert.equal(await sheet.evaluate((element) => getComputedStyle(element).width), "288px");
      assert.equal(await sheet.evaluate((element) => getComputedStyle(element).transitionDuration), "0s");
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden" });
    });

    await t.test("shared shell owns gutters, scrolling, and intrinsic player clearance", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const shell = page.locator("#guide-shell");
      await shell.scrollIntoViewIfNeeded();
      const geometry = () => shell.evaluate((element) => {
        const sidebar = element.querySelector(".app-sidebar");
        const player = element.querySelector(".app-player");
        const main = getComputedStyle(element.querySelector(".app-page"));
        return {
          sidebarVisible: getComputedStyle(sidebar).display !== "none",
          padding: parseFloat(main.paddingInlineStart),
          gutter: parseFloat(main.paddingInlineEnd),
          clearance: sidebar.getBoundingClientRect().bottom - player.getBoundingClientRect().top,
          playerHeight: player.getBoundingClientRect().height,
        };
      });
      const before = await geometry();
      assert.equal(before.sidebarVisible, true);
      assert.equal(before.padding, 280 + before.gutter);
      assert.ok(Math.abs(before.clearance) <= 1);
      await shell.locator(".app-player .body").evaluate((element) => {
        element.textContent = "Intrinsic player content grows with its text. ".repeat(20);
      });
      const after = await geometry();
      assert.ok(after.playerHeight > before.playerHeight);
      assert.ok(Math.abs(after.clearance) <= 1, "CSS anchors follow intrinsic player growth");
      await shell.locator(".app-player .body").evaluate((element) => { element.textContent = "Intrinsic player slot"; });
      await page.setViewportSize({ width: 375, height: 900 });
      const mobile = await geometry();
      assert.equal(mobile.sidebarVisible, false);
      assert.equal(mobile.padding, mobile.gutter);
      await shell.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      assert.equal(await shell.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        const player = element.querySelector(".app-player").getBoundingClientRect();
        return element.scrollTop > 0 && player.bottom <= frame.bottom + 1;
      }), true);
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

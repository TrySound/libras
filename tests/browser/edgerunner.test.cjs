// Optional real-browser coverage. See CONTRIBUTING.md for external Playwright setup.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;

test("Edgerunner foundations and native controls", async (t) => {
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
        const probe = document.createElement("div");
        probe.style.background = card.getPropertyValue("--shell-bg");
        probe.style.borderColor = card.getPropertyValue("--shell-border");
        document.body.append(probe);
        const shell = getComputedStyle(probe);
        const cardUsesShell =
          card.backgroundImage === shell.backgroundImage &&
          card.backgroundColor === shell.backgroundColor &&
          card.borderTopColor === shell.borderTopColor;
        probe.remove();
        return {
          cardUsesShell,
          space: card.getPropertyValue("--space-xl").trim(),
          border: card.borderTopWidth,
          padding: card.paddingTop,
          background: card.backgroundImage,
          inputPadding: input.padding,
          font: heading.fontFamily,
          buttonFonts: [...document.querySelectorAll(".button")].map(
            (button) => getComputedStyle(button).fontFamily,
          ),
          fontDisplays: [...document.fonts].map((font) => font.display),
        };
      });
      assert.equal(styles.space, "48px");
      assert.equal(styles.border, "2px");
      assert.equal(styles.padding, "24px");
      assert.equal(styles.cardUsesShell, true);
      assert.match(styles.background, /linear-gradient/);
      assert.equal(styles.inputPadding, "8px 16px");
      assert.match(styles.font, /Rajdhani/);
      assert.ok(styles.buttonFonts.length > 0);
      assert.ok(styles.buttonFonts.every((font) => /Rajdhani/.test(font)));
      assert.equal(styles.fontDisplays.length, 3);
      assert.ok(styles.fontDisplays.every((display) => display === "swap"));
      assert.equal(await page.locator('link[rel="preload"][as="font"][crossorigin]').count(), 3);

      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const buttons = await page.locator(".button, .button-quiet").evaluateAll((nodes) =>
          nodes
            .filter((node) => node.getClientRects().length)
            .every((node) => {
              const box = node.getBoundingClientRect();
              return box.width >= 44 && box.height >= 44;
            }),
        );
        assert.equal(buttons, true, `44px button targets at ${width}px`);
        assert.equal(
          await page
            .locator(".card")
            .first()
            .evaluate((node) => getComputedStyle(node).paddingTop),
          "24px",
        );
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

    await t.test("app entry preloads all swap faces without duplicate font requests", async () => {
      const context = await browser.newContext();
      const app = await context.newPage();
      try {
        await app.goto(base);
        await app.locator(".app-root").waitFor();
        await app.evaluate(() => document.fonts.ready);
        const fonts = await app.evaluate(() => {
          const preloads = [...document.querySelectorAll('link[rel="preload"][as="font"]')];
          return preloads.map((link) => ({
            href: link.href,
            type: link.type,
            cors: link.hasAttribute("crossorigin"),
            requests: performance.getEntriesByName(link.href).length,
          }));
        });
        assert.equal(fonts.length, 3);
        for (const [index, font] of fonts.entries()) {
          assert.match(font.href, new RegExp(`rajdhani-${[500, 600, 700][index]}-latin`));
          assert.equal(font.type, "font/woff2");
          assert.equal(font.cors, true);
          assert.equal(font.requests, 1);
        }
        assert.ok(
          await app.evaluate(() => [...document.fonts].every((font) => font.display === "swap")),
        );
      } finally {
        await context.close();
      }
    });

    await t.test("slow fonts keep text visible then render Rajdhani", async (t) => {
      const context = await browser.newContext();
      const slowPage = await context.newPage();
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      try {
        await slowPage.addInitScript(() => {
          window.fontLayoutShift = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              if (!entry.hadRecentInput) window.fontLayoutShift += entry.value;
          }).observe({ type: "layout-shift", buffered: true });
        });
        await slowPage.route("**/*.woff2", async (route) => {
          await gate;
          await route.continue();
        });
        await slowPage.goto(base, { waitUntil: "domcontentloaded" });
        const heading = slowPage.locator("#settings-heading");
        await heading.waitFor();
        await slowPage.waitForTimeout(200);
        const cdp = await context.newCDPSession(slowPage);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "#settings-heading",
        });
        const platformFonts = async () =>
          (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
        assert.ok((await heading.boundingBox()).height > 0);
        assert.ok((await platformFonts()).every((font) => !font.isCustomFont));
        release();
        await slowPage.evaluate(() => document.fonts.ready);
        await slowPage.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.ok((await platformFonts()).some((font) => /Rajdhani/.test(font.familyName)));
        t.diagnostic(
          `Delayed-font layout shift: ${await slowPage.evaluate(() => window.fontLayoutShift)}`,
        );
        await cdp.detach();
      } finally {
        release();
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

    await t.test(
      "sidebar specimens reflect update availability, progress, and failures",
      async () => {
        const states = page.getByLabel("Sidebar update states", { exact: true });
        const sidebars = states.getByRole("complementary");
        assert.equal(await sidebars.count(), 5);
        for (const sidebar of await sidebars.all()) {
          assert.equal(await sidebar.getByRole("navigation").getByRole("link").count(), 1);
          assert.equal(
            await sidebar.getByRole("link", { name: "Your library", exact: true }).count(),
            1,
          );
        }
        assert.equal(await states.locator("[aria-current], nav svg[color]").count(), 0);
        const idle = states.getByRole("complementary", { name: "No update sidebar", exact: true });
        assert.equal(await idle.getByRole("button").count(), 0);
        assert.equal(await idle.getByRole("separator").count(), 0);
        assert.equal(await idle.getByLabel("App update", { exact: true }).count(), 0);
        const separators = states.getByRole("separator");
        assert.equal(await separators.count(), 4);
        for (const separator of await separators.all()) {
          assert.deepEqual(
            await separator.evaluate((element) => {
              const style = getComputedStyle(element);
              const sidebar = getComputedStyle(element.closest("aside"));
              return {
                margins: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
                thickness: style.borderTopWidth,
                expectedThickness: style.getPropertyValue("--border-width").trim(),
                bottom: style.borderBottomWidth,
                matchesShell: style.borderTopColor === sidebar.borderRightColor,
                separatesUpdate:
                  element.previousElementSibling?.tagName === "NAV" &&
                  element.nextElementSibling?.getAttribute("aria-label") === "App update",
              };
            }),
            {
              margins: ["0px", "0px", "0px", "0px"],
              thickness: "2px",
              expectedThickness: "2px",
              bottom: "0px",
              matchesShell: true,
              separatesUpdate: true,
            },
          );
        }
        for (const name of ["Update available sidebar", "Update failed sidebar"]) {
          const sidebar = states.getByRole("complementary", { name, exact: true });
          const action = sidebar.getByRole("button", { name: /^Update Libras/ });
          assert.equal(await action.isEnabled(), true);
          assert.equal(await action.locator(".caption").count(), 0);
          assert.equal(await action.locator(".label.text-subtle").textContent(), "Update Libras");
          if (name === "Update available sidebar") {
            assert.match(
              await action.getAttribute("title"),
              /A new version of Libras is available/,
            );
          } else {
            assert.equal(await action.getAttribute("title"), null);
            assert.match(
              await sidebar.locator(".caption.text-subtle").textContent(),
              /taking too long/,
            );
          }
          assert.equal(await action.locator("use").getAttribute("href"), "#icon-refresh");
          assert.equal(await action.locator("svg").getAttribute("color"), "var(--text-subtle)");
        }
        const busy = states
          .getByRole("complementary", { name: "Updating sidebar", exact: true })
          .getByRole("button");
        assert.equal(await busy.evaluate((element) => element.disabled), false);
        assert.equal(await busy.getAttribute("aria-disabled"), "true");
        assert.equal(await busy.getAttribute("aria-busy"), "true");
        await busy.focus();
        assert.equal(await busy.evaluate((element) => element === document.activeElement), true);
        assert.match(await busy.getAttribute("title"), /Applying the update/);
        assert.equal(await busy.locator(".loader-bar").count(), 5);
        assert.equal(await busy.locator("svg").count(), 0);
        const failure = states.getByRole("complementary", {
          name: "Offline setup failed sidebar",
          exact: true,
        });
        assert.equal(await failure.getByRole("button").count(), 0);
        assert.match(await failure.textContent(), /Offline app setup failed/);
        assert.equal(await states.locator('[role="status"], [role="alert"]').count(), 0);
      },
    );

    await t.test("shared navigation primitives work outside the app shell", async () => {
      await page.setViewportSize({ width: 320, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const invoker = page.getByRole("button", { name: "Open navigation specimen", exact: true });
      const sheet = page.locator("#guide-navigation");
      assert.equal(await invoker.getAttribute("data-variant"), "secondary");
      assert.equal(await invoker.locator("#guide-navigation-update-hint + svg").count(), 1);
      assert.equal(await page.locator("#guide-navigation-update-hint").isVisible(), true);
      assert.equal(await invoker.getAttribute("aria-describedby"), "guide-navigation-update-hint");
      assert.equal(await sheet.isVisible(), false);
      await invoker.click();
      assert.equal(
        await sheet.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        }),
        true,
      );
      assert.equal(
        await sheet.evaluate((element) => getComputedStyle(element).transitionDuration),
        "0s",
      );
      assert.deepEqual(
        await sheet.evaluate((element) => ({
          dialog: getComputedStyle(element).overscrollBehaviorY,
          backdrop: getComputedStyle(element, "::backdrop").overscrollBehaviorY,
          backdropOverflow: getComputedStyle(element, "::backdrop").overflow,
        })),
        { dialog: "none", backdrop: "none", backdropOverflow: "hidden" },
      );
      // Headless wheel tests cannot reproduce native touch/trackpad rubber-banding;
      // require none (not contain) so boundary bounce is disabled as well.
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden" });
      assert.equal(await invoker.evaluate((element) => element === document.activeElement), true);
    });

    await t.test("loaders use square md, lg, and xl sizes", async () => {
      for (const [selector, size] of [
        ["#loading-heading + .caption + .control-example .button .loader", 24],
        ['.loader[aria-label="Large loading specimen"]', 40],
        ['.loader[aria-label="Extra large loading specimen"]', 96],
      ]) {
        const dimensions = await page.locator(selector).evaluate((node) => {
          const box = node.getBoundingClientRect();
          return [box.width, box.height];
        });
        assert.deepEqual(dimensions, [size, size]);
      }
    });

    await t.test(
      "40px transport icons retain the 56px button footprint while loading",
      async () => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const player = page.locator("#guide-player");
        await player.evaluate((node) => node.showModal());
        try {
          const controls = player
            .getByRole("group", { name: "Playback controls" })
            .getByRole("button");
          const sizes = () =>
            controls.evaluateAll((buttons) =>
              buttons.map((button) => {
                const box = button.getBoundingClientRect();
                return [box.width, box.height];
              }),
            );
          assert.deepEqual(await sizes(), [
            [56, 56],
            [56, 56],
            [56, 56],
          ]);
          assert.deepEqual(
            await controls
              .locator("svg")
              .evaluateAll((icons) =>
                icons.map((icon) => [
                  icon.getBoundingClientRect().width,
                  icon.getBoundingClientRect().height,
                ]),
              ),
            [
              [40, 40],
              [40, 40],
              [40, 40],
            ],
          );
          const play = player.getByRole("button", {
            name: "Play fullscreen specimen",
            exact: true,
          });
          const original = await play.innerHTML();
          await play.evaluate((button) => {
            button.setAttribute("aria-busy", "true");
            button.innerHTML = `<span class="loader" data-size="lg" aria-hidden="true">${'<span class="loader-bar"></span>'.repeat(
              5,
            )}</span>`;
          });
          assert.deepEqual(
            await play.locator(".loader").evaluate((node) => {
              const box = node.getBoundingClientRect();
              return [box.width, box.height];
            }),
            [40, 40],
          );
          assert.deepEqual(await sizes(), [
            [56, 56],
            [56, 56],
            [56, 56],
          ]);
          await play.evaluate((button, original) => {
            button.removeAttribute("aria-busy");
            button.innerHTML = original;
          }, original);
          assert.deepEqual(await sizes(), [
            [56, 56],
            [56, 56],
            [56, 56],
          ]);
        } finally {
          await player.evaluate((node) => node.close());
        }
      },
    );

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

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

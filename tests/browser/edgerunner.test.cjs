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
      assert.equal(await page.locator('link[rel="preload"][as="font"][crossorigin]').count(), 3);

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

    await t.test(
      "app entry preloads all optional faces without duplicate font requests",
      async () => {
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
            await app.evaluate(() =>
              [...document.fonts].every((font) => font.display === "optional"),
            ),
          );
        } finally {
          await context.close();
        }
      },
    );

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

    await t.test(
      "shared shell owns gutters, scrolling, and intrinsic player clearance",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const shell = page.locator("#guide-shell");
        await shell.scrollIntoViewIfNeeded();
        const geometry = () =>
          shell.evaluate((element) => {
            const sidebar = element.querySelector(".app-sidebar");
            const player = element.querySelector(".app-player");
            const main = getComputedStyle(element.querySelector(".app-page"));
            return {
              sidebarVisible: getComputedStyle(sidebar).display !== "none",
              sidebarWidth: sidebar.getBoundingClientRect().width,
              sidebarPadding: [
                getComputedStyle(sidebar).paddingTop,
                getComputedStyle(sidebar).paddingBottom,
              ],
              padding: parseFloat(main.paddingInlineStart),
              gutter: parseFloat(main.paddingInlineEnd),
              clearance:
                sidebar.getBoundingClientRect().bottom - player.getBoundingClientRect().top,
              playerHeight: player.getBoundingClientRect().height,
            };
          });
        const before = await geometry();
        assert.equal(before.sidebarVisible, true);
        assert.deepEqual(before.sidebarPadding, ["24px", "24px"]);
        assert.equal(before.playerHeight, 96);
        assert.equal(before.padding, before.sidebarWidth + before.gutter);
        assert.ok(Math.abs(before.clearance) <= 1);
        await shell.locator(".app-player .label").evaluate((element) => {
          element.style.whiteSpace = "normal";
          element.textContent = "Intrinsic player content grows with its text. ".repeat(4);
        });
        const after = await geometry();
        assert.ok(after.playerHeight > before.playerHeight);
        assert.ok(Math.abs(after.clearance) <= 1, "CSS anchors follow intrinsic player growth");
        await shell.locator(".app-player .label").evaluate((element) => {
          element.style.whiteSpace = "";
          element.textContent = "A long track title with missing artwork";
        });
        await page.setViewportSize({ width: 375, height: 900 });
        const mobile = await geometry();
        assert.equal(mobile.sidebarVisible, false);
        assert.equal(mobile.playerHeight, 72);
        assert.equal(mobile.padding, mobile.gutter);
        await shell.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        assert.equal(
          await shell.evaluate((element) => {
            const frame = element.getBoundingClientRect();
            const player = element.querySelector(".app-player").getBoundingClientRect();
            return element.scrollTop > 0 && player.bottom <= frame.bottom + 1;
          }),
          true,
        );
      },
    );

    await t.test("collection panels budget the embedded viewport, not the browser", async () => {
      const shell = page.locator("#guide-shell");
      // Mount only shared presentation classes; no app runtime or layout overrides.
      await shell.evaluate((element) => {
        const panel = document.createElement("div");
        panel.className = "viewport-panel";
        panel.dataset.testPanel = "";
        element.querySelector(".app-page").append(panel);
      });
      try {
        for (const width of [375, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          for (const frameHeight of [416, 640]) {
            await shell.locator("..").evaluate((element, height) => {
              element.style.blockSize = `${height}px`;
            }, frameHeight);
            const geometry = await shell.evaluate((element) => {
              const panel = element.querySelector("[data-test-panel]");
              const styles = getComputedStyle(panel);
              const mobile =
                getComputedStyle(element.querySelector(".app-sidebar")).display === "none";
              return {
                actual: panel.getBoundingClientRect().height,
                expected: Math.max(
                  0,
                  element.getBoundingClientRect().height -
                    parseFloat(
                      getComputedStyle(element.querySelector(".app-player")).minBlockSize,
                    ) -
                    2 * parseFloat(styles.getPropertyValue("--content-padding-block")) -
                    (mobile ? parseFloat(styles.getPropertyValue("--topbar-min-height")) : 0),
                ),
              };
            });
            assert.equal(geometry.actual, geometry.expected);
          }
        }
      } finally {
        await shell.locator("[data-test-panel]").evaluate((element) => element.remove());
        await shell.locator("..").evaluate((element) => element.style.removeProperty("block-size"));
      }
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

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

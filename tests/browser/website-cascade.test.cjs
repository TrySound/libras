// Optional real-browser coverage. Run against the website server, not the app.
// See CONTRIBUTING.md for external Playwright setup and PREVIEW_URL.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const catalog = require("../../website/deezer-catalog.json");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5180").replace(/\/$/, "")}/`;

async function mockDeezer(page, unavailable = false) {
  const requests = [];
  const tracks = catalog.flatMap((album) =>
    album.tracks.map((track) => ({
      id: track.id,
      title: track.title,
      explicit_lyrics: track.explicit,
      artist: { id: album.artistId, name: album.artist },
      album: { id: album.id },
      readable: true,
      preview: "https://cdnt-preview.dzcdn.net/fixture.mp3",
    })),
  );
  await page.route("https://api.deezer.com/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (unavailable) return route.fulfill({ status: 500, body: "Unavailable" });
    const callback = url.searchParams.get("callback");
    assert.match(callback, /^librasDeezer_[a-z0-9]+$/);
    const data = tracks.find((track) => url.pathname === `/track/${track.id}`);
    return route.fulfill({
      contentType: "text/javascript",
      body: `${callback}(${JSON.stringify(data)})`,
    });
  });
  await page.route("https://cdn-images.dzcdn.net/**", (route) =>
    route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>',
    }),
  );
  await page.route("https://cdnt-preview.dzcdn.net/**", (route) => route.abort());
  return requests;
}

test("landing layout, images, and keyboard focus work without JavaScript", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ javaScriptEnabled: false, reducedMotion: "reduce" });
  try {
    await page.goto(base);
    async function assertContained() {
      const clipped = await page
        .locator("main :is(h1, h2, p, a, img), header a")
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.left < -1 ||
                box.right > innerWidth + 1 ||
                element.scrollWidth > element.clientWidth + 1
              );
            })
            .map((element) => element.textContent?.trim() || element.getAttribute("src")),
        );
      assert.deepEqual(clipped, [], "content bounds fit without relying on overflow clipping");
    }
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `landing page must fit at ${width}px`,
      );
      const heading = page.getByRole("heading", { level: 1 });
      const cta = page.getByRole("link", { name: "Try live demo", exact: true }).first();
      assert.equal(await heading.isVisible(), true);
      assert.equal(await cta.isVisible(), true);
      const type = await heading.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          size: parseFloat(style.fontSize),
          body: parseFloat(getComputedStyle(document.body).fontSize),
        };
      });
      assert.ok(type.size > type.body, "heading typography is applied");
      const button = await cta.boundingBox();
      assert.ok(button.height >= 44, "CTA retains a usable target size");
      if (width < 480) {
        const connect = await page
          .getByRole("link", { name: "Install", exact: true })
          .first()
          .boundingBox();
        assert.ok(Math.abs(connect.width - button.width) < 1, "mobile actions have equal widths");
        assert.ok(
          button.y >= connect.y + connect.height + 12,
          "mobile actions stack with deliberate spacing",
        );
      }
      assert.equal(await page.locator(".site-feature").count(), 3);
      assert.equal(await page.locator("details, .site-faq").count(), 0, "no obsolete FAQ");
      for (const image of await page.locator("main img").all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(async (element) => {
          if (!element.complete)
            await new Promise((resolve, reject) => {
              element.addEventListener("load", resolve, { once: true });
              element.addEventListener("error", reject, { once: true });
            });
          await element.decode();
        });
        assert.ok(await image.evaluate((element) => element.complete && element.naturalWidth > 0));
      }
      assert.equal(
        await page
          .locator(".site-preview img")
          .evaluate((element) => element.currentSrc.includes("library-mobile")),
        width < 640,
      );
      const launchLines = await page
        .locator('header a[data-variant="primary"]')
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        });
      assert.equal(launchLines, 1, "Launch stays on one line without clipping");
      await assertContained();
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await assertContained();
    await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
    // A 1280px browser at 400% zoom has a 320 CSS-pixel layout viewport.
    await page.setViewportSize({ width: 320, height: 900 });
    await assertContained();
    await page.goto(base);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    assert.equal(await skip.evaluate((element) => element === document.activeElement), true);
    const focus = await skip.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && box.top >= 0;
    });
    assert.equal(focus, true, "skip link and its focus ring are visible");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => location.hash), "#main-content");

    assert.equal(
      await page.locator("main").evaluate((element) => element === document.activeElement),
      true,
    );
    await page.goto(base);
    const links = await page.locator("a").all();
    for (const link of links) {
      await page.keyboard.press("Tab");
      assert.equal(await link.evaluate((element) => element === document.activeElement), true);
      assert.ok(
        await link.evaluate((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return (
            style.outlineStyle !== "none" &&
            parseFloat(style.outlineWidth) >= 3 &&
            box.top >= 0 &&
            box.bottom <= innerHeight
          );
        }),
        "keyboard focus is visible and scrolled into view",
      );
    }
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await links.at(-2).evaluate((element) => element === document.activeElement),
      true,
    );
    const primary = page.locator('.site-actions [data-variant="primary"]').first();
    assert.equal(
      await primary.evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s",
    );
  } finally {
    await browser.close();
  }
});

test("landing shares one install offer and replaces focused controls in place", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const index of [0, 1]) {
      const page = await browser.newPage({ reducedMotion: "reduce" });
      await page.addInitScript(() =>
        addEventListener("beforeinstallprompt", (event) => {
          if (event.isTrusted) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }),
      );
      await page.goto(base);
      const liveRegion = page.locator('[role="status"]');
      assert.equal(await liveRegion.count(), 1);
      assert.equal(await liveRegion.textContent(), "");
      // Keep the empty live region rendered before its first update. Computed styles
      // catch accidental hiding; they do not prove real screen-reader announcements.
      assert.equal(
        await liveRegion.evaluate((element) => {
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility !== "visible") return false;
          }
          return true;
        }),
        true,
      );
      await page.locator("a[data-install]").nth(index).focus();
      await page.evaluate(() => {
        window.promptCalls = 0;
        const userChoice = new Promise((resolve) => {
          window.finishInstall = resolve;
        });
        dispatchEvent(
          Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
            userChoice,
            prompt: () => {
              window.promptCalls++;
              return Promise.resolve();
            },
          }),
        );
      });
      assert.equal(
        await page
          .locator("button[data-install]")
          .nth(index)
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document.querySelector('[role="status"]').textContent === "Opening installation prompt…",
      );
      await page.evaluate(() =>
        document.querySelectorAll("button[data-install]").forEach((button) => button.click()),
      );
      assert.equal(await page.evaluate(() => window.promptCalls), 1);
      await page.evaluate(() => window.finishInstall({ outcome: "dismissed" }));
      await page.locator("a[data-install]").nth(index).waitFor();
      assert.equal(
        await page
          .locator("a[data-install]")
          .nth(index)
          .evaluate((element) => element === document.activeElement),
        true,
      );
      assert.equal(await page.locator('[role="status"]').textContent(), "Installation dismissed.");
      assert.equal(await page.locator('[role="status"]').count(), 1);
      assert.equal(await page.locator(".site-install-help a").count(), 2);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("static website links to the full-width standalone demo", async () => {
  const browser = await chromium.launch({ headless: true });
  let page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await mockDeezer(page.context());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(base);
    assert.equal(await page.locator('script[type="module"]').count(), 1);
    assert.match(
      await page.locator('script[type="module"]').getAttribute("src"),
      /landing-install/,
    );
    const landing = page;
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Try live demo", exact: true }).first().click();
    page = await popup;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForURL("**/demo/**");
    assert.equal(landing.url(), base, "landing remains available in its original tab");
    await page.locator(".app-root .tile a").first().waitFor();
    assert.equal(await page.locator(".tile a").count(), 16);
    assert.equal(await page.locator(".app-sidebar").isVisible(), true);
    const app = await page.locator(".app-root").elementHandle();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await page.locator(".app-root").boundingBox();
      const availableWidth = await page.evaluate(() => document.body.clientWidth);
      assert.ok(Math.abs(box.width - availableWidth) < 1);
      assert.equal(
        await app.evaluate((element) => element === document.querySelector(".app-root")),
        true,
      );
    }
    await page.locator(".tile a").first().click();
    await page
      .locator(".detail-panel")
      .getByRole("button", { name: /^Play / })
      .click();
    await page.getByRole("button", { name: "Open Now Playing", exact: true }).click();
    await page.locator("#player-dialog").waitFor();
    assert.equal(
      await page
        .locator("#player-dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("landing keeps home and installation help in-tab and other destinations in new tabs", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const destinations = await page
      .locator('a:not([href^="#"])')
      .evaluateAll((links) => links.map((link) => ({ href: link.href, target: link.target })));
    assert.ok(destinations.length >= 10);
    assert.equal(destinations[0].target, "", "home stays in the current tab");
    assert.ok(
      destinations
        .slice(1)
        .every(
          (link) =>
            link.target ===
            (link.href.endsWith("/webapp/?/settings#install-title") ? "" : "_blank"),
        ),
    );
    await page.locator("header .brand").click();
    await page.waitForURL(base);
    assert.equal(page.context().pages().length, 1);
    await page
      .context()
      .route("**/*", (route) =>
        route.request().isNavigationRequest() && route.request().url() !== base
          ? route.fulfill({ contentType: "text/html", body: "<title>Destination</title>" })
          : route.continue(),
      );
    for (const [index, destination] of destinations.entries()) {
      if (index === 0) continue;
      if (destination.target === "") {
        await page.locator('a:not([href^="#"])').nth(index).click();
        await page.waitForURL(destination.href);
        assert.equal(page.context().pages().length, 1);
        await page.goto(base);
        continue;
      }
      const popup = page.waitForEvent("popup");
      await page.locator('a:not([href^="#"])').nth(index).click();
      const opened = await popup;
      await opened.waitForURL(destination.href);
      assert.equal(page.url(), base);
      assert.equal(page.context().pages().length, 2);
      await opened.close();
    }
  } finally {
    await browser.close();
  }
});

test("every planned album is browsable without live Deezer API access", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const requests = await mockDeezer(page, true);
  try {
    for (const album of catalog) {
      await page.goto(`${base}demo/?/library/album/${album.id}`);
      const details = page.locator('section[aria-label="Album details"]');
      await details.getByRole("heading", { name: album.title, exact: true, level: 1 }).waitFor();
      assert.equal(await details.locator(".track-row").count(), album.tracks.length);
      assert.ok((await details.textContent()).includes(String(album.year)));
    }
    await page.goto(`${base}demo/?/settings`);
    const credits = page.locator('article[aria-labelledby="demo-credits-title"]');
    await credits.waitFor();
    assert.equal(await credits.locator("li").count(), 53);
    assert.equal(await credits.locator("a").count(), 53);
    assert.equal(await credits.locator('a[href*="/track/"]').count(), 0);
    for (const album of catalog) {
      const link = credits.getByRole("link", {
        name: `${album.artist} — ${album.title} (${album.year})`,
        exact: true,
      });
      assert.equal(await link.getAttribute("href"), `https://www.deezer.com/album/${album.id}`);
    }
    assert.deepEqual(requests, []);
  } finally {
    await browser.close();
  }
});

test("standalone demo errors remain usable on desktop and mobile", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await mockDeezer(page, true);
  try {
    await page.goto(`${base}demo/`);
    await page.locator(".tile a").first().click();
    await page.getByRole("button", { name: "Play A Perfect Circle", exact: true }).click();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 812 });
      await page.getByRole("button", { name: "Show errors", exact: true }).click();
      await page.locator("#error-popover").waitFor();
      assert.equal(
        await page
          .locator("#error-popover")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
      );
      await page.getByRole("button", { name: "Close errors", exact: true }).click();
      assert.equal(await page.locator("#error-popover").isVisible(), false);
    }
  } finally {
    await browser.close();
  }
});

// Optional real-browser coverage. Run against the website server, not the app.
// See CONTRIBUTING.md for external Playwright setup and PREVIEW_URL.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5180").replace(/\/$/, "")}/`;

async function mockDeezer(page, unavailable = false) {
  const artist = { id: 702, name: "A Perfect Circle" };
  const tracks = [3135439, 3135442, 3135444].map((id, index) => ({
    id,
    title: ["The Hollow", "Judith", "3 Libras"][index],
    duration: 178,
    explicit_lyrics: index === 1,
    readable: true,
    artist,
    album: { id: 302117 },
    preview: "https://cdnt-preview.dzcdn.net/fixture.mp3",
  }));
  await page.route("https://api.deezer.com/**", (route) => {
    if (unavailable) return route.fulfill({ status: 500, body: "Unavailable" });
    const url = new URL(route.request().url());
    const callback = url.searchParams.get("callback");
    assert.match(callback, /^librasDeezer_[a-z0-9]+$/);
    const data = url.pathname.startsWith("/album/")
      ? {
          id: 302117,
          title: "Mer De Noms",
          artist,
          cover_medium: "https://cdn-images.dzcdn.net/fixture.svg",
          tracks: { data: tracks },
        }
      : tracks.find((track) => url.pathname === `/track/${track.id}`);
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
}

test("static website links to the full-width standalone demo", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await mockDeezer(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(base);
    assert.equal(await page.locator("script, .app-root, .site-showcase, dialog").count(), 0);
    assert.equal(
      await page
        .locator(".site-hero")
        .evaluate((element) => getComputedStyle(element).flexDirection),
      "column",
    );
    await page.getByRole("link", { name: "Try live demo", exact: true }).click();
    await page.waitForURL("**/demo/**");
    await page.locator(".app-root.standalone .tile a").first().waitFor();
    assert.equal(await page.locator(".website, [data-embedded], .site-demo-toolbar").count(), 0);
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
      .locator(".viewport-panel")
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

test("standalone demo errors remain usable on desktop and mobile", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await mockDeezer(page, true);
  try {
    await page.goto(`${base}demo/`);
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

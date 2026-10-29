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
    assert.equal(await page.locator(".tile a").count(), 14);
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

test("every planned album is browsable without live Deezer API access", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const requests = await mockDeezer(page, true);
  try {
    for (const album of catalog) {
      await page.goto(`${base}demo/#/library/artist/${album.artistId}/album/${album.id}`);
      const details = page.locator('section[aria-label="Album details"]');
      await details.getByRole("heading", { name: album.title, exact: true, level: 1 }).waitFor();
      assert.equal(await details.locator(".track-row").count(), album.tracks.length);
      assert.ok((await details.textContent()).includes(String(album.year)));
    }
    await page.goto(`${base}demo/#/settings`);
    const credits = page.locator('article[aria-labelledby="demo-credits-title"]');
    await credits.waitFor();
    assert.equal(await credits.locator("li").count(), 571);
    assert.equal(await credits.locator("h3").count(), 47);
    assert.equal(await credits.getByRole("link", { name: "Bullets", exact: true }).count(), 1);
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

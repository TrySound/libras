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
  const archiveArtist = { id: 1334, name: "Archive" };
  const archiveTracks = Array.from({ length: 13 }, (_, index) => ({
    id: 476972622 + index * 10,
    title: index === 1 ? "Bullets" : `Archive track ${index + 1}`,
    explicit_lyrics: index === 9,
    readable: true,
    artist: archiveArtist,
    album: { id: 59667692 },
    preview: "https://cdnt-preview.dzcdn.net/archive-fixture.mp3",
  }));
  const additionalAlbums = [
    {
      id: 320369597,
      title: "Fantasies",
      artist: { id: 956, name: "Metric" },
      firstId: 1758502927,
      step: 10,
      count: 10,
      firstTitle: "Help I'm Alive",
    },
    {
      id: 14879699,
      title: "OK Computer",
      artist: { id: 399, name: "Radiohead" },
      firstId: 138539971,
      step: 2,
      count: 12,
      firstTitle: "Airbag",
    },
    {
      id: 355921,
      title: "xx",
      artist: { id: 261212, name: "The xx" },
      firstId: 3787855,
      step: 1,
      count: 11,
      firstTitle: "Intro",
    },
  ].map(({ firstId, step, count, firstTitle, ...album }) => ({
    ...album,
    tracks: {
      data: Array.from({ length: count }, (_, index) => ({
        id: firstId + index * step,
        title: index === 0 ? firstTitle : `Fixture track ${index + 1}`,
        explicit_lyrics: false,
        readable: true,
        artist: album.artist,
        album: { id: album.id },
        preview: "https://cdnt-preview.dzcdn.net/fixture.mp3",
      })),
    },
  }));
  await page.route("https://api.deezer.com/**", (route) => {
    if (unavailable) return route.fulfill({ status: 500, body: "Unavailable" });
    const url = new URL(route.request().url());
    const callback = url.searchParams.get("callback");
    assert.match(callback, /^librasDeezer_[a-z0-9]+$/);
    const albums = [
      { id: 302117, title: "Mer De Noms", artist, tracks: { data: tracks } },
      {
        id: 59667692,
        title: "Controlling Crowds (Parts I-III)",
        artist: archiveArtist,
        tracks: { data: archiveTracks },
      },
      ...additionalAlbums,
    ];
    const album = albums.find((album) => url.pathname === `/album/${album.id}`);
    const data = album
      ? { ...album, cover_medium: "https://cdn-images.dzcdn.net/fixture.svg" }
      : albums
          .flatMap((album) => album.tracks.data)
          .find((track) => url.pathname === `/track/${track.id}`);
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
    assert.equal(await page.locator(".tile a").count(), 5);
    for (const id of [956, 399, 261212]) {
      assert.equal(await page.locator(`.tile a[href="#/library/artist/${id}"]`).count(), 1);
    }
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

test("Archive album shows all 13 tracks including Bullets and Settings credits", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await mockDeezer(page);
  try {
    await page.goto(`${base}demo/`);
    await page.locator('a[href="#/library/artist/1334"]').click();
    await page
      .getByRole("link", { name: "Open Controlling Crowds (Parts I-III)", exact: true })
      .click();
    await page.getByRole("button", { name: "Play Bullets — Preview", exact: true }).waitFor();
    assert.equal(await page.locator(".track-row").count(), 13);
    await page.getByRole("link", { name: "Settings", exact: true }).first().click();
    const credits = page.locator('article[aria-labelledby="demo-credits-title"]');
    await credits.waitFor();
    assert.equal(await credits.locator("li").count(), 49);
    assert.equal(
      await credits.locator('a[href="https://www.deezer.com/album/59667692"]').count(),
      1,
    );
    assert.equal(await credits.getByRole("link", { name: "Bullets", exact: true }).count(), 1);
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

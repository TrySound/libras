// Real Search and native overlays; only Subsonic transport is intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

test("Search responsive layout and native actions", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const artist = {
    id: "artist",
    name: "Search fixture artist with a long name that wraps naturally",
  };
  const album = { id: "album", name: "Search fixture album", artists: [artist], year: 2024 };
  const songs = Array.from({ length: 4 }, (_, i) => ({
    id: `track-${i}`,
    title: `Search fixture track ${i}`,
    albumId: album.id,
    artists: [artist],
    duration: 123,
    contentType: "audio/mpeg",
  }));
  await page.route("https://search.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    let fields = {};
    if (method === "ping")
      fields = { version: "1.16.1", type: "test", serverVersion: "1", openSubsonic: true };
    else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
    else if (method === "search3")
      fields = {
        searchResult3: {
          artist: Number(url.searchParams.get("artistOffset")) === 0 ? [artist] : [],
          album: Number(url.searchParams.get("albumOffset")) === 0 ? [album] : [],
          song: Number(url.searchParams.get("songOffset")) === 0 ? songs : [],
        },
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  try {
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("https://search.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".tile").waitFor();
    await page.locator('a[href="#/search"]').filter({ visible: true }).click();
    const input = page.getByRole("searchbox", { name: "Search library" });
    await input.waitFor();
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    await input.fill("Search fixture");
    const artists = page.getByRole("region", { name: "Artists", exact: true });
    const tracks = page.getByRole("region", { name: "Tracks", exact: true });
    await tracks.locator(".track-row").first().waitFor();
    assert.equal(await artists.locator(".artwork-placeholder").isVisible(), true);
    const options = tracks.getByRole("button", {
      name: `Open menu for ${songs[0].title}`,
      exact: true,
    });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await options.filter({ visible: true }).click();
      const panel = page.locator(width > 800 ? "#search-menu-popover" : "#search-menu");
      await panel.waitFor({ state: "visible" });
      assert.equal(await panel.getByRole("heading").textContent(), songs[0].title);
      await page.keyboard.press("Escape");
      assert.equal(
        await options.filter({ visible: true }).evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    }
    // Long press uses the sheet even on desktop, with focus restored on dismissal.
    const target = tracks.getByRole("button", { name: `Play ${songs[1].title}`, exact: true });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    const sheet = page.locator("#search-menu");
    await sheet.waitFor({ state: "visible" });
    await page.mouse.up();
    assert.equal(await sheet.evaluate((node) => node.matches(":modal")), true);
    assert.equal(await sheet.getByRole("heading").textContent(), songs[1].title);
    await sheet.getByRole("button", { name: "Close menu" }).click();
    assert.equal(await target.evaluate((node) => node === document.activeElement), true);
    await page.setViewportSize({ width: 393, height: 852 });
    await options.filter({ visible: true }).click();
    await sheet.waitFor({ state: "visible" });
    const handle = await sheet.locator(".dialog-handle").boundingBox();
    const touch = await page.context().newCDPSession(page);
    const point = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    for (const offset of [20, 50, 90, 140]) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, y: point.y + offset }],
      });
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sheet.waitFor({ state: "hidden" });
    await touch.detach();
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

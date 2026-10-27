// Real Library and native overlays; only Subsonic transport is intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

test("Library tiles, responsive actions, lazy batches, and navigation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const artists = Array.from({ length: 53 }, (_, i) => ({
    id: `artist ${i}`,
    name: i ? `Artist ${i}` : "A very long artist name without artwork that should wrap naturally",
  }));
  const albums = artists.map((artist, i) => ({
    id: `album-${i}`,
    name: `Album ${i}`,
    artists: [artist],
  }));
  const songs = albums.map((album, i) => ({
    id: `track-${i}`,
    title: `Track ${i}`,
    albumId: album.id,
    artists: [artists[i]],
    contentType: "audio/mpeg",
  }));
  await page.route("https://library.example.test/**", async (route) => {
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
          artist: Number(url.searchParams.get("artistOffset")) === 0 ? artists : [],
          album: Number(url.searchParams.get("albumOffset")) === 0 ? albums : [],
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
    await page.getByLabel("Host", { exact: true }).fill("https://library.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const first = page.locator(".tile").first();
    await first.waitFor();
    assert.equal(await page.locator(".tile").count(), 48);
    assert.equal(await first.locator("img").getAttribute("src"), null);
    assert.equal(await first.locator(".artwork-placeholder").isVisible(), false);
    const options = first.getByRole("button", {
      name: `Actions for ${artists[0].name}`,
      exact: true,
    });
    await options.filter({ visible: true }).click();
    const popover = page.locator("#artist-popover");
    await popover.waitFor({ state: "visible" });
    assert.equal(await popover.getByRole("heading").textContent(), artists[0].name);
    assert.equal(await page.locator("#artist-menu").isVisible(), false);
    assert.equal(new URL(page.url()).hash, "#/library");
    await page.keyboard.press("Escape");
    assert.equal(
      await options.filter({ visible: true }).evaluate((node) => node === document.activeElement),
      true,
    );
    await options.filter({ visible: true }).click();
    await page.setViewportSize({ width: 393, height: 852 });
    await popover.waitFor({ state: "hidden" });
    await options.filter({ visible: true }).click();
    const sheet = page.locator("#artist-menu");
    await sheet.waitFor({ state: "visible" });
    assert.equal(await sheet.evaluate((node) => node.matches(":modal")), true);
    await page.keyboard.press("Escape");
    assert.equal(
      await options.filter({ visible: true }).evaluate((node) => node === document.activeElement),
      true,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    }
    await page.locator(".library-sentinel").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 53);
    await first.getByRole("link", { name: artists[0].name, exact: true }).click();
    await page.waitForURL(/artist%200/);
    assert.equal(await page.locator(".library-view").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

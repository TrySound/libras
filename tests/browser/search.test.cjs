// Real Search and native overlays; only Subsonic transport is intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";
const screenshots = process.env.SCREENSHOT_DIR;

test("Search filters, incremental lists, URLs and native actions", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const artist = {
    id: "artist/a&b+c%2F=d?#",
    name: "Search fixture artist with a long name that wraps naturally",
  };
  const album = {
    id: "album/a&b+c%2F=d?#",
    name: "Search fixture album",
    artists: [artist],
    year: 2024,
  };
  const directoryArtists = Array.from({ length: 149 }, (_, i) => ({
    id: `directory-artist-${i}`,
    name: `Directory artist ${i}`,
  }));
  const directoryAlbums = directoryArtists.map((a, i) => ({
    id: `directory-album-${i}`,
    name: `Directory album ${i}`,
    artists: [a],
    year: 2024,
  }));
  const songs = Array.from({ length: 150 }, (_, i) => ({
    id: `track-${i}`,
    title: `Search fixture track ${i}${i === 0 ? " — a long title with naturally wrapped lines and Unicode Beyoncé 東京" : ""}`,
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
          artist:
            Number(url.searchParams.get("artistOffset")) === 0 ? [artist, ...directoryArtists] : [],
          album:
            Number(url.searchParams.get("albumOffset")) === 0 ? [album, ...directoryAlbums] : [],
          song: Number(url.searchParams.get("songOffset")) === 0 ? songs : [],
        },
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });

  async function loadAll(region, total) {
    const first = await region.locator(".track-row").first().elementHandle();
    while ((await region.locator(".track-row").count()) < total) {
      const count = await region.locator(".track-row").count();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await region
        .locator(".track-row")
        .nth(Math.min(count + 47, total - 1))
        .waitFor();
      assert.equal(await first.evaluate((node) => node.isConnected), true);
    }
    assert.equal(await region.locator(".track-row").count(), total);
    assert.equal(await region.locator(".library-sentinel").count(), 0);
  }

  try {
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("https://search.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".tile").first().waitFor();
    await page.locator('a[href="?/search"]').filter({ visible: true }).click();
    const input = page.getByRole("searchbox", { name: "Search library" });
    await input.waitFor();
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    const chips = ["Artist", "Album", "Track"].map((name) =>
      page.getByRole("button", { name, exact: true }),
    );
    const groups = ["Artists", "Albums", "Tracks"].map((name) =>
      page.getByRole("region", { name, exact: true }),
    );
    const tracks = groups[2];
    await input.fill("Search fixture");
    for (let mask = 0; mask < 8; mask++) {
      for (let i = 0; i < 3; i++) {
        if (((await chips[i].getAttribute("aria-pressed")) === "true") !== !!(mask & (1 << i)))
          await chips[i].click();
      }
      for (let i = 0; i < 3; i++)
        assert.equal(await groups[i].count(), !mask || mask & (1 << i) ? 1 : 0);
      if (!mask || mask === 7) assert.equal(await tracks.locator(".track-row").count(), 3);
      if (mask === 4) assert.equal(await tracks.locator(".track-row").count(), 48);
    }
    await chips[0].click();
    await chips[1].click(); // Track only.
    await chips[2].focus();
    await page.keyboard.press("Space");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "false");
    await page.keyboard.press("Enter");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    assert.equal(await chips[2].evaluate((node) => node === document.activeElement), true);
    await input.fill("");
    assert.equal(await tracks.locator(".track-row").count(), 48);
    assert.equal(await tracks.locator("header .metadata").textContent(), "150");
    assert.equal(await page.getByRole("button", { name: "Show more tracks" }).count(), 0);

    // Native menu behavior and utility-only layout at desktop and narrow widths.
    const options = tracks
      .getByRole("button", { name: `Open menu for ${songs[0].title}`, exact: true })
      .filter({ visible: true });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await chips[2].focus();
      if (screenshots)
        await page.screenshot({
          path: `${screenshots}/search-${width === 320 ? "narrow" : "desktop"}.png`,
        });
      await options.click();
      const panel = page.locator(width > 800 ? "#search-menu-popover" : "#search-menu");
      await panel.waitFor({ state: "visible" });
      assert.equal(await panel.getByRole("heading").textContent(), songs[0].title);
      if (screenshots)
        await page.screenshot({
          path: `${screenshots}/search-${width === 320 ? "narrow" : "desktop"}-menu.png`,
        });
      await page.keyboard.press("Escape");
      assert.equal(await options.evaluate((node) => node === document.activeElement), true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    if (screenshots) await page.screenshot({ path: `${screenshots}/search-narrow-enlarged.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Long press still opens the ordinary shared sheet.
    const target = tracks.getByRole("button", { name: `Play ${songs[1].title}`, exact: true });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    const sheet = page.locator("#search-menu");
    await sheet.waitFor({ state: "visible" });
    await page.mouse.up();
    assert.equal(await sheet.getByRole("heading").textContent(), songs[1].title);
    await sheet.getByRole("button", { name: "Close menu" }).click();
    assert.equal(await target.evaluate((node) => node === document.activeElement), true);

    // Loaded rows accumulate; both browse and matching lists reach the final record.
    await loadAll(tracks, 150);
    await tracks.getByRole("button", { name: `Play ${songs[149].title}`, exact: true }).waitFor();
    await input.fill("Search fixture");
    assert.equal(await tracks.locator(".track-row").count(), 48);
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    await loadAll(tracks, 150);
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), "Search fixture");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    assert.equal(await tracks.locator(".track-row").count(), 48);

    // Typing replaces history; chips push. URL criteria survive traversal and reload.
    const special = "Beyoncé 東京 + & % / ? #";
    const before = await page.evaluate(() => navigation.entries().length);
    await input.fill(special);
    await page.waitForURL(
      (url) =>
        new URLSearchParams(url.search.slice(url.search.indexOf("&") + 1)).get("q") === special,
    );
    assert.equal(await page.evaluate(() => navigation.entries().length), before);
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    await chips[0].click();
    await page.goBack();
    assert.equal(await input.inputValue(), special);
    assert.equal(await chips[0].getAttribute("aria-pressed"), "false");
    await page.goForward();
    assert.equal(await chips[0].getAttribute("aria-pressed"), "true");
    await page.goto(`${base}/?/search&type=track&q=Search+fixture#search-anchor`);
    await tracks.locator(".track-row").first().waitFor();
    assert.equal(await input.inputValue(), "Search fixture");
    assert.equal(new URL(page.url()).hash, "#search-anchor");
    await page.locator('a[href="?/search"]').filter({ visible: true }).click();
    assert.equal(await input.inputValue(), "");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "false");

    for (const i of [0, 1]) {
      await chips[i].click();
      assert.equal(await groups[i].locator(".track-row").count(), 48);
      await loadAll(groups[i], 150);
      const lastLink = groups[i].locator(".track-row").last().getByRole("link");
      await lastLink.click();
      await page.goBack();
      await input.waitFor();
      assert.equal(await chips[i].getAttribute("aria-pressed"), "true");
      await input.fill("Directory");
      assert.equal(await groups[i].locator(".track-row").count(), 48);
      assert.equal(await groups[i].locator("header .metadata").textContent(), "149");
      await loadAll(groups[i], 149);
      await input.fill("");
      await chips[i].click();
    }
    // Real same-route links reset the result view without a search-specific router API.
    await chips[2].click();
    await loadAll(tracks, 150);
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.id = "incoming-search-link";
      link.href = "?/search&type=album&q=Directory";
      link.textContent = "Browse directory albums";
      Object.assign(link.style, {
        position: "fixed",
        bottom: "16px",
        left: "16px",
        zIndex: "9999",
      });
      document.body.append(link);
    });
    await page.getByRole("link", { name: "Browse directory albums", exact: true }).click();
    await groups[1].locator(".track-row").first().waitFor();
    assert.ok(
      await groups[1]
        .locator(".track-row")
        .first()
        .evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.top >= 0 && bounds.top < innerHeight;
        }),
    );
    await page.goBack();
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    assert.equal(await input.inputValue(), "");
    await page.goForward();
    assert.equal(await chips[1].getAttribute("aria-pressed"), "true");
    assert.equal(await input.inputValue(), "Directory");
    // Router matches raw tokens while Search reads only criteria from the full params.
    await page.goto(
      `${base}/?/search=&unknown=keep&type=no&type=track&type=track&q=Search+fixture&q=ignored`,
    );
    await tracks.locator(".track-row").first().waitFor();
    assert.equal(await input.inputValue(), "Search fixture");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    assert.equal(await chips[0].getAttribute("aria-pressed"), "false");
    await input.fill("Search fixture track 149");
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    // Use the browser's real URLPattern with encoded IDs and a literal route +.
    for (const [kind, item] of [
      ["artist", artist],
      ["album", album],
    ]) {
      const id = encodeURIComponent(item.id).replace("%2B", "+");
      await page.goto(`${base}/?/library/${kind}/${id}=&unknown=keep`);
      await page.getByRole("heading", { level: 1, name: item.name, exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

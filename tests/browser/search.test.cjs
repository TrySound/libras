// Real Search and native overlays; only Subsonic transport is intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";
const screenshots = process.env.SCREENSHOT_DIR;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const directoryArtists = Array.from({ length: 1499 }, (_, i) => ({
    id: `directory-artist-${i}`,
    name: `Directory artist ${i}`,
  }));
  const directoryAlbums = directoryArtists.map((a, i) => ({
    id: `directory-album-${i}`,
    name: `Directory album ${i}`,
    artists: [a],
    year: 2024,
  }));
  const songs = Array.from({ length: 1500 }, (_, i) => ({
    id: `track-${i}`,
    title: `Search fixture track ${i}${i % 17 === 0 ? " — a very long title with multiple wrapped lines and Unicode Beyoncé 東京, to measure rather than truncate" : ""}`,
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
    await input.fill("Search fixture");
    const artists = page.getByRole("region", { name: "Artists", exact: true });
    const tracks = page.getByRole("region", { name: "Tracks", exact: true });
    await tracks.locator(".track-row").first().waitFor();
    assert.equal(await artists.locator(".artwork-placeholder").isVisible(), true);
    const options = tracks.getByRole("button", {
      name: `Open menu for ${songs[1].title}`,
      exact: true,
    });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await options.filter({ visible: true }).click();
      const panel = page.locator(width > 800 ? "#search-menu-popover" : "#search-menu");
      await panel.waitFor({ state: "visible" });
      assert.equal(await panel.getByRole("heading").textContent(), songs[1].title);
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
    const target = tracks.getByRole("button", { name: `Play ${songs[2].title}`, exact: true });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    const sheet = page.locator("#search-menu");
    await sheet.waitFor({ state: "visible" });
    await page.mouse.up();
    assert.equal(await sheet.evaluate((node) => node.matches(":modal")), true);
    assert.equal(await sheet.getByRole("heading").textContent(), songs[2].title);
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
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await input.fill("Search fixture");
    const chips = ["Artist", "Album", "Track"].map((name) =>
      page.getByRole("button", { name, exact: true }),
    );
    for (let mask = 0; mask < 8; mask++) {
      for (let i = 0; i < chips.length; i++) {
        if (((await chips[i].getAttribute("aria-pressed")) === "true") !== !!(mask & (1 << i)))
          await chips[i].click();
      }
      const count = [0, 1, 2].filter((i) => mask & (1 << i)).length;
      assert.equal(
        await page.locator('section[aria-label="Artists"]').count(),
        !mask || mask & 1 ? 1 : 0,
      );
      assert.equal(
        await page.locator('section[aria-label="Albums"]').count(),
        !mask || mask & 2 ? 1 : 0,
      );
      assert.equal(
        await page.locator('section[aria-label="Tracks"]').count(),
        !mask || mask & 4 ? 1 : 0,
      );
      assert.equal(await page.locator(".virtual-list").count(), count === 1 ? 1 : 0);
    }
    await chips[0].click();
    await chips[1].click(); // Track only.
    await chips[2].focus();
    await page.keyboard.press("Space");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "false");
    assert.equal(await chips[2].evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    await input.fill("");
    await page.locator('.virtual-list li[aria-setsize="1500"]').first().waitFor();
    assert.equal(await tracks.locator(".metadata").first().textContent(), "1500");
    const rowCount = async () => tracks.locator(".track-row").count();
    assert.ok((await rowCount()) < 40);
    assert.equal(await page.getByRole("button", { name: "Show more tracks" }).count(), 0);
    const browseURL = page.url();
    assert.ok(browseURL.includes("type=track"));
    await page.reload();
    await page.locator('.virtual-list li[aria-setsize="1500"]').first().waitFor();
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    // Sequential Tab crosses the virtual window, not straight out of the list.
    const lastMounted = page.locator(".virtual-list li").last();
    const lastIndex = Number(await lastMounted.getAttribute("data-index"));
    await lastMounted
      .getByRole("button", { name: /^Open menu/ })
      .filter({ visible: true })
      .focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => Number(document.activeElement.closest("li").dataset.index)),
      lastIndex + 1,
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => Number(document.activeElement.closest("li").dataset.index)),
      lastIndex,
    );
    // Open menus keep their invoker mounted even when it leaves the window.
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(150);
    const firstOptions = tracks
      .getByRole("button", { name: `Open menu for ${songs[0].title}`, exact: true })
      .filter({ visible: true });
    await firstOptions.click();
    await page.locator("#search-menu-popover").waitFor({ state: "visible" });
    await input.click();
    await page.locator("#search-menu-popover").waitFor({ state: "hidden" });
    await wait(100);
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    await firstOptions.click();
    await page.locator("#search-menu-popover").waitFor({ state: "visible" });
    if (screenshots) await page.screenshot({ path: `${screenshots}/search-desktop-menu.png` });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(200);
    assert.equal(await firstOptions.count(), 1);
    await page.keyboard.press("Escape");
    await wait(100);
    assert.equal(await firstOptions.evaluate((node) => node === document.activeElement), true);
    assert.ok(await firstOptions.evaluate((node) => node.getBoundingClientRect().bottom > 0));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(200);
    await tracks.getByRole("button", { name: `Play ${songs[1499].title}`, exact: true }).waitFor();
    assert.ok((await rowCount()) < 40);
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(200);
    assert.ok((await rowCount()) < 40);
    // Wrapped measurements do not overlap and resize remains bounded.
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await wait(200);
      const geometry = await page.locator(".virtual-list li").evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        }),
      );
      for (let i = 1; i < geometry.length; i++)
        assert.ok(geometry[i].top >= geometry[i - 1].bottom - 1);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await chips[2].focus();
      if (screenshots)
        await page.screenshot({
          path: `${screenshots}/search-${width === 320 ? "narrow" : "desktop"}.png`,
        });
      if (width === 320) {
        await firstOptions.click();
        await sheet.waitFor({ state: "visible" });
        if (screenshots) await page.screenshot({ path: `${screenshots}/search-narrow-menu.png` });
        await page.keyboard.press("Escape");
        assert.equal(await firstOptions.evaluate((node) => node === document.activeElement), true);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await wait(200);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.ok((await rowCount()) < 40);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "";
        });
      }
    }
    // Typing replaces; chips push; Back/Forward and direct URLs remain authoritative.
    const special = "Beyoncé 東京 + & % / ? #";
    const before = await page.evaluate(() => navigation.entries().length);
    await input.fill(special);
    await page.waitForURL(
      (url) => new URLSearchParams(url.search.split("&").slice(1).join("&")).get("q") === special,
    );
    assert.equal(await page.evaluate(() => navigation.entries().length), before);
    if (screenshots) await page.screenshot({ path: `${screenshots}/search-no-matches.png` });
    await chips[0].click();
    await page.goBack();
    assert.equal(await input.inputValue(), special);
    assert.equal(await chips[0].getAttribute("aria-pressed"), "false");
    await page.goForward();
    assert.equal(await chips[0].getAttribute("aria-pressed"), "true");
    await page.goto(`${base}/?/search&type=track&q=Search+fixture#search-anchor`);
    await tracks.locator(".track-row").first().waitFor();
    assert.equal(await input.inputValue(), "Search fixture");
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    assert.equal(new URL(page.url()).hash, "#search-anchor");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(200);
    assert.ok((await rowCount()) < 40);
    // Single-type matches reach the actual final result too (score order is deterministic).
    await input.fill("Search fixture track 1499");
    await tracks.getByRole("button", { name: `Play ${songs[1499].title}`, exact: true }).waitFor();
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    // Result navigation and Back restore URL criteria; a bare Search link resets them.
    await chips[2].click();
    await chips[0].click();
    await input.fill("Search fixture");
    await artists.getByRole("link", { name: artist.name, exact: true }).click();
    await page.goBack();
    await input.waitFor();
    assert.equal(await input.inputValue(), "Search fixture");
    assert.equal(await chips[0].getAttribute("aria-pressed"), "true");
    await page.locator('a[href="?/search"]').filter({ visible: true }).click();
    assert.equal(await input.inputValue(), "");
    assert.equal(await chips[0].getAttribute("aria-pressed"), "false");
    for (const [i, group] of [
      [0, "Artists"],
      [1, "Albums"],
    ]) {
      await chips[i].click();
      const region = page.getByRole("region", { name: group, exact: true });
      await region.locator('.virtual-list li[aria-setsize="1500"]').first().waitFor();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await wait(200);
      assert.equal(
        await region.locator(".virtual-list li").last().getAttribute("aria-posinset"),
        "1500",
      );
      const lastLink = region.locator(".virtual-list li").last().getByRole("link");
      await lastLink.waitFor();
      assert.ok((await region.locator(".track-row").count()) < 40);
      if (i === 1) {
        const y = await page.evaluate(() => scrollY);
        await lastLink.click();
        await page.goBack();
        await lastLink.waitFor();
        assert.ok((await page.evaluate(() => scrollY)) > y * 0.8);
        assert.equal(await chips[i].getAttribute("aria-pressed"), "true");
      }
      await input.fill("Directory");
      await region.locator('.virtual-list li[aria-setsize="1499"]').first().waitFor();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await wait(200);
      assert.ok((await region.locator(".track-row").count()) < 40);
      assert.equal(
        await region.locator(".virtual-list li").last().getAttribute("aria-posinset"),
        "1499",
      );
      await input.fill("");
      await chips[i].click();
    }
    // Incoming same-route anchors must not inherit a deeply scrolled virtual window.
    // Keep the anchor at the current viewport so clicking it cannot mask the bug
    // by scrolling the page to the search controls before navigation.
    await chips[2].click();
    await tracks.locator('.virtual-list li[aria-setsize="1500"]').first().waitFor();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await wait(200);
    const deepScroll = await page.evaluate(() => scrollY);
    assert.ok(deepScroll > 10000);
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
    const firstAlbum = page.locator(
      'section[aria-label="Albums"] .virtual-list li[data-index="0"]',
    );
    await firstAlbum.waitFor();
    await page.waitForFunction(() => {
      const first = document.querySelector(
        'section[aria-label="Albums"] .virtual-list li[data-index="0"]',
      );
      if (!first) return false;
      const bounds = first.getBoundingClientRect();
      return scrollY < 200 && bounds.top >= 0 && bounds.top < innerHeight;
    });
    assert.equal(await input.inputValue(), "Directory");
    assert.equal(await chips[1].getAttribute("aria-pressed"), "true");
    await page.goBack();
    await tracks.locator(".track-row").first().waitFor();
    assert.equal(await chips[2].getAttribute("aria-pressed"), "true");
    assert.equal(await input.inputValue(), "");
    assert.ok((await page.evaluate(() => scrollY)) > deepScroll * 0.8);
    await page.goForward();
    await firstAlbum.waitFor();
    assert.ok(
      await firstAlbum.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.top >= 0 && bounds.top < innerHeight;
      }),
    );
    await page.locator("#incoming-search-link").evaluate((node) => node.remove());
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

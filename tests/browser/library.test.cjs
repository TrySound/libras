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
    coverArt: i === 1 ? "artist-cover" : undefined,
  }));
  const albums = artists.map((artist, i) => ({
    id: `album-${i}`,
    name: `Album ${i}`,
    artists: [artist],
    coverArt: i === 1 ? "album-cover" : undefined,
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
    if (method === "getCoverArt") {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#b04040"/></svg>',
      });
      return;
    }
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
    assert.notEqual(
      await popover.evaluate((node) => getComputedStyle(node).backgroundImage),
      "none",
    );
    assert.equal(await popover.getByRole("heading").textContent(), artists[0].name);
    assert.equal(await page.locator("#artist-menu").isVisible(), false);
    assert.equal(new URL(page.url()).hash, "#/library");
    await page.keyboard.press("Escape");
    assert.equal(
      await options.filter({ visible: true }).evaluate((node) => node === document.activeElement),
      true,
    );
    await page.setViewportSize({ width: 393, height: 852 });
    await options.filter({ visible: true }).click();
    const sheet = page.locator("#artist-menu");
    await sheet.waitFor({ state: "visible" });
    assert.equal(await sheet.evaluate((node) => node.matches(":modal")), true);
    assert.notEqual(await sheet.evaluate((node) => getComputedStyle(node).backgroundImage), "none");
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
    for (const width of [320, 768, 800, 810, 811, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const desktop = await page.locator(".app-root").evaluate((node) => node.clientWidth > 800);
      assert.equal(await first.locator(".only-desktop").isVisible(), desktop);
      assert.equal(await first.locator(".only-mobile").isVisible(), !desktop);
      assert.equal(await page.locator(".app-sidebar").isVisible(), desktop);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    }
    await page.locator(".library-sentinel").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 53);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    assert.equal(
      await page.evaluate(() => {
        const root = document.documentElement;
        return root.getBoundingClientRect().height >= root.scrollHeight - 1;
      }),
      true,
      "the canvas background covers the full document, including the end runway",
    );
    await first.getByRole("link", { name: artists[0].name, exact: true }).click();
    await page.waitForURL(/artist%200/);
    assert.equal(await page.locator(".library-view").count(), 0);
    const artistView = page.getByRole("region", { name: "Artist details" });
    await artistView.getByRole("heading", { name: artists[0].name, exact: true }).waitFor();
    assert.equal(await artistView.locator(".track-row").count(), 1);
    async function checkDetailLayout(view) {
      // Stacked, equal columns, and 2:3 after sidebar/gutter clearance.
      for (const [width, ratio] of [
        [768, null],
        [1280, 1],
        [1440, 2 / 3],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await view.evaluate((node) => {
          const panel = node.querySelector(".viewport-panel");
          const panelBox = panel.getBoundingClientRect();
          const listBox = panel.nextElementSibling.getBoundingClientRect();
          return {
            sticky: getComputedStyle(panel).position === "sticky",
            beside: listBox.left >= panelBox.right,
            below: listBox.top >= panelBox.bottom,
            ratio: panelBox.width / listBox.width,
          };
        });
        assert.equal(layout.sticky, ratio !== null);
        assert.equal(layout.beside, ratio !== null);
        if (ratio !== null) assert.ok(Math.abs(layout.ratio - ratio) < 0.02);
        else assert.equal(layout.below, true);
      }
    }
    async function checkCoverBudget(view) {
      for (const height of [450, 900]) {
        await page.setViewportSize({ width: 1440, height });
        const cover = await view.locator(".viewport-panel").evaluate((panel) => {
          const artwork = panel.querySelector(".viewport-panel-cover");
          const details = artwork.nextElementSibling;
          return {
            display: getComputedStyle(artwork).display,
            detailsOffset: details.getBoundingClientRect().top - panel.getBoundingClientRect().top,
          };
        });
        assert.equal(cover.display, height === 450 ? "none" : "block");
        if (height === 450)
          assert.ok(Math.abs(cover.detailsOffset) < 1, "hidden cover leaves no gap above details");
      }
    }
    await checkDetailLayout(artistView);
    await checkCoverBudget(artistView);
    assert.equal(await artistView.locator(".atmosphere").isVisible(), false);
    await artistView
      .getByRole("button", { name: "Actions for Album 0", exact: true })
      .filter({ visible: true })
      .click();
    const artistActions = page.locator("#artist-detail-menu-popover");
    await artistActions.waitFor({ state: "visible" });
    assert.equal(await artistActions.getByRole("heading").textContent(), "Album 0");
    await page.keyboard.press("Escape");
    await artistView.getByRole("link", { name: "Open Album 0", exact: true }).click();
    const albumView = page.getByRole("region", { name: "Album details" });
    await albumView.getByRole("heading", { name: "Album 0", exact: true }).waitFor();
    assert.equal(
      await albumView.getByRole("button", { name: "Play Track 0", exact: true }).count(),
      1,
    );
    await checkDetailLayout(albumView);
    await checkCoverBudget(albumView);
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await albumView
        .getByRole("button", { name: "Actions for Track 0", exact: true })
        .filter({ visible: true })
        .click();
      const panel = page.locator(
        width <= 800 ? "#album-detail-menu" : "#album-detail-menu-popover",
      );
      await panel.waitFor({ state: "visible" });
      assert.equal(await panel.getByRole("heading").textContent(), "Track 0");
      await page.keyboard.press("Escape");
    }
    const trackTarget = albumView.getByRole("button", { name: "Play Track 0", exact: true });
    await trackTarget.scrollIntoViewIfNeeded();
    const trackBox = await trackTarget.boundingBox();
    await page.mouse.move(trackBox.x + 8, trackBox.y + 8);
    await page.mouse.down();
    await page.locator("#album-detail-menu").waitFor({ state: "visible" });
    await page.mouse.up();
    assert.equal(
      await page.locator("#album-detail-menu").getByRole("heading").textContent(),
      "Track 0",
    );
    await page.keyboard.press("Escape");
    assert.equal(await trackTarget.evaluate((node) => node === document.activeElement), true);
    await page.setViewportSize({ width: 393, height: 852 });
    await albumView
      .getByRole("button", { name: "Actions for Album 0", exact: true })
      .filter({ visible: true })
      .click();
    await page.locator("#album-detail-menu").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#album-detail-menu").getByRole("heading").textContent(),
      "Album 0",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press("Escape");
    await page.locator("#album-detail-menu").waitFor({ state: "hidden" });
    await albumView
      .getByRole("button", { name: "Actions for Track 0", exact: true })
      .filter({ visible: true })
      .click();
    await page.locator("#album-detail-menu-popover").waitFor({ state: "visible" });
    await page
      .locator("#album-detail-menu-popover")
      .getByRole("button", { name: "Play last", exact: true })
      .click();
    await page.locator("#album-detail-menu-popover").waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.querySelector(".mini-player strong")?.textContent === "Track 0",
    );
    await albumView.getByRole("link", { name: artists[0].name, exact: true }).click();
    await artistView.waitFor();
    await page.locator('a[href="#/library"]').filter({ visible: true }).first().click();
    await page.getByRole("link", { name: "Artist 1", exact: true }).click();
    async function checkAtmosphere() {
      const background = page.locator(".app-page .atmosphere");
      await background.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const cover = document.querySelector(".viewport-panel .artwork img");
        return (
          cover?.getAttribute("src") &&
          cover.getAttribute("src") ===
            document.querySelector(".app-page .atmosphere").getAttribute("src")
        );
      });
      assert.equal(
        await background.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const shell = node.closest(".app-shell").getBoundingClientRect();
          return Math.abs(box.height - shell.height) < 1 && Math.abs(box.width - shell.width) < 1;
        }),
        true,
        "route-owned atmosphere fills the shell",
      );
      return background.getAttribute("src");
    }
    const artistBackground = await checkAtmosphere();
    await artistView.getByRole("link", { name: "Open Album 1", exact: true }).click();
    await albumView.getByRole("heading", { name: "Album 1", exact: true }).waitFor();
    assert.notEqual(await checkAtmosphere(), artistBackground);
    await page.locator('a[href="#/library"]').filter({ visible: true }).first().click();
    await page.locator(".library-view").waitFor();
    assert.equal(await page.locator(".app-page .atmosphere").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

// Responsive shell behavior against the built app; no simulated session/audio layer.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:4173").replace(/\/$/, "")}/`;

test("responsive navigation, native drawer, focus, and document scrolling", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(base);
    await page.locator(".settings-view").waitFor();
    // Short routes still paint the whole viewport, including the document canvas
    // exposed by native overscroll (which headless Chromium cannot rubber-band).
    await page.setViewportSize({ width: 1280, height: 1600 });
    const background = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const routeStyle = getComputedStyle(document.querySelector(".settings-view"));
      return {
        fillsViewport: document.querySelector(".app-shell").getBoundingClientRect().bottom >= innerHeight,
        documentCanvas: rootStyle.backgroundImage.includes("repeating-linear-gradient") && rootStyle.backgroundImage.includes("radial-gradient"),
        routeTransparent: routeStyle.backgroundImage === "none" && routeStyle.backgroundColor === "rgba(0, 0, 0, 0)",
        color: rootStyle.backgroundColor,
      };
    });
    assert.deepEqual(background, {
      fillsViewport: true,
      documentCanvas: true,
      routeTransparent: true,
      color: "rgb(19, 0, 0)",
    });
    await page.screenshot({ path: "/tmp/libras-navigation-tall-settings.png" });
    await page.setViewportSize({ width: 1280, height: 800 });
    const sidebar = page.locator(".app-sidebar");
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    await sidebar.waitFor({ state: "visible" });
    assert.equal(await menu.isVisible(), false);
    assert.equal(await page.locator(".app-header").evaluate((element) => getComputedStyle(element).display), "none");
    assert.equal(await page.evaluate(() => {
      const shell = document.querySelector(".app-shell").getBoundingClientRect();
      const main = document.querySelector(".app-page").getBoundingClientRect();
      return main.top === shell.top;
    }), true, "the hidden desktop topbar reserves no space");
    assert.equal(await sidebar.locator('[aria-current="page"]').getAttribute("href"), "#/settings");
    await sidebar.getByRole("link", { name: "Downloads", exact: true }).focus();
    await page.setViewportSize({ width: 768, height: 800 });
    assert.equal(await sidebar.isVisible(), false, "the mobile breakpoint hides even a focused sidebar");
    assert.equal(await menu.isVisible(), true);
    await menu.click();
    const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
    await drawer.waitFor({ state: "visible" });
    assert.equal(await sidebar.isVisible(), false);
    await page.waitForFunction(() => document.querySelector('[aria-label="Open menu"]').getAttribute("aria-expanded") === "true");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
    await menu.click();
    await drawer.getByRole("link", { name: "Downloads", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
    await page.waitForURL("**/#/downloads");
    const mountedShell = await page.locator(".app-shell").elementHandle();
    await menu.click();
    await page.evaluate(() => window.navigation.navigate("#/settings").finished);
    await page.locator(".settings-view").waitFor();
    assert.equal(await drawer.isVisible(), true, "route changes alone do not dismiss the drawer");
    assert.equal(await drawer.getByRole("link", { name: "Settings", exact: true }).getAttribute("aria-current"), "page");
    assert.equal(await mountedShell.evaluate((element) => element === document.querySelector(".app-shell")), true);
    await drawer.getByRole("link", { name: "Settings", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
    await menu.click();
    await drawer.getByRole("link", { name: "Settings", exact: true }).focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await drawer.isVisible(), true, "resizing does not imperatively dismiss a modal");
    assert.equal(await drawer.getByRole("link", { name: "Settings", exact: true }).evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.getClientRects().length > 0), true);
    assert.equal(await menu.isVisible(), false);
    // Legacy deep links still resolve and select Library, not a second destination.
    await page.goto(`${base}#/library/artist/missing/album/missing`);
    await sidebar.waitFor();
    assert.equal(await sidebar.locator('[aria-current="page"]').getAttribute("href"), "#/library");
    for (const width of [320, 375, 600, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => window.navigation.navigate("#/settings").finished);
      await page.locator(".settings-view").waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `overflow at ${width}`,
      );
    }
    await page.setViewportSize({ width: 375, height: 500 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok((await page.evaluate(() => window.scrollY)) > 0);
    await page.screenshot({ path: "/tmp/libras-navigation-phone.png", fullPage: true });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
      window.scrollTo(0, 0);
    });
    await menu.click();
    await page.screenshot({ path: "/tmp/libras-navigation-drawer.png" });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: "/tmp/libras-navigation-desktop.png" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("resizing retains the real audio transport and queue, with player clearance", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await page.addInitScript(() => {
    window.__audioInstances = [];
    window.Audio = new Proxy(window.Audio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args);
        window.__audioInstances.push(audio);
        return audio;
      },
    });
  });
  const artist = { id: "shell-artist", name: "Shell artist" };
  const album = { id: "shell-album", name: "Shell album", artists: [artist] };
  const song = {
    id: "shell-track",
    title: "Shell track",
    albumId: album.id,
    artists: [artist],
    duration: 60,
    contentType: "audio/wav",
  };
  // One minute of valid silent PCM, played through the actual browser transport.
  const audio = Buffer.alloc(44 + 8000 * 2 * 60);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  await page.route("https://shell.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    if (method === "stream") {
      await route.fulfill({ contentType: "audio/wav", body: audio });
      return;
    }
    let fields = {};
    if (method === "ping")
      fields = { version: "1.16.1", type: "test-server", serverVersion: "1", openSubsonic: true };
    else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
    else if (method === "search3")
      fields = {
        searchResult3: {
          artist: Number(url.searchParams.get("artistOffset")) === 0 ? [artist] : [],
          album: Number(url.searchParams.get("albumOffset")) === 0 ? [album] : [],
          song: Number(url.searchParams.get("songOffset")) === 0 ? [song] : [],
        },
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  try {
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("https://shell.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const tile = page.getByRole("link", { name: artist.name, exact: true });
    await tile.waitFor();
    await tile.hover();
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.locator("#artist-menu").getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__audioInstances.length === 1 &&
        !window.__audioInstances[0].paused &&
        window.__audioInstances[0].currentTime > 0,
    );
    const transport = await page.evaluateHandle(() => window.__audioInstances[0]);
    const before = await transport.evaluate((audio) => audio.currentTime);
    for (const width of [375, 768, 1280, 320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator(".mini-player").waitFor();
      assert.equal(
        await page
          .locator(".mini-player strong")
          .textContent()
          .then((text) => text.trim()),
        song.title,
      );
      assert.equal(
        await transport.evaluate((audio) => audio === window.__audioInstances[0] && !audio.paused),
        true,
      );
      assert.equal(await page.evaluate(() => window.__audioInstances.length), 1);
      const clearance = await page.evaluate(() => {
        const player = document.querySelector(".mini-player").getBoundingClientRect();
        const sidebar = document.querySelector(".app-sidebar").getBoundingClientRect();
        return (
          getComputedStyle(document.querySelector(".app-sidebar")).display === "none" ||
          sidebar.bottom <= player.top
        );
      });
      assert.equal(clearance, true);
    }
    assert.ok((await transport.evaluate((audio) => audio.currentTime)) >= before);
    await page.locator('.app-sidebar a[href="#/downloads"]').click();
    await page.locator(".downloads-view").waitFor();
    assert.equal(await transport.evaluate((audio) => !audio.paused), true);
    assert.equal(await page.locator(".app-player").evaluate((element) => getComputedStyle(element).position), "sticky");
    await page.screenshot({ path: "/tmp/libras-composition-playing.png" });
    await page.setViewportSize({ width: 1280, height: 200 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok(await page.evaluate(() => window.scrollY) > 0);
    await page.getByRole("button", { name: "Open player", exact: true }).click();
    await page.locator("#player-dialog").waitFor();
    assert.equal(await page.locator("#player-dialog").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    }), true);
    assert.equal(
      await page
        .locator(".player-queue h2")
        .textContent()
        .then((text) => text.trim()),
      "1 track",
    );
  } finally {
    await browser.close();
  }
});

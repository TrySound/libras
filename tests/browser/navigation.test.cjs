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
    await page.locator("[aria-labelledby=settings-heading]").waitFor();
    // Keep native page overscroll (including pull-to-refresh) enabled.
    // Headless Chromium can only verify the scroll owner's policy.
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.scrollingElement).overscrollBehavior),
      "auto",
    );
    await page.setViewportSize({ width: 1280, height: 1600 });
    const background = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const routeStyle = getComputedStyle(
        document.querySelector("[aria-labelledby=settings-heading]"),
      );
      return {
        fillsViewport:
          document.querySelector(".app-shell").getBoundingClientRect().bottom >= innerHeight,
        documentCanvas:
          !rootStyle.backgroundImage.includes("repeating-linear-gradient") &&
          rootStyle.backgroundImage.includes("radial-gradient"),
        layeredLines:
          document.querySelectorAll(".app-page .atmosphere-frame").length === 1 &&
          getComputedStyle(
            document.querySelector(".app-page .atmosphere-lines"),
          ).backgroundImage.includes("repeating-linear-gradient"),
        routeTransparent:
          routeStyle.backgroundImage === "none" &&
          routeStyle.backgroundColor === "rgba(0, 0, 0, 0)",
        color: rootStyle.backgroundColor,
      };
    });
    assert.deepEqual(background, {
      fillsViewport: true,
      documentCanvas: true,
      layeredLines: true,
      routeTransparent: true,
      color: "rgb(19, 0, 0)",
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const sidebar = page.locator(".app-sidebar");
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    await sidebar.waitFor({ state: "visible" });
    assert.equal(await menu.isVisible(), false);
    assert.equal(
      await page.locator(".app-header").evaluate((element) => getComputedStyle(element).display),
      "none",
    );
    assert.equal(
      await page.evaluate(() => {
        const shell = document.querySelector(".app-shell").getBoundingClientRect();
        const main = document.querySelector(".app-page").getBoundingClientRect();
        return main.top === shell.top;
      }),
      true,
      "the hidden desktop topbar reserves no space",
    );
    assert.equal(await sidebar.locator('[aria-current="page"]').getAttribute("href"), "#/settings");
    await sidebar.getByRole("link", { name: "Downloads", exact: true }).focus();
    await page.setViewportSize({ width: 768, height: 800 });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.scrollingElement).overscrollBehavior),
      "auto",
    );
    assert.equal(
      await sidebar.isVisible(),
      false,
      "the mobile breakpoint hides even a focused sidebar",
    );
    assert.equal(await menu.isVisible(), true);
    const brand = await page.getByRole("link", { name: "Libras home", exact: true }).boundingBox();
    const control = await menu.boundingBox();
    assert.ok(
      brand.y < control.y + control.height &&
        control.y < brand.y + brand.height &&
        control.x > page.viewportSize().width / 2,
      "brand and menu share a row, with controls on the right",
    );
    await menu.click();
    const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
    await drawer.waitFor({ state: "visible" });
    assert.equal(await sidebar.isVisible(), false);
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Open menu"]').getAttribute("aria-expanded") === "true",
    );
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
    await menu.click();
    await drawer.getByRole("link", { name: "Downloads", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
    await page.waitForURL("**/#/downloads");
    await menu.click();
    await page.evaluate(() => window.navigation.navigate("#/settings").finished);
    await page.locator("[aria-labelledby=settings-heading]").waitFor();
    assert.equal(await drawer.isVisible(), true, "route changes alone do not dismiss the drawer");
    assert.equal(
      await drawer
        .getByRole("link", { name: "Settings", exact: true })
        .getAttribute("aria-current"),
      "page",
    );
    await drawer.getByRole("link", { name: "Settings", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });
    await menu.click();
    await drawer.getByRole("link", { name: "Settings", exact: true }).focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await drawer.isVisible(), true, "resizing does not imperatively dismiss a modal");
    assert.equal(
      await drawer
        .getByRole("link", { name: "Settings", exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement.getClientRects().length > 0),
      true,
    );
    assert.equal(await menu.isVisible(), false);
    // Legacy deep links still resolve and select Library, not a second destination.
    await page.goto(`${base}#/library/artist/missing/album/missing`);
    await sidebar.waitFor();
    assert.equal(await sidebar.locator('[aria-current="page"]').getAttribute("href"), "#/library");
    await page.evaluate(() => window.navigation.navigate("#/settings").finished);
    await page.locator("[aria-labelledby=settings-heading]").waitFor();
    for (const width of [320, 375, 768, 800, 810, 811, 1280]) {
      await page.setViewportSize({ width, height: 700 });
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
    assert.ok(
      Math.abs(
        await page
          .locator(".app-header")
          .evaluate((element) => element.getBoundingClientRect().top),
      ) <= 1,
      "the mobile header remains at the viewport top while the document scrolls",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("navigation, resizing, and Now Playing retain real playback and the queue", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
    hasTouch: true,
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
    title: "Shell track with a long title that must leave space for intrinsic playback controls",
    albumId: album.id,
    artists: [artist],
    duration: 60,
    contentType: "audio/wav",
  };
  const nextSong = { ...song, id: "shell-track-2", title: "Track two" };
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
          song: Number(url.searchParams.get("songOffset")) === 0 ? [song, nextSong] : [],
        },
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  try {
    await page.goto(base);
    assert.equal(
      await page.getByRole("contentinfo", { name: "Music player", exact: true }).count(),
      0,
    );
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
    const mini = page.getByRole("contentinfo", { name: "Music player", exact: true });
    await mini.getByRole("button", { name: "Next track", exact: true }).click();
    await page.waitForFunction(
      (title) => document.querySelector(".mini-player strong")?.textContent === title,
      nextSong.title,
    );
    await mini.getByRole("button", { name: "Previous track", exact: true }).click();
    await page.waitForFunction(
      (title) => document.querySelector(".mini-player strong")?.textContent === title,
      song.title,
    );
    await page.waitForFunction(
      () => !window.__audioInstances[0].paused && window.__audioInstances[0].currentTime > 0,
    );
    await mini.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(() => window.__audioInstances[0].paused);
    assert.equal(await mini.isVisible(), true, "pausing retains the active player");
    const seek = mini.getByRole("slider", { name: "Playback position", exact: true });
    const pausedPosition = Number(await seek.inputValue());
    await seek.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      (position) => document.querySelector(".mini-player progress").value > position,
      pausedPosition,
    );
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".mini-player progress").value === 0);
    assert.match(await seek.getAttribute("aria-valuetext"), /of 1:00/);
    await mini.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => !window.__audioInstances[0].paused);
    const before = await transport.evaluate((audio) => audio.currentTime);
    for (const width of [375, 768, 800, 810, 811, 1280, 320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator(".mini-player").waitFor();
      assert.equal(
        await page
          .locator(".mini-player strong")
          .textContent()
          .then((text) => text.trim()),
        song.title,
      );
      assert.equal(await transport.evaluate((audio) => !audio.paused), true);
      assert.equal(await page.evaluate(() => window.__audioInstances.length), 1);
      const desktop = await page.locator(".app-root").evaluate((node) => node.clientWidth > 800);
      assert.equal(await seek.isVisible(), desktop);
      assert.equal(await mini.getByRole("progressbar").isVisible(), !desktop);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const expandBox = await mini
        .getByRole("button", { name: "Open Now Playing", exact: true })
        .boundingBox();
      const toggleBox = await mini
        .getByRole("button", { name: "Pause", exact: true })
        .boundingBox();
      assert.ok(
        toggleBox.x >= expandBox.x + expandBox.width &&
          toggleBox.y < expandBox.y + expandBox.height,
        "metadata and transports share a row without overlapping",
      );
    }
    // A narrow host on a desktop browser must use phone controls too.
    await page.locator(".app-root").evaluate((element) => (element.style.inlineSize = "400px"));
    assert.equal(await seek.isVisible(), false);
    assert.equal(
      await mini.getByRole("button", { name: "Next track", exact: true }).isVisible(),
      false,
    );
    assert.equal(await mini.getByRole("progressbar").isVisible(), true);
    await page.locator(".app-root").evaluate((element) => (element.style.inlineSize = ""));

    await mini.getByRole("button", { name: "Open Now Playing", exact: true }).click();
    await page.locator("#player-dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#player-dialog").waitFor({ state: "hidden" });
    assert.equal(
      await mini
        .getByRole("button", { name: "Open Now Playing", exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    assert.ok((await transport.evaluate((audio) => audio.currentTime)) >= before);
    const sidebar = await page.locator(".app-sidebar").boundingBox();
    const player = await page.locator(".mini-player").boundingBox();
    assert.ok(sidebar.y + sidebar.height <= player.y, "the player does not overlap navigation");
    await page.locator('.app-sidebar a[href="#/downloads"]').click();
    await page.locator("[aria-labelledby=downloads-heading]").waitFor();
    assert.equal(await transport.evaluate((audio) => !audio.paused), true);
    await page.setViewportSize({ width: 1280, height: 200 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok((await page.evaluate(() => window.scrollY)) > 0);
    await page.getByRole("button", { name: "Open Now Playing", exact: true }).click();
    await page.locator("#player-dialog").waitFor();
    assert.equal(
      await page.locator("#player-dialog").evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight;
      }),
      true,
    );
    const dialog = page.locator("#player-dialog");
    assert.equal(await dialog.locator(".track-row").count(), 2);
    for (const [width, height] of [
      [1280, 800],
      [393, 852],
      [900, 390],
    ]) {
      await page.setViewportSize({ width, height });
      const layout = await dialog.evaluate((node) => {
        const panel = node.querySelector(".viewport-panel").getBoundingClientRect();
        const queue = node.querySelector('[aria-label="Queue"]').getBoundingClientRect();
        return {
          overflow: node.scrollWidth > node.clientWidth,
          beside: queue.left >= panel.right,
          cover: getComputedStyle(node.querySelector(".viewport-panel-cover")).display !== "none",
        };
      });
      assert.equal(layout.overflow, false);
      assert.equal(layout.beside, width > 800);
      assert.equal(await dialog.locator(".dialog-handle").isVisible(), width <= 800);
      if (height < 400) assert.equal(layout.cover, false);
      const containment = await dialog.evaluate((node) => {
        const styles = getComputedStyle(node);
        const backdrop = getComputedStyle(node, "::backdrop");
        return {
          dialog: styles.overscrollBehaviorY,
          backdrop: backdrop.overscrollBehaviorY,
          backdropOverflow: backdrop.overflow,
        };
      });
      assert.deepEqual(containment, {
        dialog: "none",
        backdrop: "none",
        backdropOverflow: "hidden",
      });
      // Both scroll boundaries must contain wheel gestures, including when
      // the dialog is tall enough that its content needs no scrolling.
      for (const delta of [-600, 600]) {
        await dialog.evaluate((node, delta) => {
          node.scrollTop = delta < 0 ? 0 : node.scrollHeight;
        }, delta);
        const background = await page.evaluate(() => ({
          y: scrollY,
          width: document.documentElement.clientWidth,
        }));
        await page.mouse.move(width / 2, 30);
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(200);
        assert.deepEqual(
          await page.evaluate(() => ({ y: scrollY, width: document.documentElement.clientWidth })),
          background,
          "modal scroll boundaries preserve the underlying document position and width",
        );
      }
    }
    assert.equal(await transport.evaluate((audio) => !audio.paused), true);
    assert.equal(await page.evaluate(() => window.__audioInstances.length), 1);

    await page.setViewportSize({ width: 393, height: 852 });
    await dialog.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(() => window.__audioInstances[0].paused);
    const fullscreenSeek = dialog.getByRole("slider", { name: "Playback position", exact: true });
    await fullscreenSeek.focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".mini-player progress").value === 0);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        Number(document.querySelector("#player-dialog .seek").value) > 0 &&
        document.querySelector(".mini-player progress").value > 0,
    );
    await dialog.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => !window.__audioInstances[0].paused);

    await dialog.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.evaluate(() => {
      const header = document.querySelector("#player-dialog .topbar");
      const touch = (y) => new Touch({ identifier: 1, target: header, clientX: 80, clientY: y });
      header.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(30)] }));
      header.dispatchEvent(
        new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [touch(250)] }),
      );
      header.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          changedTouches: [touch(250)],
        }),
      );
    });
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await transport.evaluate((audio) => !audio.paused), true);
    await mini.getByRole("button", { name: "Open Now Playing", exact: true }).click();
    await dialog.getByRole("button", { name: "Clear", exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await mini.count(), 0);
    assert.equal(await transport.evaluate((audio) => audio.paused), true);
  } finally {
    await browser.close();
  }
});

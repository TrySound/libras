// Regression boundaries: real Cache/Session refreshes and native overlays, mocked transport only.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

test("disappeared Library/detail rows close without retargeting; dismissed Search updates preserve focus", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const owner = { id: "owner", name: "Fixture owner" };
  const removedArtist = { id: "removed-artist", name: "Removed artist" };
  const keepAlbum = { id: "keep", name: "Keep album", artists: [owner] };
  const removedAlbum = { id: "removed-album", name: "Removed album", artists: [owner] };
  const soloAlbum = { id: "solo", name: "Solo album", artists: [removedArtist] };
  const song = (id, title, album, artist = owner) => ({
    id,
    title,
    albumId: album.id,
    artists: [artist],
    duration: 120,
  });
  const keepSong = song("keep-song", "Keep song", keepAlbum);
  const removedSong = song("removed-song", "Removed song", keepAlbum);
  const original = {
    artists: [owner, removedArtist],
    albums: [keepAlbum, removedAlbum, soloAlbum],
    songs: [
      keepSong,
      removedSong,
      song("album-song", "Album song", removedAlbum),
      song("artist-song", "Artist song", soloAlbum, removedArtist),
    ],
  };
  let catalog = original;
  let starred = { song: [keepSong, { id: "ghost", title: "Ghost favourite" }] };
  let scanGate,
    releaseScan,
    scanWaiting = false;
  let favouriteGate,
    releaseFavourite,
    favouriteWaiting = false;
  const writes = [];
  let rejectWrites = false;
  let favouriteReads = 0;
  await page.route("https://lifecycle.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.split("/").pop().replace(".view", "");
    let fields = {};
    if (endpoint === "ping")
      fields = { version: "1.16.1", type: "mock", serverVersion: "1", openSubsonic: true };
    if (endpoint === "getIndexes") fields = { indexes: { lastModified: 1 } };
    if (endpoint === "getPlaylists") fields = { playlists: { playlist: [] } };
    if (endpoint === "getPlayQueue") fields = { playQueue: { entry: [] } };
    if (endpoint === "search3") {
      if (scanGate) {
        scanWaiting = true;
        await scanGate;
      }
      fields = {
        searchResult3: {
          artist: +url.searchParams.get("artistOffset") === 0 ? catalog.artists : [],
          album: +url.searchParams.get("albumOffset") === 0 ? catalog.albums : [],
          song: +url.searchParams.get("songOffset") === 0 ? catalog.songs : [],
        },
      };
    }
    if (endpoint === "getStarred2") {
      favouriteReads++;
      if (favouriteGate) {
        favouriteWaiting = true;
        await favouriteGate;
      }
      fields = { starred2: starred };
    }
    if (endpoint === "star" || endpoint === "unstar") {
      writes.push(endpoint);
      if (rejectWrites)
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            "subsonic-response": {
              status: "failed",
              error: { code: 50, message: "Fixture permission denied" },
            },
          }),
        });
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  async function waitUntil(ready) {
    for (let attempt = 0; attempt < 500 && !ready(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ready(), true, "mocked refresh reached its delayed endpoint");
  }
  async function navigate(path) {
    await page.evaluate((path) => window.navigation.navigate(`?${path}`).finished, path);
  }
  async function refresh() {
    await navigate("/settings");
    await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  }
  async function settled() {
    await page.waitForFunction(
      () => document.querySelector("#settings-refresh")?.getAttribute("aria-disabled") === "false",
    );
  }
  async function open(name, panel) {
    await page.getByRole("button", { name, exact: true }).filter({ visible: true }).click();
    await page.locator(panel).waitFor({ state: "visible" });
  }
  try {
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("https://lifecycle.example.test");
    await page.getByLabel("Username", { exact: true }).fill("fixture");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".tile").first().waitFor();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dismissed of [false, true]) {
        for (const scenario of [
          {
            path: "/library/artist/owner",
            name: "Actions for Removed album",
            panel: "#artist-detail-menu-popover",
            heading: "Fixture owner",
            next: {
              ...original,
              albums: [keepAlbum, soloAlbum],
              songs: original.songs.filter((song) => song.id !== "album-song"),
            },
          },
          {
            path: "/library/album/keep",
            name: "Actions for Removed song",
            panel: "#album-detail-menu-popover",
            heading: "Keep album",
            next: {
              ...original,
              songs: original.songs.filter((song) => song.id !== "removed-song"),
            },
          },
          {
            path: "/library",
            name: "Actions for Removed artist",
            panel: "#artist-popover",
            next: {
              artists: [owner],
              albums: [keepAlbum, removedAlbum],
              songs: original.songs.filter((song) => song.id !== "artist-song"),
            },
          },
        ]) {
          catalog = original;
          await refresh();
          await settled();
          scanWaiting = false;
          scanGate = new Promise((resolve) => {
            releaseScan = resolve;
          });
          await refresh();
          await waitUntil(() => scanWaiting);
          await navigate(scenario.path);
          const panel =
            "#" +
            (await page
              .getByRole("button", { name: scenario.name, exact: true })
              .filter({ visible: true })
              .getAttribute("commandfor"));
          await open(scenario.name, panel);
          // Observe the actual closing boundary, before any hidden own-actions reset.
          await page.locator(panel).evaluate((node) =>
            node.addEventListener(
              "beforetoggle",
              (event) => {
                if (event.newState === "closed")
                  window.closedRowTitle = node.querySelector("h2")?.textContent;
              },
              { once: true },
            ),
          );
          const safeFocus = page.locator('a[href="?/search"]').filter({ visible: true }).first();
          if (dismissed) {
            await page.keyboard.press("Escape");
            await safeFocus.focus();
          }
          catalog = scenario.next;
          releaseScan();
          scanGate = undefined;
          await page
            .getByRole("button", { name: scenario.name, exact: true })
            .filter({ visible: true })
            .waitFor({ state: "hidden" });
          await page.locator(panel).waitFor({ state: "hidden" });
          if (dismissed) {
            assert.equal(await safeFocus.evaluate((node) => node === document.activeElement), true);
          } else if (scenario.heading) {
            assert.notEqual(await page.evaluate(() => window.closedRowTitle), scenario.heading);
            await page.waitForFunction(
              (heading) =>
                document.activeElement?.matches("h1") &&
                document.activeElement.textContent === heading,
              scenario.heading,
            );
          } else {
            await page.waitForFunction(
              () => document.activeElement?.getAttribute("aria-labelledby") === "library-heading",
            );
          }
          assert.deepEqual(writes, []);
          // Dismissed/missing row selection cannot steal focus on a later cache replacement.
          await safeFocus.focus();
          assert.equal(await safeFocus.evaluate((node) => node === document.activeElement), true);
        }
      }
    }
    catalog = original;
    await refresh();
    await settled();
    // Refresh is started through Settings, then allowed to complete in the background.
    for (const pass of [0, 1]) {
      favouriteWaiting = false;
      favouriteGate = new Promise((resolve) => {
        releaseFavourite = resolve;
      });
      await refresh();
      await waitUntil(() => favouriteWaiting);
      await navigate("/search/:favourite");
      if (pass === 0) {
        await open("Open menu for Ghost favourite", "#search-menu-popover");
        await page.keyboard.press("Escape");
      }
      const safeFocus = page
        .getByRole("button", { name: "Open menu for Keep song", exact: true })
        .filter({ visible: true });
      await safeFocus.focus(); // No selection-changing click: the dismissed ghost remains the stale selection.
      starred = {
        song: pass === 0 ? [keepSong] : [keepSong, { id: "new", title: "New favourite" }],
      };
      releaseFavourite();
      favouriteGate = undefined;
      if (pass === 0)
        await page
          .locator("main .track-row")
          .filter({ hasText: "Ghost favourite" })
          .waitFor({ state: "hidden" });
      else await page.locator("main .track-row").filter({ hasText: "New favourite" }).waitFor();
      assert.equal(await safeFocus.evaluate((node) => node === document.activeElement), true);
    }
    // Download filtering retires browsing, not the authenticated favourites refresh.
    for (const offline of [false, true]) {
      await navigate("/settings");
      await settled();
      await page.getByRole("switch", { name: "Offline library" }).setChecked(offline);
      favouriteWaiting = false;
      favouriteGate = new Promise((resolve) => {
        releaseFavourite = resolve;
      });
      await refresh();
      await waitUntil(() => favouriteWaiting);
      await page.getByRole("switch", { name: "Offline library" }).setChecked(!offline);
      const busyRefresh = page.getByRole("button", { name: "Refreshing…", exact: true });
      assert.equal(await busyRefresh.isDisabled(), true);
      assert.equal(await busyRefresh.getAttribute("aria-busy"), "true");
      releaseFavourite();
      favouriteGate = undefined;
      await settled();
      const before = favouriteReads;
      await refresh();
      await settled();
      assert.equal(favouriteReads, before + 1);
    }
    // Each explicit owner forwards the same domain and owns Settings recovery.
    rejectWrites = true;
    async function recover(panel) {
      const overlay = page.locator(panel);
      await overlay.getByRole("button", { name: /^(Add to|Remove from) favourites$/ }).click();
      await overlay.getByText(/Fixture permission denied/).waitFor();
      const settings = overlay.getByRole("link", { name: "Open settings", exact: true });
      await settings.focus();
      assert.equal(await overlay.evaluate((node) => node.contains(document.activeElement)), true);
      await settings.click();
      await overlay.waitFor({ state: "hidden" });
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => !!document.activeElement?.closest(".bottom-sheet, [popover]")),
        false,
      );
    }
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, name] of [
        ["/library", "Actions for Fixture owner"],
        ["/library/artist/owner", "Actions for Fixture owner"],
        ["/library/artist/owner", "Actions for Keep album"],
        ["/library/album/keep", "Actions for Keep album"],
        ["/library/album/keep", "Actions for Keep song"],
        ["/search/:track", "Open menu for Keep song"],
      ]) {
        await navigate(path);
        const panel =
          "#" +
          (await page
            .getByRole("button", { name, exact: true })
            .filter({ visible: true })
            .getAttribute("commandfor"));
        await open(name, panel);
        await recover(panel);
      }
      await navigate("/search/:track");
      await page.getByRole("button", { name: /^(Play|Toggle playback for) Keep song$/ }).click();
      await page.getByRole("button", { name: "Open Now Playing", exact: true }).click();
      await open("Actions for Keep song", "#playing-actions");
      await recover("#playing-actions");
      await page.locator("#player-dialog").waitFor({ state: "hidden" });
    }
    assert.deepEqual(errors, []);
  } finally {
    releaseScan?.();
    releaseFavourite?.();
    await browser.close();
  }
});

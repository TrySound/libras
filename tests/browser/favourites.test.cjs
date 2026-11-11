// Genuine app state, native top-layer overlays and navigation; only server I/O is mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { mkdir } = require("node:fs/promises");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";
const evidence = process.env.SCREENSHOT_DIR;

test("favourites actions, confirmation, overlay lifetimes, unavailable results and history drafts", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const artist = { id: "same", name: "Fixture artist" };
  const album = { id: "same", name: "Fixture album", artists: [artist] };
  const songs = Array.from({ length: 14 }, (_, i) => ({
    id: i ? `song-${i}` : "same",
    title: `Fixture track ${String(i).padStart(2, "0")}`,
    artists: [artist],
    albumId: "same",
    duration: 120,
  }));
  const starred = {
    artist: [],
    album: [],
    song: [{ id: "missing", title: "Saved missing song", artist: "Saved credit" }],
  };
  const writes = [];
  const requests = [];
  let reject = false;
  let release;
  let gate;
  let readsFail = false;
  let readGate;
  let releaseRead;
  await page.route("https://favourites.example.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.split("/").pop().replace(".view", "");
    requests.push(endpoint);
    let fields = {};
    if (endpoint === "ping")
      fields = { version: "1.16.1", type: "mock", serverVersion: "1", openSubsonic: true };
    if (endpoint === "getIndexes") fields = { indexes: { lastModified: 1 } };
    if (endpoint === "getPlaylists") fields = { playlists: { playlist: [] } };
    if (endpoint === "getPlayQueue") fields = { playQueue: { entry: [] } };
    if (endpoint === "search3")
      fields = {
        searchResult3: {
          artist: +url.searchParams.get("artistOffset") === 0 ? [artist] : [],
          album: +url.searchParams.get("albumOffset") === 0 ? [album] : [],
          song: +url.searchParams.get("songOffset") === 0 ? songs : [],
        },
      };
    if (endpoint === "getStarred2") {
      if (readGate) await readGate;
      if (readsFail) return route.abort("failed");
      fields = { starred2: starred };
    }
    if (endpoint === "star" || endpoint === "unstar") {
      const params = new URLSearchParams(request.postData());
      const key = params.has("artistId") ? "artist" : params.has("albumId") ? "album" : "song";
      const id = params.get("artistId") ?? params.get("albumId") ?? params.get("id");
      writes.push([endpoint, key, id]);
      if (gate) await gate;
      if (reject)
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            "subsonic-response": {
              status: "failed",
              error: { code: 50, message: "Fixture permission denied" },
            },
          }),
        });
      starred[key] = starred[key].filter((item) => item.id !== id);
      if (endpoint === "star")
        starred[key].push(
          key === "artist"
            ? artist
            : key === "album"
              ? album
              : songs.find((item) => item.id === id),
        );
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  async function shot(name) {
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    }
  }
  async function navigate(path) {
    await page.evaluate((path) => window.navigation.navigate(`?${path}`).finished, path);
  }
  async function open(name, panel) {
    await page.getByRole("button", { name, exact: true }).filter({ visible: true }).click();
    const overlay = page.locator(panel);
    await overlay.waitFor({ state: "visible" });
    const labels = await overlay.locator(".stack-sm > button").allTextContents();
    assert.match(labels.at(-2), /Download/);
    assert.match(labels.at(-1), /favourites/);
    return overlay;
  }
  async function toggle(name, panel, expected) {
    const overlay = await open(name, panel);
    await overlay.getByRole("button", { name: /^(Add to|Remove from) favourites$/ }).click();
    await overlay.waitFor({ state: "hidden" });
    assert.deepEqual(writes.at(-1), expected);
    const invoker = page.getByRole("button", { name, exact: true }).filter({ visible: true });
    if (await invoker.count())
      assert.equal(await invoker.evaluate((node) => node === document.activeElement), true);
  }
  try {
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("https://favourites.example.test");
    await page.getByLabel("Username", { exact: true }).fill("fixture");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".tile").waitFor();
    await toggle("Actions for Fixture artist", "#artist-popover", ["star", "artist", "same"]);
    await navigate("/library/artist/same");
    await toggle("Actions for Fixture artist", "#artist-detail-menu-popover", [
      "unstar",
      "artist",
      "same",
    ]);
    await toggle("Actions for Fixture album", "#artist-detail-menu-popover", [
      "star",
      "album",
      "same",
    ]);
    await navigate("/library/album/same");
    await toggle("Actions for Fixture album", "#album-detail-menu-popover", [
      "unstar",
      "album",
      "same",
    ]);
    await toggle("Actions for Fixture track 00", "#album-detail-menu-popover", [
      "star",
      "song",
      "same",
    ]);
    await navigate("/search/:track");
    const input = page.getByRole("searchbox");
    await input.waitFor();
    assert.equal(await input.inputValue(), ":track");
    assert.equal(
      await page.getByRole("region", { name: "Tracks", exact: true }).locator(".track-row").count(),
      10,
    );
    await page.getByRole("button", { name: "Show more tracks" }).click();
    await input.fill(":track Fixture");
    await page.getByRole("button", { name: "Show more tracks" }).click();
    await navigate("/library/album/same");
    await page.goBack();
    await page.goForward();
    await page.getByRole("heading", { name: "Fixture album", exact: true }).first().waitFor();
    await page.goBack();
    assert.equal(await input.inputValue(), ":track Fixture");
    assert.equal(
      await page.getByRole("region", { name: "Tracks", exact: true }).locator(".track-row").count(),
      14,
    );
    await navigate("/library");
    await navigate("/search/:track");
    assert.equal(await input.inputValue(), ":track"); // Fresh native entry, not the edited older URL.
    const encoded = ":track :favourite / 100% 日本語";
    await navigate(`/search/${encodeURIComponent(encoded)}`);
    assert.equal(await input.inputValue(), encoded);
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), encoded);
    await input.fill(":favourite");
    const unavailable = page.locator(".track-row").filter({ hasText: "Saved missing song" });
    await unavailable.waitFor();
    assert.match(await unavailable.textContent(), /Unavailable in your library/);
    assert.equal(await unavailable.locator(".link-target").count(), 0);
    for (const width of [390, 800, 801, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const panel =
        "#" +
        (await page
          .getByRole("button", { name: "Open menu for Saved missing song", exact: true })
          .filter({ visible: true })
          .getAttribute("commandfor"));
      const overlay = await open("Open menu for Saved missing song", panel);
      assert.equal(
        await overlay.getByRole("button", { name: "Play", exact: true }).isDisabled(),
        true,
      );
      await shot(`favourites-unavailable-${width}`);
      await page.keyboard.press("Escape");
    }
    await toggle("Open menu for Saved missing song", "#search-menu-popover", [
      "unstar",
      "song",
      "missing",
    ]);
    await unavailable.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "library-search");
    await input.fill(":track");
    reject = true;
    let overlay = await open("Open menu for Fixture track 00", "#search-menu-popover");
    await overlay.getByRole("button", { name: "Remove from favourites", exact: true }).click();
    await overlay.getByText(/Fixture permission denied/).waitFor();
    await shot("favourites-error-1280");
    assert.equal(await overlay.isVisible(), true);
    reject = false;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await overlay.getByRole("button", { name: "Remove from favourites", exact: true }).click();
    await overlay.getByRole("button", { name: "Removing from favourites…", exact: true }).waitFor();
    assert.equal(await overlay.locator('button[aria-busy="true"]').isDisabled(), true);
    assert.equal(
      await overlay
        .locator('button[aria-busy="true"]')
        .evaluate((node) => getComputedStyle(node).opacity),
      "1",
    );
    await shot("favourites-pending-1280");
    await page.keyboard.press("Escape");
    overlay = await open("Open menu for Fixture track 01", "#search-menu-popover");
    release();
    gate = undefined;
    await page.waitForFunction(
      () => !document.querySelector('#search-menu-popover button[aria-busy="true"]'),
    );
    assert.equal(await overlay.isVisible(), true); // Old success must not dismiss a different opening.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Play Fixture track 00", exact: true }).click();
    await page.getByRole("button", { name: "Open Now Playing" }).click();
    overlay = await open("Actions for Fixture track 00", "#playing-actions");
    await shot("favourites-now-playing-1280");
    await overlay.getByRole("button", { name: "Add to favourites", exact: true }).click();
    await overlay.waitFor({ state: "hidden" });
    assert.deepEqual(writes.at(-1), ["star", "song", "same"]);
    assert.equal(
      await page
        .getByRole("button", { name: "Actions for Fixture track 00", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    reject = true;
    overlay = await open("Actions for Fixture track 00", "#playing-actions");
    await overlay.getByRole("button", { name: "Remove from favourites", exact: true }).click();
    await overlay.getByText(/Fixture permission denied/).waitFor();
    await overlay.getByRole("link", { name: "Open settings", exact: true }).click();
    await page.locator("#player-dialog").waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    reject = false;
    // Failed reads retain cached matches; Settings is the explicit recovery path.
    readsFail = true;
    await navigate("/settings");
    await page.getByRole("button", { name: "Refresh library", exact: true }).click();
    await page.getByRole("heading", { name: "Synchronization needs attention" }).waitFor();
    await navigate("/search/:favourite");
    await page.getByText(/Favourites need attention/).waitFor();
    await page.locator("main .track-row").filter({ hasText: "Fixture track 00" }).waitFor();
    await shot("favourites-cached-refresh-failure-1280");
    readsFail = false;
    await navigate("/settings");
    await page.getByRole("switch", { name: "Offline library" }).check();
    const scans = requests.filter((name) => name === "search3").length;
    const queues = requests.filter((name) => name === "getPlayQueue").length;
    await page.getByRole("button", { name: "Refresh library", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("#settings-refresh").getAttribute("aria-busy") === "false",
    );
    assert.equal(requests.filter((name) => name === "search3").length, scans);
    assert.equal(requests.filter((name) => name === "getPlayQueue").length, queues);
    await navigate("/library/album/same");
    await toggle("Actions for Fixture album", "#album-detail-menu-popover", [
      "star",
      "album",
      "same",
    ]);
    await navigate("/settings");
    await page.getByRole("switch", { name: "Offline library" }).uncheck();
    await navigate("/search/:favourite");
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    await input.fill(":favourite");
    await shot("favourites-reflow-320");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
    await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    await page.setViewportSize({ width: 390, height: 900 });
    await input.fill(":track");
    reject = true;
    overlay = await open("Open menu for Fixture track 01", "#search-menu");
    await overlay.getByRole("button", { name: "Add to favourites", exact: true }).click();
    await overlay.getByText(/Fixture permission denied/).waitFor();
    await shot("favourites-error-390");
    reject = false;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await overlay.getByRole("button", { name: "Add to favourites", exact: true }).click();
    await overlay.getByRole("button", { name: "Adding to favourites…", exact: true }).waitFor();
    assert.equal(await overlay.locator('button[aria-busy="true"]').isDisabled(), true);
    assert.equal(
      await overlay
        .locator('button[aria-busy="true"]')
        .evaluate((node) => getComputedStyle(node).opacity),
      "1",
    );
    await shot("favourites-pending-390");
    await page.keyboard.press("Escape");
    overlay = await open("Open menu for Fixture track 01", "#search-menu");
    release();
    gate = undefined;
    await overlay.getByRole("button", { name: "Remove from favourites", exact: true }).waitFor();
    assert.equal(await overlay.isVisible(), true); // Dismiss/reopen invalidates completion even for the same target.
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 900 });
    await navigate("/settings");
    readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await page.getByRole("button", { name: "Refresh library", exact: true }).click();
    await navigate("/search/:favourite");
    await page.getByText("Loading favourites…", { exact: true }).waitFor();
    await shot("favourites-loading-cached-1280");
    // Simulate a server-side update; the subsequent explicit refresh is authoritative.
    starred.artist = [];
    starred.album = [];
    starred.song = [];
    releaseRead();
    readGate = undefined;
    await page.getByRole("heading", { name: "No favourites yet." }).waitFor();
    await shot("favourites-confirmed-empty-1280");
    // A resize can hide the captured desktop invoker without dismissing its popover.
    // Success must then use this Search owner's input, not a global page selector.
    await input.fill(":track");
    overlay = await open("Open menu for Fixture track 02", "#search-menu-popover");
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await overlay.getByRole("button", { name: "Add to favourites", exact: true }).click();
    await overlay.getByRole("button", { name: "Adding to favourites…", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await overlay.isVisible(), true);
    release();
    gate = undefined;
    await overlay.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "library-search");
    await page.setViewportSize({ width: 1280, height: 900 });
    await navigate("/search");
    await input.fill("bare account draft");
    await navigate("/library");
    await navigate("/search");
    assert.equal(await input.inputValue(), "bare account draft");
    await navigate("/settings");
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await navigate("/library/album/same");
    overlay = await open("Actions for Fixture album", "#album-detail-menu-popover");
    assert.equal(
      await overlay.getByRole("button", { name: "Add to favourites", exact: true }).isDisabled(),
      true,
    );
    await overlay.getByText(/Reconnect in Settings/).waitFor();
    await shot("favourites-disconnected-1280");
    await overlay.getByRole("link", { name: "Open settings", exact: true }).click();
    await overlay.waitFor({ state: "hidden" });
    await page.getByLabel("Host", { exact: true }).fill("https://favourites.example.test");
    await page.getByLabel("Username", { exact: true }).fill("fixture-other");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".tile").waitFor();
    await navigate("/search");
    assert.equal(await input.inputValue(), ""); // Account replacement discards the old account's draft.
    assert.deepEqual(errors, []);
  } finally {
    release?.();
    releaseRead?.();
    await browser.close();
  }
});

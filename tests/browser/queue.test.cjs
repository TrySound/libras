// Explicit server exchange using the same intercepted Subsonic/real OPFS pattern as settings.test.cjs.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdir } = require("node:fs/promises");
const { chromium } = require("playwright");
const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;
const artifacts = process.env.ARTIFACT_DIR ?? "/tmp/libras-browser-artifacts/02";

test("local queue and native explicit exchange", async () => {
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const calls = [];
  const errors = [];
  let failLoad = false;
  let releaseLoad;
  let loadGate;
  const artist = { id: "artist", name: "Queue artist" };
  const album = { id: "album", name: "Queue album", artists: [artist] };
  const track = {
    id: "track",
    title: "Queue song",
    albumId: "album",
    artists: [artist],
    duration: 120,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://music.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    calls.push(method);
    let fields;
    if (method === "ping")
      fields = { openSubsonic: true, version: "1.16.1", type: "test-server", serverVersion: "1" };
    else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "search3") {
      const slice = (values, name) =>
        values.slice(
          Number(url.searchParams.get(`${name}Offset`) ?? 0),
          Number(url.searchParams.get(`${name}Offset`) ?? 0) +
            Number(url.searchParams.get(`${name}Count`) ?? 500),
        );
      fields = {
        searchResult3: {
          artist: slice([artist], "artist"),
          album: slice([album], "album"),
          song: slice([track], "song"),
        },
      };
    } else if (method === "getPlayQueue") {
      if (loadGate) await loadGate;
      fields = failLoad
        ? {
            status: "failed",
            error: { code: 0, message: "https://secret.example/?password=secret" },
          }
        : {
            playQueue: {
              entry: [track, { id: "missing" }, track],
              current: "track",
              position: 9000,
            },
          };
    } else if (method === "savePlayQueue") fields = {};
    else throw new Error(`Unexpected endpoint: ${method}`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  const player = page.locator("#player-dialog");
  const openQueue = async () => {
    if (page.viewportSize().width < 800)
      await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page
      .getByRole("button", { name: "Queue", exact: true })
      .filter({ visible: true })
      .click();
    await player.waitFor();
    assert.equal(await player.evaluate((el) => el.matches(":modal")), true);
  };
  const screenshot = async (width, state) => {
    await player.getByRole("heading", { name: "Up next" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${artifacts}/${width}-${state}.png` });
  };
  const confirmLoad = async () => {
    await player.getByRole("button", { name: "Load server queue", exact: true }).click();
    return page.getByRole("dialog", { name: "Replace this device’s queue?", exact: true });
  };
  try {
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("music.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("[aria-labelledby=library-heading] .tile").waitFor();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.locator("#settings-refresh").click();
    await page.waitForFunction(
      () => document.querySelector("#settings-refresh")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(
      calls.filter((m) => /PlayQueue/.test(m)).length,
      0,
      "no startup/refresh queue requests",
    );
    await page.reload();
    await page.locator("#settings-server-identity").waitFor();
    assert.equal(calls.filter((m) => /PlayQueue/.test(m)).length, 0, "no reload queue requests");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openQueue();
      await screenshot(width, "empty-queue");
      const emptySave = player.getByRole("button", { name: "Save queue to server" });
      await emptySave.click();
      const clearServer = page.getByRole("dialog", { name: "Clear the server queue?" });
      assert.equal(
        await clearServer
          .getByRole("button", { name: "Cancel" })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(await emptySave.evaluate((el) => el === document.activeElement), true);
      const confirmation = await confirmLoad();
      assert.equal(
        await confirmation
          .getByRole("button", { name: "Cancel" })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await confirmation
          .getByRole("button", { name: "Load server queue" })
          .evaluate((el) => el === document.activeElement && el.matches(":focus-visible")),
        true,
      );
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await confirmation
          .getByRole("button", { name: "Cancel" })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.screenshot({ path: `${artifacts}/${width}-replace-confirmation.png` });
      await confirmation.getByRole("button", { name: "Load server queue" }).click();
      await player.getByRole("status").filter({ hasText: "Server queue loaded" }).waitFor();
      assert.equal(await player.locator(".track-row").count(), 3);
      assert.equal(await player.getByText("Track unavailable", { exact: true }).count(), 1);
      assert.equal(await player.getByRole("button", { name: "Pause", exact: true }).count(), 0);
      await screenshot(width, "populated-queue");
      failLoad = true;
      await (await confirmLoad()).getByRole("button", { name: "Load server queue" }).click();
      await player.getByRole("status").filter({ hasText: "Could not load" }).waitFor();
      assert.equal(await player.locator(".track-row").count(), 3);
      assert.equal((await player.getByRole("status").textContent()).includes("secret"), false);
      await screenshot(width, "exchange-failure");
      failLoad = false;
      await player.getByRole("button", { name: "Clear queue", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Clear queue?", exact: true })
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await openQueue();
    assert.equal(
      await player.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
      "320px dialog reflow",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "320px document reflow",
    );
    await screenshot(320, "empty-queue");
    // Overlapping exchanges stay disabled. Unit tests cover edits/account changes mid-flight.
    loadGate = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    await (await confirmLoad()).getByRole("button", { name: "Load server queue" }).click();
    await player.getByRole("button", { name: "Loading…" }).waitFor();
    assert.equal(
      await player.getByRole("button", { name: "Save queue to server" }).isDisabled(),
      true,
    );
    releaseLoad();
    loadGate = undefined;
    await player.getByRole("status").filter({ hasText: "Server queue loaded" }).waitFor();
    await player.getByRole("button", { name: "Save queue to server" }).click();
    await player.getByRole("status").filter({ hasText: "Queue saved" }).waitFor();
    await player.getByRole("button", { name: "Clear queue", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Clear queue?", exact: true })
      .getByRole("button", { name: "Clear queue", exact: true })
      .click();
    await openQueue();
    await player.getByRole("button", { name: "Save queue to server" }).click();
    await page
      .getByRole("dialog", { name: "Clear the server queue?" })
      .getByRole("button", { name: "Clear server queue" })
      .click();
    await player.getByRole("status").filter({ hasText: "Queue saved" }).waitFor();
    assert.equal(calls.filter((m) => m === "savePlayQueue").length, 2);
    await player.getByRole("button", { name: "Close player" }).click();
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page
      .getByRole("link", { name: "Settings", exact: true })
      .filter({ visible: true })
      .click();
    const beforeOffline = calls.filter((m) => /PlayQueue/.test(m)).length;
    await page.locator("#settings-offline").check();
    await openQueue();
    assert.equal(
      await player.getByRole("button", { name: "Load server queue" }).isDisabled(),
      true,
    );
    await player.getByText("Connect to exchange server queues.", { exact: true }).waitFor();
    assert.equal(calls.filter((m) => /PlayQueue/.test(m)).length, beforeOffline);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        browser: browser.version(),
        calls,
        screenshots: artifacts,
        overflow320: "passed",
        nativeCancelEscapeFocus: "passed",
      }),
    );
  } finally {
    console.log(
      JSON.stringify({
        calls,
        errors,
        text: (await page.locator("body").innerText()).slice(-2500),
      }),
    );
    await page.screenshot({ path: `${artifacts}/last-state.png` });
    releaseLoad?.();
    await browser.close();
  }
});

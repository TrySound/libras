// Focused connection, Settings/account management, and the connected listening flow.
// Uses real App, Web Locks, OPFS, native dialogs and decodable cached audio.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdir } = require("node:fs/promises");
const { chromium } = require("playwright");
const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;
const artifacts = process.env.ARTIFACT_DIR;

function wav() {
  const data = Buffer.alloc(44 + 16000 * 30);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test("focused connection and remembered/offline listening management", async () => {
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.Audio = new Proxy(window.Audio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args);
        window.listeningAudio = audio;
        return audio;
      },
    });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releasePing;
  let pingGate;
  let failPing = false;
  let pings = 0;
  const artist = { id: "artist", name: "Listening fixture artist" };
  const album = { id: "album", name: "Listening fixture album", artists: [artist] };
  const song = {
    id: "song",
    title: "Listening fixture song",
    albumId: "album",
    artists: [artist],
    contentType: "audio/wav",
    duration: 2,
  };
  await page.route("https://music.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    if (["stream", "download"].includes(method)) {
      await route.fulfill({ contentType: "audio/wav", body: wav() });
      return;
    }
    let fields;
    if (method === "ping") {
      pings++;
      if (pingGate) await pingGate;
      fields = failPing
        ? { status: "failed", error: { code: 40, message: "Sign-in rejected" } }
        : { openSubsonic: true, version: "1.16.1", type: "fixture", serverVersion: "1" };
    } else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue")
      fields = {
        playQueue: { entry: [song, { id: "missing" }, song], current: "song", position: 0 },
      };
    else if (method === "search3") {
      const values = (name, rows) =>
        Number(url.searchParams.get(`${name}Offset`)) === 0 ? rows : [];
      fields = {
        searchResult3: {
          artist: values("artist", [artist]),
          album: values("album", [album]),
          song: values("song", [song]),
        },
      };
    } else throw new Error(`Unexpected fixture endpoint: ${method}`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  const navigate = async (path) => {
    await page.evaluate((path) => navigation.navigate(`?${path}`).finished, path);
  };
  const settled = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"));
  };
  const capture = async (state) => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await settled();
      if (state === "duplicate-queue") {
        await player
          .getByRole("heading", { name: "Up next" })
          .evaluate((node) => node.scrollIntoView({ block: "start" }));
        const geometry = await player.locator(".queue-row").evaluateAll((rows) =>
          rows.map((row) => {
            const metadata = row.querySelector(".queue-metadata").getBoundingClientRect();
            const action = row.querySelector(".queue-actions").getBoundingClientRect();
            const remove = row
              .querySelector('button[aria-label^="Remove"]')
              .getBoundingClientRect();
            return {
              unavailable:
                row.querySelector(".queue-metadata .label").textContent === "Track unavailable",
              textWidth: row.querySelector(".queue-metadata .label").getBoundingClientRect().width,
              metadataBottom: metadata.bottom,
              actionTop: action.top,
              targetWidth: remove.width,
              targetHeight: remove.height,
              fits: row.scrollWidth <= row.clientWidth,
            };
          }),
        );
        for (const row of geometry) {
          assert.equal(row.fits, true);
          assert.ok(row.targetWidth >= 44 && row.targetHeight >= 44);
          if (width <= 390) {
            assert.ok(
              row.textWidth >= (row.unavailable ? 120 : 140),
              `queue metadata width ${row.textWidth}`,
            );
            assert.ok(row.actionTop >= row.metadataBottom, "queue actions sit below metadata");
          }
        }
        console.log(JSON.stringify({ queueWidth: width, geometry }));
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${state} ${width}px overflow`,
      );
      if (artifacts) await page.screenshot({ path: `${artifacts}/${width}-${state}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const fill = async () => {
    await page.getByLabel("Host", { exact: true }).fill("music.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
  };
  const submit = () => page.locator("#connection-submit").click();
  const hasStoredAuth = () => page.evaluate(() => localStorage.getItem("navidrome-auth") !== null);
  const player = page.locator("#player-dialog");
  const openQueue = async () => {
    await page.locator(".app-sidebar").getByRole("button", { name: "Queue", exact: true }).click();
    await player.waitFor();
  };
  try {
    await page.goto(base);
    await page.locator("#connect-screen").waitFor();
    assert.equal(await page.getByLabel("Remember this device").isChecked(), false);
    await capture("connection-form");
    await submit();
    assert.equal(pings, 0);
    assert.equal(
      await page.locator("#server-host").evaluate((node) => node === document.activeElement),
      true,
    );
    await fill();
    failPing = true;
    await submit();
    await page.getByText("Sign-in rejected", { exact: true }).first().waitFor();
    assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
    assert.equal(await hasStoredAuth(), false);
    await capture("connection-error");
    failPing = false;

    // Leaving the focused screen while verification is pending must not redirect back.
    await fill();
    pingGate = new Promise((resolve) => {
      releasePing = resolve;
    });
    await submit();
    await page
      .locator("#connection-form")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    releasePing();
    pingGate = undefined;
    await page.waitForFunction(() => !document.querySelector("#connection-submit").disabled);
    assert.equal(await hasStoredAuth(), false);
    await fill();
    pingGate = new Promise((resolve) => {
      releasePing = resolve;
    });
    await page.getByLabel("Remember this device").check();
    await submit();
    assert.equal(await hasStoredAuth(), false);
    await navigate("/settings");
    releasePing();
    pingGate = undefined;
    await page.locator("#settings-server-identity").waitFor();
    assert.equal(new URL(page.url()).search, "?/settings");
    assert.equal(await hasStoredAuth(), true);
    assert.equal(await page.locator("#settings-server form").count(), 0);
    await page.reload();
    await page.locator("#settings-server-identity").waitFor();
    assert.equal(await hasStoredAuth(), true, "legacy/remembered auth is retained across startup");
    await navigate("/library&type=track&q=Listening");
    await page.getByRole("region", { name: "Tracks", exact: true }).waitFor();
    await capture("library-filters");
    await navigate("/search&type=track&q=Listening");
    assert.equal(await page.locator("#library-search").inputValue(), "Listening");
    await page.locator("#library-search").fill("fixture");
    await page.waitForURL((url) => url.search.startsWith("?/library&"));
    assert.equal(new URL(page.url()).searchParams.get("type"), "track");

    // Enqueue into an empty queue does not start audio or select a track.
    await page.locator('.only-desktop[aria-label="Open menu for Listening fixture song"]').click();
    await page
      .locator("#search-menu-popover")
      .getByRole("button", { name: "Add to queue", exact: true })
      .click();
    await openQueue();
    assert.equal(await player.getByText("Nothing playing", { exact: true }).isVisible(), true);
    const load = player.getByRole("button", { name: "Load server queue", exact: true });
    await load.click();
    await page
      .getByRole("dialog", { name: "Replace this device’s queue?" })
      .getByRole("button", { name: "Load server queue", exact: true })
      .click();
    await player.getByText("Server queue loaded. Playback is stopped.", { exact: true }).waitFor();
    await player.getByRole("heading", { name: "Up next" }).scrollIntoViewIfNeeded();
    await capture("duplicate-queue");
    await player
      .getByRole("button", { name: "Remove unavailable track, queue item 2", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "Remove Listening fixture song, queue item 2",
    );
    await player
      .getByRole("button", { name: "Remove Listening fixture song, queue item 1", exact: true })
      .click();
    await player.getByText("Track removed. Playback stopped.", { exact: true }).waitFor();
    assert.equal(await player.locator(".track-row").count(), 1);
    await player
      .getByRole("button", { name: "Remove Listening fixture song, queue item 1", exact: true })
      .click();
    await page.waitForFunction(() => document.activeElement?.textContent === "Up next");
    await page.keyboard.press("Escape");

    // Download real bytes, play cached audio, then remove it without editing membership.
    await page.locator('.only-desktop[aria-label="Open menu for Listening fixture song"]').click();
    await page
      .locator("#search-menu-popover")
      .getByRole("button", { name: "Download", exact: true })
      .click();
    await navigate("/downloads");
    await page.locator('[aria-label="Downloaded"]').waitFor();
    // Native desktop dialog and mobile sheet dismissals must not act like confirmation,
    // even with the destructive local-data switch checked.
    const savedFiles = () =>
      page.evaluate(async () => {
        const accounts = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("accounts");
        const files = [];
        for await (const [account, directory] of accounts) {
          for await (const [name, handle] of directory) {
            if (name === "downloads.json")
              files.push(`${account}/${name}:${(await handle.getFile()).size}`);
            if (name === "files" && handle.kind === "directory") {
              for await (const [fileName, fileHandle] of handle)
                files.push(`${account}/files/${fileName}:${(await fileHandle.getFile()).size}`);
            }
          }
        }
        return files.sort();
      });
    const beforeDismissal = await savedFiles();
    assert.ok(beforeDismissal.some((file) => file.includes("/files/")));
    await navigate("/settings");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const id = width === 1440 ? "disconnect-dialog" : "disconnect-sheet";
      const invoker = page.locator(
        width === 1440 ? "#settings-disconnect" : "#settings-disconnect-mobile",
      );
      const dialog = page.locator(`#${id}`);
      for (const dismissal of ["Cancel", "Escape"]) {
        await invoker.click();
        assert.equal(await invoker.getAttribute("commandfor"), id);
        assert.equal(await dialog.evaluate((node) => node.matches(":modal")), true);
        assert.equal(await dialog.locator("form").getAttribute("method"), "dialog");
        const clear = dialog.getByRole("switch", { name: "Clear data on device", exact: true });
        assert.equal(await clear.isChecked(), false, "reopening resets the destructive option");
        await clear.check();
        if (width === 390) {
          const box = await dialog.boundingBox();
          assert.equal(Math.round(box.y + box.height), 844);
          assert.equal(box.x, 0);
        }
        if (dismissal === "Cancel")
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        else await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(await invoker.evaluate((node) => node === document.activeElement), true);
        assert.equal(await hasStoredAuth(), true);
        assert.equal(
          await page.locator("#settings-server-identity").textContent(),
          "listener@music.example.test",
        );
        assert.deepEqual(await savedFiles(), beforeDismissal);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigate("/downloads");
    assert.equal(await page.locator('[aria-label="Downloaded"]').count(), 1);
    await capture("downloads");
    await page.getByRole("button", { name: "Remove all downloaded music", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Remove all downloaded music?" });
    assert.equal(
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await capture("download-confirmation");
    await page.keyboard.press("Escape");
    await navigate("/library&type=track&q=Listening");
    await page
      .getByRole("button", { name: "Play now Listening fixture song", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.listeningAudio &&
        !window.listeningAudio.paused &&
        window.listeningAudio.currentSrc.startsWith("blob:"),
    );
    await navigate("/downloads");
    await page.getByRole("button", { name: /^Remove Listening fixture song/ }).click();
    await page.getByText("Downloaded music removed. Queue unchanged.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () => window.listeningAudio.paused && window.listeningAudio.getAttribute("src") === null,
      ),
      true,
    );
    await openQueue();
    assert.equal(await player.locator(".track-row").count(), 1);
    assert.equal(await player.getByRole("button", { name: "Pause", exact: true }).count(), 0);
    await page.keyboard.press("Escape");

    // Explicit disconnect removes credentials but retains identity and local library.
    await navigate("/settings");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#settings-disconnect-mobile").click();
    assert.equal(await page.locator("#disconnect-sheet").getByRole("switch").isChecked(), false);
    await page
      .locator("#disconnect-sheet")
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    assert.equal(await hasStoredAuth(), false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigate("/connect");
    assert.equal(await page.getByLabel("Remember this device").isChecked(), false);
    await fill();
    await submit();
    await page.locator("#library-heading").waitFor();
    assert.equal(await hasStoredAuth(), false);
    const beforeReload = pings;
    await page.reload();
    await page.locator("#library-heading").waitFor();
    assert.equal(pings, beforeReload, "memory-only reload does not authenticate");
    assert.equal(await page.locator(".tile").count(), 1);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        browser: browser.version(),
        overflow: [320, 390, 1440],
        nativeValidationCancelFocus: "passed",
        nativeDisconnectDismissals: 4,
        mobileDisconnectConfirmed: true,
        rememberedAndMemoryOnly: "passed",
        downloadedAudioBytes: wav().length,
        screenshots: artifacts,
      }),
    );
  } finally {
    if (releasePing) releasePing();
    await browser.close();
  }
});

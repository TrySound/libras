// Real app/engines/OPFS, with only the Subsonic transport intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;
const artist = { id: "artist", name: "Download test artist" };
const album = { id: "album", name: "Download test album", artists: [artist] };
const tracks = Array.from({ length: 6 }, (_, i) => ({
  id: `track-${i + 1}`,
  title: `${i + 1} ${"A long music title ".repeat(5)}`.trim(),
  albumId: album.id,
  album: album.name,
  artists: [artist],
  contentType: "audio/mpeg",
  ...(i === 0 ? { coverArt: "cover" } : {}),
}));

const otherArtist = { id: "other-artist", name: "Other account artist" };
const otherAlbum = { id: "other-album", name: "Other account album", artists: [otherArtist] };
const otherTracks = [
  {
    ...tracks[0],
    id: "other-track",
    title: "Other account track",
    albumId: otherAlbum.id,
    album: otherAlbum.name,
    artists: [otherArtist],
  },
];

test("Downloads redesign preserves real transfer states and offline files", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.testAudio = this;
      return play.apply(this, args);
    };
  });
  let release;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let streams = 0;
  let requests = 0;
  const evidence = async (name) => {
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
      [320, 844],
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${name}: ${width}px overflow`,
      );
      if (process.env.ARTIFACT_DIR && width !== 320) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.ARTIFACT_DIR, `${name}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  let retrySucceeds = false;
  let libraryGate = Promise.resolve();
  let releaseLibrary = () => {};
  // Decodable saved audio lets cleanup exercise real cached playback, not only file records.
  const audio = Buffer.alloc(44 + 8000 * 2 * 60);
  audio.write("RIFF", 0);
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
  const errors = [];
  const unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://music.example.test/rest/**", async (route) => {
    requests++;
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    if (method === "stream") {
      streams++;
      await gate;
      await route.fulfill({
        status: !retrySucceeds && url.searchParams.get("id") === "track-6" ? 500 : 200,
        contentType: "audio/mpeg",
        body: audio,
      });
      return;
    }
    if (method === "getCoverArt") {
      await route.fulfill({
        contentType: "image/svg+xml",
        headers: { "cache-control": "public, max-age=3600" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#186ba6"/></svg>',
      });
      return;
    }
    let fields = {};
    if (method === "ping")
      fields = { version: "1.16.1", type: "test-server", serverVersion: "1", openSubsonic: true };
    else if (method === "getIndexes") fields = { indexes: { lastModified: 2 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
    else if (method === "savePlayQueue") fields = {};
    else if (method === "search3") {
      await libraryGate;
      const other = url.searchParams.get("u") === "other";
      const slice = (values, name) => {
        const offset = Number(url.searchParams.get(`${name}Offset`) ?? 0);
        return values.slice(offset, offset + Number(url.searchParams.get(`${name}Count`) ?? 500));
      };
      fields = {
        searchResult3: {
          artist: slice([other ? otherArtist : artist], "artist"),
          album: slice([other ? otherAlbum : album], "album"),
          song: slice(other ? otherTracks : tracks, "song"),
        },
      };
    } else unexpected.push(method);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  const navigate = (path) => page.goto(new URL(`?${path}`, base).href);
  const connect = async (username = "listener") => {
    await page.evaluate(() => navigation.navigate("?/connect").finished);
    await page.getByLabel("Host", { exact: true }).fill("https://music.example.test");
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByLabel("Remember this device", { exact: true }).check();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("radio", { name: "All music", exact: true }).check();
    await page
      .getByRole("link", {
        name: username === "other" ? otherArtist.name : artist.name,
        exact: true,
      })
      .waitFor();
  };
  const cleanup = async () => {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("dialog").getByRole("switch").check();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.locator("#settings-connect").waitFor();
    await page.evaluate(() => navigation.navigate("?/connect").finished);
    await page.locator("#server-host").waitFor();
  };
  const artistAction = async (action, name = artist.name) => {
    const artistTile = page.getByRole("link", { name, exact: true });
    await artistTile.hover();
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.locator("#search-menu").getByRole("button", { name: action, exact: true }).click();
  };
  const playCached = async (name = artist.name) => {
    await artistAction("Play now", name);
    await page.waitForFunction(() => {
      const audio = window.testAudio;
      return audio && !audio.paused && audio.currentSrc.startsWith("blob:");
    });
    await page.waitForFunction(() => document.querySelector('img[src^="blob:"]'));
  };
  try {
    await page.goto(base);
    await page.locator("#server-host").waitFor();
    await page.locator('.app-sidebar a[href="?/downloads"]').click();
    await t.test("empty route uses the shared app shell", async () => {
      assert.equal(
        await page.locator("[aria-labelledby=downloads-heading] h1").textContent(),
        "Downloads",
      );
      assert.equal(await page.getByRole("heading", { name: "No downloads yet" }).isVisible(), true);
      assert.equal(
        await page.locator('[aria-labelledby=downloads-heading] a[href="?/library"]').isVisible(),
        true,
      );
      assert.equal(await page.locator(".app-sidebar").isVisible(), true);
      assert.equal(
        await page.getByRole("button", { name: "Retry all", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Cancel downloads", exact: true }).isDisabled(),
        true,
      );
    });

    await navigate("/settings");
    await connect();
    // Use the existing long-press interaction, rather than invoking a domain method.
    await artistAction("Download");
    await page.locator('.app-sidebar a[href="?/downloads"]').click();

    await t.test(
      "real active and queued jobs render readonly rows with accessible status",
      async () => {
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[aria-labelledby=downloads-heading] [role="listitem"]')
              .length === 6 &&
            document.querySelectorAll(
              '[aria-labelledby=downloads-heading] [aria-label="Downloading"]',
            ).length === 3,
        );
        const rows = page.locator('[aria-labelledby=downloads-heading] [role="listitem"]');
        assert.equal(await rows.locator('[role="img"][aria-label="Downloading"]').count(), 3);
        assert.equal(
          await rows.locator('[role="img"][aria-label="Queued for download"]').count(),
          3,
        );
        assert.equal(await rows.locator("button, a, [tabindex]").count(), 0);
        assert.equal(
          await page.locator('.app-sidebar a[href="?/downloads"]').getAttribute("aria-label"),
          "Downloads, 6 active and queued files",
        );
        await page.setViewportSize({ width: 375, height: 900 });
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        assert.equal(
          await page
            .locator('dialog[aria-label="Navigation"] a[href="?/downloads"]')
            .getAttribute("aria-label"),
          "Downloads, 6 active and queued files",
        );
        await page.getByRole("button", { name: "Close menu", exact: true }).click();
        await page.setViewportSize({ width: 1280, height: 900 });
        assert.equal(await rows.locator("time").count(), 0);
        assert.equal(await rows.first().locator(".loader-bar").count(), 5);
        assert.equal(
          await rows.first().evaluate((element) => getComputedStyle(element).borderTopWidth),
          "2px",
        );
        const before = await rows
          .first()
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        await rows.first().hover();
        assert.equal(
          await rows.first().evaluate((element) => getComputedStyle(element).backgroundColor),
          before,
        );
        await page.waitForFunction(() =>
          document.querySelector("[aria-labelledby=downloads-heading] .artwork img:not([hidden])"),
        );
        assert.equal(await rows.nth(1).locator(".artwork-placeholder").isVisible(), true);
        for (const width of [320, 375, 768, 800, 810, 811, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          const desktop = await page
            .locator(".app-root")
            .evaluate((node) => node.clientWidth > 800);
          assert.equal(await rows.first().locator(".artwork").isVisible(), desktop);
          assert.ok(
            await page
              .locator("[aria-labelledby=downloads-heading]")
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          );
        }
        await page.setViewportSize({ width: 375, height: 900 });
        await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
        assert.ok(
          await page
            .locator("[aria-labelledby=downloads-heading]")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        );
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
      },
    );

    await t.test(
      "Work offline makes zero server requests and reconnect resumes queued jobs",
      async () => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page
          .locator(".app-sidebar")
          .getByRole("button", { name: "Work offline", exact: true })
          .click();
        await page.getByText("Paused while working offline", { exact: true }).waitFor();
        await page.waitForFunction(
          () => document.querySelectorAll('[aria-label="Downloading"]').length === 0,
        );
        const before = requests;
        await evidence("offline-paused-downloads");
        await navigate("/library#library-search");
        await page.locator('input[type="search"]').fill("long music");
        await page.locator(".track-row").first().waitFor();
        assert.equal(await page.getByText("Unavailable offline", { exact: true }).count(), 3);
        assert.equal(await page.locator(".track-row button.link-target:disabled").count(), 3);
        await evidence("offline-all-unavailable");
        await page.locator('.app-sidebar a[href="?/downloads"]').click();
        assert.equal(requests, before, "Work offline must not access any server domain");
        streams = 0; // Count the resumed attempt separately from the aborted transfers.
        await page
          .locator(".app-sidebar")
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await page.waitForFunction(
          () => document.querySelectorAll('[aria-label="Downloading"]').length === 3,
        );
        assert.equal(streams, 3);
      },
    );

    await t.test(
      "Cancel downloads retires real active and queued intent across reload",
      async () => {
        await page.getByRole("button", { name: "Cancel downloads", exact: true }).click();
        await page.getByRole("heading", { name: "No downloads yet", exact: true }).waitFor();
        assert.equal(streams, 3);
        release();
        await page.reload();
        await page.getByRole("heading", { name: "No downloads yet", exact: true }).waitFor();
        assert.equal(streams, 3, "canceled queued files must not resume on reopen");
        assert.equal(
          await page.getByRole("button", { name: "Cancel downloads", exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await page.getByRole("button", { name: "Retry all", exact: true }).isDisabled(),
          true,
        );
        // Start a new explicit batch; subsequent counts exclude the three canceled requests.
        streams = 0;
        gate = new Promise((resolve) => {
          release = resolve;
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await navigate(`/library/artist/${artist.id}`);
        await page.getByRole("button", { name: `Actions for ${artist.name}`, exact: true }).click();
        await page
          .locator("#artist-detail-menu-popover")
          .getByRole("button", { name: "Download", exact: true })
          .click();
        await page.locator('.app-sidebar a[href="?/downloads"]').click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              '[aria-labelledby=downloads-heading] [aria-label="Downloading"]',
            ).length === 3,
        );
      },
    );

    release();
    await t.test(
      "completion and failure update the real cache without discarding saved rows",
      async () => {
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              '[aria-labelledby=downloads-heading] [aria-label="Downloaded"]',
            ).length === 5,
        );
        await page.getByRole("button", { name: /^Retry download of 6/ }).waitFor();
        assert.equal(
          await page.locator('[aria-labelledby=downloads-heading] [role="listitem"]').count(),
          6,
        );
        assert.equal(await page.locator("[aria-labelledby=downloads-heading] time").count(), 5);
        assert.match(
          await page
            .locator('[aria-labelledby=downloads-heading] [role="listitem"]:has(time)')
            .first()
            .textContent(),
          /MP3|audio\/mpeg/,
        );
        assert.equal(streams, 6);
        assert.equal(
          await page.getByRole("button", { name: "Show errors", exact: true }).count(),
          0,
        );
        assert.equal(
          await page.locator('.app-sidebar a[href="?/downloads"]').getAttribute("aria-label"),
          "Downloads",
        );
        // Wait for a real checkpoint, not an assumed persistence timeout.
        const deadline = Date.now() + 10_000;
        let checkpointed = false;
        while (!checkpointed && Date.now() < deadline) {
          checkpointed = await page.evaluate(async () => {
            try {
              const root = await navigator.storage.getDirectory();
              const accounts = await root.getDirectoryHandle("accounts");
              for await (const [, directory] of accounts.entries()) {
                const file = await (await directory.getFileHandle("downloads.json")).getFile();
                if (
                  JSON.parse(await file.text()).records.filter(
                    (entry) => entry.status === "completed",
                  ).length === 5
                )
                  return true;
              }
            } catch {}
            return false;
          });
          if (!checkpointed) await page.waitForTimeout(50);
        }
        assert.equal(checkpointed, true, "downloads must be checkpointed before reload");
      },
    );

    await t.test("online reopen leaves failures for explicit row Retry and Retry all", async () => {
      await page
        .locator(".app-sidebar")
        .getByRole("link", { name: "Your library", exact: true })
        .click();
      await page.getByRole("radio", { name: "Downloaded", exact: true }).check();
      await evidence("connected-downloaded");
      assert.equal(
        await page
          .locator(".app-sidebar")
          .getByRole("button", { name: "Work offline", exact: true })
          .isVisible(),
        true,
      );
      await page.locator('.app-sidebar a[href="?/downloads"]').click();
      await page.reload();
      await page.getByRole("button", { name: /^Retry download of 6/ }).waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll("[aria-labelledby=downloads-heading] time").length === 5,
      );
      assert.equal(streams, 6);
      assert.equal(await page.getByRole("button", { name: "Show errors", exact: true }).count(), 0);
      const retried = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          /\/stream(?:\.view)?$/.test(url.pathname) && url.searchParams.get("id") === "track-6"
        );
      });
      await page.getByRole("button", { name: /^Retry download of 6/ }).click();
      await retried;
      await page.getByRole("button", { name: /^Retry download of 6/ }).waitFor();
      await page.waitForFunction(() =>
        document.querySelector(
          '[aria-labelledby=downloads-heading] [aria-label="Download failed"]',
        ),
      );
      assert.equal(streams, 7);
      retrySucceeds = true;
      await page.getByRole("button", { name: "Retry all", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("[aria-labelledby=downloads-heading] time").length === 6,
      );
      assert.equal(streams, 8);
      assert.equal(await page.getByRole("button", { name: /^Retry download of 6/ }).count(), 0);
    });

    await t.test("unchecked disconnect retains cached playback and offline downloads", async () => {
      await navigate("/library");
      await playCached();
      const source = await page.evaluate(() => window.testAudio.currentSrc);
      const queue = await page.locator("#player-dialog .track-row .label").allTextContents();
      const selected = await page
        .locator('#player-dialog .track-row[aria-current="true"] .label')
        .textContent();
      await page.getByRole("radio", { name: "All music", exact: true }).check();
      await page.getByRole("radio", { name: "Downloaded", exact: true }).check();
      assert.deepEqual(
        await page.locator("#player-dialog .track-row .label").allTextContents(),
        queue,
      );
      assert.equal(
        await page.locator('#player-dialog .track-row[aria-current="true"] .label').textContent(),
        selected,
      );
      assert.equal(
        await page.evaluate(() => !window.testAudio.paused && window.testAudio.currentSrc),
        source,
      );
      await page
        .locator(".app-sidebar")
        .getByRole("button", { name: "Work offline", exact: true })
        .click();
      assert.equal(
        await page.evaluate(() => !window.testAudio.paused && window.testAudio.currentSrc),
        source,
      );
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      assert.equal(
        await page.evaluate(
          () => !window.testAudio.paused && window.testAudio.currentSrc.startsWith("blob:"),
        ),
        true,
      );
      await navigate("/downloads");
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[aria-labelledby=downloads-heading] [aria-label="Downloaded"]')
            .length === 6,
      );
      assert.equal(await page.locator("[aria-labelledby=downloads-heading] time").count(), 6);
      assert.equal(await page.getByRole("heading", { name: "No downloads yet" }).count(), 0);
      assert.equal(streams, 8);
      assert.equal(await page.getByRole("button", { name: /^Retry download of 6/ }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Show errors", exact: true }).count(), 0);
    });
    await t.test(
      "cleanup deletes completed audio and aborts late transfers without recreating OPFS",
      async () => {
        const directories = () =>
          page.evaluate(async () => {
            const accounts = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle("accounts");
            return Array.fromAsync(accounts.keys());
          });
        await navigate("/settings");
        await connect();
        await cleanup();
        assert.deepEqual(await directories(), []);
        gate = new Promise((resolve) => {
          release = resolve;
        });
        await connect();
        await artistAction("Download");
        await page.waitForFunction(() =>
          document
            .querySelector('.app-sidebar a[href="?/downloads"]')
            ?.getAttribute("aria-label")
            ?.includes("6 active"),
        );
        await cleanup();
        release();
        await page.waitForTimeout(700);
        assert.deepEqual(await directories(), []);
        await page.locator("#server-host").waitFor();
        await page.locator('.app-sidebar a[href="?/downloads"]').click();
        await page.getByRole("heading", { name: "No downloads yet" }).waitFor();
        assert.deepEqual(await directories(), []);
      },
    );
    for (const username of ["listener", "other"]) {
      await t.test(
        `clear then ${username === "listener" ? "same" : "different"} account completes fresh downloads and cached playback`,
        async () => {
          await page.getByRole("link", { name: "Settings", exact: true }).click();
          await connect(username);
          const ownArtist = username === "listener" ? artist : otherArtist;
          const ownTracks = username === "listener" ? tracks : otherTracks;
          assert.equal(
            await page
              .getByRole("link", {
                name: username === "listener" ? otherArtist.name : artist.name,
                exact: true,
              })
              .count(),
            0,
          );
          assert.equal(
            await page.getByRole("button", { name: "Open Now Playing", exact: true }).count(),
            0,
          );
          const queue = await page.evaluate(async () => {
            const account = JSON.parse(localStorage.getItem("navidrome-account"));
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify([account.host, account.username])),
            );
            const key = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            const accounts = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle("accounts");
            const directory = await accounts.getDirectoryHandle(key);
            try {
              return JSON.parse(
                await (await (await directory.getFileHandle("queue.json")).getFile()).text(),
              );
            } catch (error) {
              if (error.name !== "NotFoundError") throw error;
              return { tracks: [], index: -1, position: 0 };
            }
          });
          assert.deepEqual(queue, { tracks: [], index: -1, position: 0 });
          await page.locator('.app-sidebar a[href="?/downloads"]').click();
          await page.getByRole("heading", { name: "No downloads yet" }).waitFor();
          await page.getByRole("link", { name: "Libras home", exact: true }).click();
          const before = streams;
          await artistAction("Download", ownArtist.name);
          await page.locator('.app-sidebar a[href="?/downloads"]').click();
          await page.waitForFunction(
            (count) => document.querySelectorAll('[aria-label="Downloaded"]').length === count,
            ownTracks.length,
          );
          assert.equal(streams, before + ownTracks.length);
          assert.ok(
            (await page.locator('[aria-labelledby="downloads-heading"]').textContent()).includes(
              ownTracks[0].title,
            ),
          );
          await page.getByRole("link", { name: "Libras home", exact: true }).click();
          await playCached(ownArtist.name);
          assert.equal(
            streams,
            before + ownTracks.length,
            "playback uses the newly completed local files",
          );
          await cleanup();
        },
      );
    }
    await t.test(
      "empty-catalog account selection restores queued intent despite delayed library hydration",
      async () => {
        // Seed the documented OPFS documents directly so this suite also runs against production preview.
        await page.evaluate(
          async ({ track, artist, album }) => {
            const identity = JSON.stringify(["https://music.example.test", "listener"]);
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(identity),
            );
            const key = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            const root = await navigator.storage.getDirectory();
            const accounts = await root.getDirectoryHandle("accounts", { create: true });
            const directory = await accounts.getDirectoryHandle(key, { create: true });
            for (const [name, value] of Object.entries({
              library: { savedAt: 1, lastModified: 1, artists: [], albums: [], tracks: [] },
              images: [],
              downloads: {
                version: 2,
                records: [
                  {
                    track: {
                      id: track.id,
                      title: track.title,
                      artist: artist.name,
                      album: album.name,
                      contentType: track.contentType,
                    },
                    format: "raw",
                    contentType: track.contentType,
                    status: "queued",
                  },
                ],
              },
            })) {
              const writer = await (
                await directory.getFileHandle(`${name}.json`, { create: true })
              ).createWritable();
              await writer.write(JSON.stringify(value));
              await writer.close();
            }
          },
          { track: tracks[0], artist, album },
        );
        libraryGate = new Promise((resolve) => {
          releaseLibrary = resolve;
        });
        const requested = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            /\/search3(?:\.view)?$/.test(url.pathname) && url.searchParams.get("u") === "listener"
          );
        });
        const before = streams;
        const connecting = connect();
        await requested;
        await page.waitForTimeout(100);
        releaseLibrary();
        await connecting;
        await page.locator('.app-sidebar a[href="?/downloads"]').click();
        await page.locator('[aria-label="Downloaded"]').waitFor();
        assert.equal(await page.locator('[aria-label="Downloaded"]').count(), 1);
        assert.equal(streams, before + 1);
        assert.ok(
          (await page.locator('[aria-labelledby="downloads-heading"]').textContent()).includes(
            tracks[0].title,
          ),
        );
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally {
    release();
    releaseLibrary();
    await browser.close();
  }
});

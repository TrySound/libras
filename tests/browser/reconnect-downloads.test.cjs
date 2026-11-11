// Real App/engines/OPFS. Run against Vite dev: seeding imports the owning cache module.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5176";
const host = "https://reconnect.example.test";

function library(username) {
  const artist = { id: `${username}-artist`, name: `${username} artist` };
  const album = { id: `${username}-album`, name: `${username} album`, artists: [artist] };
  const track = {
    id: `${username}-track`,
    title: `${username} track`,
    albumId: album.id,
    album: album.name,
    artists: [artist],
    contentType: "audio/wav",
  };
  return { artist, album, track };
}

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

test("real App reconnects after clear and restores queued intent", async (t) => {
  const browser = await chromium.launch({ headless: true });
  async function setup() {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        window.testAudio = this;
        return play.apply(this, args);
      };
    });
    const errors = [];
    const streams = [];
    let release;
    let delayedUser;
    let requested;
    let gate;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${host}/rest/**`, async (route) => {
      const url = new URL(route.request().url());
      const username = url.searchParams.get("u");
      const method = url.pathname.split("/").pop().replace(".view", "");
      const { artist, album, track } = library(username);
      if (method === "stream") {
        streams.push({ username, id: url.searchParams.get("id") });
        await route.fulfill({ contentType: "audio/wav", body: audio });
        return;
      }
      let fields = {};
      if (method === "ping")
        fields = { version: "1.16.1", type: "test", serverVersion: "1", openSubsonic: true };
      else if (method === "getIndexes") fields = { indexes: { lastModified: 2 } };
      else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
      else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
      else if (method === "savePlayQueue") fields = {};
      else if (method === "search3") {
        if (username === delayedUser) await gate;
        const slice = (values, name) =>
          values.slice(Number(url.searchParams.get(`${name}Offset`) ?? 0));
        fields = {
          searchResult3: {
            artist: slice([artist], "artist"),
            album: slice([album], "album"),
            song: slice([track], "song"),
          },
        };
      } else throw new Error(`Unexpected endpoint ${method}`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
      });
    });
    await page.goto(base);
    await page.locator("#server-host").waitFor();
    const settings = () => page.locator('.app-sidebar a[href="?/settings"]').click();
    const home = () => page.getByRole("link", { name: "Libras home", exact: true }).click();
    const downloads = () => page.locator('.app-sidebar a[href="?/downloads"]').click();
    async function connect(username, wait = true) {
      await page.getByLabel("Host", { exact: true }).fill(host);
      await page.getByLabel("Username", { exact: true }).fill(username);
      await page.getByLabel("Password", { exact: true }).fill("password");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      if (wait)
        await page
          .getByRole("link", { name: library(username).artist.name, exact: true })
          .waitFor();
    }
    async function action(username, name) {
      const tile = page.getByRole("link", { name: library(username).artist.name, exact: true });
      await tile.hover();
      await page.mouse.down();
      await page.waitForTimeout(600);
      await page.mouse.up();
      await page.locator("#artist-menu").getByRole("button", { name, exact: true }).click();
    }
    async function downloadAndPlay(username) {
      const before = streams.length;
      await action(username, "Download");
      await downloads();
      await page.locator('[aria-label="Downloaded"]').waitFor();
      assert.equal(await page.locator('[aria-label="Downloaded"]').count(), 1);
      assert.match(
        await page.locator('[aria-labelledby="downloads-heading"]').textContent(),
        new RegExp(`${username} track`),
      );
      assert.deepEqual(streams.slice(before), [{ username, id: library(username).track.id }]);
      await home();
      await action(username, "Play");
      await page.waitForFunction(
        () =>
          window.testAudio &&
          !window.testAudio.paused &&
          window.testAudio.currentSrc.startsWith("blob:"),
      );
      assert.equal(streams.length, before + 1, "playback must use the completed local download");
    }
    async function clear() {
      await settings();
      await page.locator("#settings-disconnect").click();
      await page.getByRole("dialog").getByRole("switch").check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await page.locator("#server-host").waitFor();
      assert.equal(await page.locator("dialog:modal").count(), 0);
    }
    async function seedQueued(username, savedAuth) {
      await page.evaluate(
        async ({ host, username, savedAuth }) => {
          const { Cache } = await import("/src/cache.svelte.ts");
          const { AuthStore, getAccountKey } = await import("/src/auth.ts");
          const cache = new Cache(getAccountKey({ host, username }));
          await cache.replaceLibrary({
            savedAt: 1,
            lastModified: 1,
            artists: [],
            albums: [],
            tracks: [],
          });
          // Persist an actually empty image catalog using the normal Cache APIs.
          await cache.saveImage("seed", { blob: new Blob(["image"]), type: "image/png" });
          await cache.evictImage("seed", cache.images.get("seed").fileName);
          await cache.enqueueDownload(
            {
              id: `${username}-track`,
              title: `${username} track`,
              artist: `${username} artist`,
              album: `${username} album`,
              contentType: "audio/wav",
            },
            "raw",
            "audio/wav",
          );
          await cache.flush();
          if (savedAuth) {
            const auth = new AuthStore();
            auth.save({
              host,
              username,
              credentials: { method: "token", username, token: "token", salt: "salt" },
            });
            auth.saveAccount({ host, username });
            localStorage.setItem("navidrome-offline-mode", "false");
          }
        },
        { host, username, savedAuth },
      );
    }
    return {
      page,
      streams,
      errors,
      settings,
      home,
      downloads,
      connect,
      downloadAndPlay,
      clear,
      seedQueued,
      delay(username) {
        delayedUser = username;
        gate = new Promise((resolve) => {
          release = resolve;
        });
        requested = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            /\/search3(?:\.view)?$/.test(url.pathname) && url.searchParams.get("u") === username
          );
        });
      },
      async finishHydration() {
        await requested;
        // Let the real App's empty-cache effect and download restoration settle before metadata arrives.
        await page.waitForTimeout(100);
        release();
      },
      async close() {
        release?.();
        await context.close();
      },
    };
  }
  try {
    for (const next of ["alpha", "beta"]) {
      await t.test(
        `clear then connect ${next === "alpha" ? "same" : "different"} account downloads and plays fresh bytes`,
        async () => {
          const f = await setup();
          try {
            await f.connect("alpha");
            await f.downloadAndPlay("alpha");
            await f.clear();
            await f.downloads();
            await f.page.getByRole("heading", { name: "No downloads yet" }).waitFor();
            assert.equal(await f.page.locator('[aria-label="Open Now Playing"]').count(), 0);
            await f.settings();
            await f.connect(next);
            assert.equal(await f.page.locator('[aria-label="Open Now Playing"]').count(), 0);
            const queue = await f.page.evaluate(
              async ({ host, username }) => {
                const { Cache } = await import("/src/cache.svelte.ts");
                const { getAccountKey } = await import("/src/auth.ts");
                const cache = new Cache(getAccountKey({ host, username }));
                await cache.load();
                return cache.queue;
              },
              { host, username: next },
            );
            assert.deepEqual(queue, { tracks: [], index: -1, position: 0 });
            assert.equal(
              await f.page
                .getByRole("link", {
                  name: library(next === "alpha" ? "beta" : "alpha").artist.name,
                  exact: true,
                })
                .count(),
              0,
            );
            await f.downloads();
            await f.page.getByRole("heading", { name: "No downloads yet" }).waitFor();
            await f.home();
            await f.downloadAndPlay(next);
            assert.deepEqual(f.errors, []);
          } finally {
            await f.close();
          }
        },
      );
    }
    for (const startup of [true, false]) {
      await t.test(
        `empty persisted metadata with queued intent survives ${startup ? "startup" : "account selection"} and delayed library hydration`,
        async () => {
          const f = await setup();
          try {
            if (!startup) {
              await f.connect("alpha");
              await f.clear();
            }
            await f.seedQueued("queued", startup);
            f.delay("queued");
            if (startup) await f.page.reload();
            else await f.connect("queued", false);
            await f.finishHydration();
            await f.home();
            await f.page.getByRole("link", { name: "queued artist", exact: true }).waitFor();
            await f.downloads();
            try {
              await f.page.locator('[aria-label="Downloaded"]').waitFor();
            } catch (error) {
              t.diagnostic(
                JSON.stringify({
                  startup,
                  streams: f.streams,
                  downloads: await f.page
                    .locator('[aria-labelledby="downloads-heading"]')
                    .textContent(),
                  sidebar: await f.page
                    .locator('.app-sidebar a[href="?/downloads"]')
                    .getAttribute("aria-label"),
                }),
              );
              throw error;
            }
            assert.deepEqual(f.streams, [{ username: "queued", id: "queued-track" }]);
            assert.deepEqual(f.errors, []);
          } finally {
            await f.close();
          }
        },
      );
    }
  } finally {
    await browser.close();
  }
});

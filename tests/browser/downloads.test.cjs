// Real app/engines/OPFS, with only the Subsonic transport intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

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

test("Downloads redesign preserves real transfer states and offline files", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let streams = 0;
  const errors = [];
  const unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://music.example.test/rest/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    if (method === "stream") {
      streams++;
      await gate;
      await route.fulfill({
        status: url.searchParams.get("id") === "track-6" ? 500 : 200,
        contentType: "audio/mpeg",
        body: "test audio bytes",
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
    else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
    else if (method === "search3") {
      const slice = (values, name) => {
        const offset = Number(url.searchParams.get(`${name}Offset`) ?? 0);
        return values.slice(offset, offset + Number(url.searchParams.get(`${name}Count`) ?? 500));
      };
      fields = {
        searchResult3: {
          artist: slice([artist], "artist"),
          album: slice([album], "album"),
          song: slice(tracks, "song"),
        },
      };
    } else unexpected.push(method);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  const navigate = (path) => page.goto(new URL(`#${path}`, base).href);
  try {
    await page.goto(base);
    await page.locator("#server-host").waitFor();
    await navigate("/downloads");
    await t.test("empty route uses the shared app shell", async () => {
      assert.equal(await page.locator(".downloads-view h1").textContent(), "Downloads");
      assert.equal(await page.getByRole("heading", { name: "No downloads yet" }).isVisible(), true);
      assert.equal(await page.locator('.downloads-view a[href="#/library"]').isVisible(), true);
      assert.equal(await page.locator(".app-sidebar").isVisible(), true);
    });

    await navigate("/settings");
    await page.getByLabel("Host", { exact: true }).fill("https://music.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const tile = page.getByRole("link", { name: artist.name, exact: true });
    await tile.waitFor();
    // Use the existing long-press interaction, rather than invoking a domain method.
    await tile.hover();
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page
      .locator("#artist-menu")
      .getByRole("button", { name: "Download", exact: true })
      .click();
    await navigate("/downloads");

    await t.test(
      "real active and queued jobs render readonly rows with accessible status",
      async () => {
        await page.waitForFunction(
          () => document.querySelectorAll('.downloads-view [role="listitem"]').length === 6,
        );
        const rows = page.locator('.downloads-view [role="listitem"]');
        assert.equal(await rows.locator('[role="img"][aria-label="Downloading"]').count(), 3);
        assert.equal(
          await rows.locator('[role="img"][aria-label="Queued for download"]').count(),
          3,
        );
        assert.equal(await rows.locator("button, a, [tabindex]").count(), 0);
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
          document.querySelector(".downloads-view .artwork img:not([hidden])"),
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
              .locator(".downloads-view")
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          );
        }
        await page.setViewportSize({ width: 375, height: 900 });
        await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
        assert.ok(
          await page
            .locator(".downloads-view")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        );
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
      },
    );

    release();
    await t.test(
      "completion and failure update the real cache without discarding saved rows",
      async () => {
        await page.waitForFunction(
          () => document.querySelectorAll('.downloads-view [aria-label="Downloaded"]').length === 5,
        );
        await page.getByRole("heading", { name: "Download failed", exact: true }).waitFor();
        assert.equal(await page.locator('.downloads-view [role="listitem"]').count(), 5);
        assert.equal(await page.locator(".downloads-view time").count(), 5);
        assert.match(
          await page.locator('.downloads-view [role="listitem"]').first().textContent(),
          /MP3|audio\/mpeg/,
        );
        assert.equal(streams, 6);
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
                if (JSON.parse(await file.text()).length === 5) return true;
              }
            } catch {}
            return false;
          });
          if (!checkpointed) await page.waitForTimeout(50);
        }
        assert.equal(checkpointed, true, "downloads must be checkpointed before reload");
      },
    );

    await t.test("disconnect and reload retain offline downloads", async () => {
      await navigate("/settings");
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await navigate("/downloads");
      await page.reload();
      await page.waitForFunction(
        () => document.querySelectorAll('.downloads-view [aria-label="Downloaded"]').length === 5,
      );
      assert.equal(await page.locator(".downloads-view time").count(), 5);
      assert.equal(await page.getByRole("heading", { name: "No downloads yet" }).count(), 0);
      assert.equal(streams, 6);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally {
    release();
    await browser.close();
  }
});

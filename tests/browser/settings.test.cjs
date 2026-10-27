// Native validation, keyboard/focus, responsive layout, and real OPFS persistence.
// State/rendering and async navigation races live in app-settings.test.ts.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;
const host = "music.example.test/music/library";
const username = `listener-${"long-name-".repeat(12)}`;
const artist = { id: "artist", name: "Settings test artist" };
const album = { id: "album", name: "Settings test album", artists: [artist] };
const track = { id: "track", title: "Settings test track", albumId: album.id, artists: [artist] };

test("Settings native controls, layout, and persistence", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10_000);
  const releases = [];
  const gate = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
  };
  let pingGate;
  let tailGate;
  let pingFailure = false;
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://music.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    calls.push(method);
    let fields;
    if (method === "ping") {
      const fail = pingFailure;
      if (pingGate) await pingGate.promise;
      fields = fail
        ? { status: "failed", error: { message: "Unauthorized" } }
        : { version: "1.16.1", type: "test-server", serverVersion: "1", openSubsonic: true };
    } else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
    else if (method === "search3") {
      if (tailGate && Number(url.searchParams.get("songOffset")) > 0) await tailGate.promise;
      const slice = (values, name) => {
        const offset = Number(url.searchParams.get(`${name}Offset`) ?? 0);
        return values.slice(offset, offset + Number(url.searchParams.get(`${name}Count`) ?? 500));
      };
      fields = {
        searchResult3: {
          artist: slice([artist], "artist"),
          album: slice([album], "album"),
          song: slice([track], "song"),
        },
      };
    } else throw new Error(`Unexpected endpoint: ${method}`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  const waitConnected = () =>
    page.waitForFunction(
      () =>
        document.querySelector("#settings-connection-status")?.textContent.includes("Connected") &&
        document.querySelector("#settings-refresh")?.getAttribute("aria-busy") !== "true",
    );

  try {
    await page.goto(base);
    await page.locator(".settings-view.ui-edgerunner").waitFor();
    await t.test("browser validation blocks submission without shifting the card", async () => {
      await page.evaluate(() => document.fonts.ready);
      const box = await page.locator("#settings-server").boundingBox();
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      assert.equal(
        await page
          .locator("#server-host")
          .evaluate(
            (input) =>
              input === document.activeElement &&
              input.validity.valueMissing &&
              !!input.validationMessage,
          ),
        true,
      );
      assert.deepEqual(await page.locator("#settings-server").boundingBox(), box);
      assert.equal(calls.length, 0);
    });

    await t.test(
      "keyboard submission and repeated Enter do not duplicate authentication",
      async () => {
        await page.getByLabel("Host", { exact: true }).fill(host);
        await page.getByLabel("Username", { exact: true }).fill(username);
        await page.getByLabel("Password", { exact: true }).fill("password");
        pingFailure = true;
        pingGate = gate();
        await page.keyboard.press("Enter");
        const connect = page.locator("#settings-connect");
        await page.waitForFunction(() => document.querySelector("#server-password")?.disabled);
        await connect.focus();
        await page.keyboard.press("Enter");
        pingGate.resolve();
        await page.locator("#settings-server-error").waitFor();
        assert.equal(calls.filter((method) => method === "ping").length, 1);
      },
    );

    await t.test("error controls work on desktop and mobile", async () => {
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("button", { name: "Show errors", exact: true }).click();
        await page.locator("#error-popover").waitFor();
        await page.getByRole("button", { name: "Close errors", exact: true }).click();
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    // Connect once to exercise the populated card and persist a real library snapshot.
    pingFailure = false;
    pingGate = undefined;
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".library-view .tile").waitFor();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await waitConnected();

    await t.test("cards respond to page width and controls fit at 200% text size", async () => {
      for (const width of [320, 768, 800, 810, 811, 1024, 1280, 1350, 1380, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.locator(".settings-view").evaluate((element) => {
          const server = element.querySelector("#settings-server").getBoundingClientRect();
          const offline = element.querySelector("#settings-offline-card").getBoundingClientRect();
          return {
            stacked: offline.top >= server.bottom,
            separated: offline.left >= server.right,
            fits: element.scrollWidth <= element.clientWidth,
          };
        });
        const split = await page.locator(".app-page").evaluate((node) => {
          const style = getComputedStyle(node);
          const width =
            node.clientWidth -
            parseFloat(style.paddingInlineStart) -
            parseFloat(style.paddingInlineEnd);
          return width > 64 * parseFloat(getComputedStyle(document.documentElement).fontSize);
        });
        assert.equal(split ? geometry.separated : geometry.stacked, true);
        assert.equal(geometry.fits, true);
      }
      await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      await page.setViewportSize({ width: 320, height: 900 });
      assert.equal(
        await page.locator(".settings-view").evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            [...element.querySelectorAll("button, a")].every((control) => {
              const card = control.closest(".card").getBoundingClientRect();
              const box = control.getBoundingClientRect();
              return box.left >= card.left && box.right <= card.right;
            }),
        ),
        true,
      );
      await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await t.test(
      "Refresh retains keyboard focus and Enter cannot submit duplicate work",
      async () => {
        tailGate = gate();
        const refresh = page.locator("#settings-refresh");
        const requested = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            url.pathname.endsWith("/search3.view") && Number(url.searchParams.get("songOffset")) > 0
          );
        });
        await refresh.click();
        await requested;
        await page.locator("#settings-library-progress").waitFor();
        assert.equal(await refresh.evaluate((element) => element === document.activeElement), true);
        const searches = calls.filter((method) => method === "search3").length;
        await page.keyboard.press("Enter");
        tailGate.resolve();
        tailGate = undefined;
        await waitConnected();
        assert.equal(calls.filter((method) => method === "search3").length, searches);
        assert.equal(await refresh.evaluate((element) => element === document.activeElement), true);
      },
    );

    await t.test("keyboard offline mode persists through reload without reconnecting", async () => {
      const control = page.getByRole("switch", { name: "Offline library", exact: true });
      await control.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(() =>
        document.querySelector("#settings-connection-status")?.textContent.includes("Offline mode"),
      );
      const pings = calls.filter((method) => method === "ping").length;
      await page.reload();
      await page.waitForFunction(() =>
        document.querySelector("#settings-connection-status")?.textContent.includes("Offline mode"),
      );
      assert.equal(await control.isChecked(), true);
      assert.equal(calls.filter((method) => method === "ping").length, pings);
      const searches = calls.filter((method) => method === "search3").length;
      await control.focus();
      await page.keyboard.press("Space");
      await waitConnected();
      assert.equal(calls.filter((method) => method === "search3").length, searches);
      await page.getByRole("link", { name: "Libras home", exact: true }).click();
      await page.locator(".library-view .tile").waitFor();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await waitConnected();
    });

    await t.test("Disconnect does not autofocus Host", async () => {
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await page.locator("#server-host").waitFor();
      assert.equal(
        await page.locator("#server-host").evaluate((input) => input === document.activeElement),
        false,
      );
    });
    assert.deepEqual(errors, []);
  } finally {
    for (const release of releases) release();
    await browser.close();
  }
});

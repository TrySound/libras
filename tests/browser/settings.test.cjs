// Actual app/Session/OPFS; only the Subsonic transport is intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;
const host = "music.example.test/music/library";
const username = `listener-${"long-name-".repeat(12)}`;
const password = "private-password-never-rendered";
const artist = { id: "artist", name: "Settings test artist" };
const album = { id: "album", name: "Settings test album", artists: [artist] };
const track = { id: "track", title: "Settings test track", albumId: album.id, artists: [artist] };

test("Settings redesign preserves real connection, refresh, offline, and focus behavior", async (t) => {
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
  let syncFailure = false;
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://music.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    calls.push(method);
    let fields = {};
    if (method === "ping") {
      const fail = pingFailure;
      const pending = pingGate;
      if (pending) await pending.promise;
      fields = fail
        ? { status: "failed", error: { message: "Unauthorized" } }
        : { version: "1.16.1", type: "test-server", serverVersion: "1", openSubsonic: true };
    } else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue") fields = { playQueue: { entry: [] } };
    else if (method === "search3") {
      if (syncFailure) {
        await route.fulfill({ status: 503, body: "Unavailable" });
        return;
      }
      const pending = tailGate;
      if (pending && Number(url.searchParams.get("songOffset")) > 0) await pending.promise;
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
  const status = page.locator("#settings-connection-status");
  const fill = async () => {
    await page.getByLabel("Host", { exact: true }).fill(host);
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
  };
  const waitStatus = (value) =>
    page.waitForFunction(
      (label) =>
        document.querySelector("#settings-connection-status")?.textContent.includes(label) &&
        (label !== "Connected" ||
          document.querySelector("#settings-refresh")?.getAttribute("aria-busy") !== "true"),
      value,
    );

  try {
    await page.goto(base);
    await page.locator(".settings-view.ui-edgerunner").waitFor();
    await t.test(
      "native validation and labeled fields do not send incomplete credentials",
      async () => {
        assert.equal(await page.getByRole("heading", { name: "Settings", exact: true }).count(), 1);
        assert.equal(
          await page.getByRole("region", { name: "Music server", exact: true }).count(),
          1,
        );
        assert.equal(
          await page.getByRole("switch", { name: "Offline library", exact: true }).isDisabled(),
          true,
        );
        assert.equal(await page.locator("#server-host-error").isVisible(), false);
        assert.equal(await page.locator("select").count(), 0);
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        assert.equal(
          await page
            .locator("#server-host")
            .evaluate((element) => element === document.activeElement),
          true,
        );
        assert.equal(await page.locator("#server-host-error").isVisible(), true);
        assert.equal(calls.length, 0);
      },
    );

    await t.test(
      "pending and failed authentication preserve focus without exposing credentials",
      async () => {
        await fill();
        pingFailure = true;
        pingGate = gate();
        const connect = page.locator("#settings-connect");
        const requested = page.waitForRequest((request) =>
          new URL(request.url()).pathname.endsWith("/ping.view"),
        );
        await connect.click();
        await requested;
        await waitStatus("Connecting…");
        assert.equal(await connect.getAttribute("aria-disabled"), "true");
        assert.equal(await connect.evaluate((element) => element === document.activeElement), true);
        assert.equal(await page.locator("form").getAttribute("aria-busy"), "true");
        assert.equal(await page.locator("#server-password").isDisabled(), true);
        await page.keyboard.press("Enter");
        assert.equal(calls.filter((method) => method === "ping").length, 1);
        pingGate.resolve();
        await waitStatus("Connection failed");
        assert.equal(await page.locator("#settings-server-error").textContent(), "Unauthorized");
        assert.match(
          await page.locator("form").getAttribute("aria-describedby"),
          /settings-server-error/,
        );
        assert.equal(await connect.evaluate((element) => element === document.activeElement), true);
        assert.equal(await page.locator("#server-password").getAttribute("type"), "password");
        assert.equal(await page.evaluate(() => localStorage.getItem("navidrome-auth")), null);
        assert.ok(!(await page.locator("body").innerText()).includes(password));
      },
    );

    await t.test(
      "successful authentication keeps navigation and the read-only summary",
      async () => {
        pingFailure = false;
        pingGate = undefined;
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await page.locator(".library-view .tile").waitFor();
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await waitStatus("Connected");
        assert.equal(await page.locator("form").count(), 0);
        assert.equal(
          await page.locator("#settings-server-identity").textContent(),
          `${username}@${host}`,
        );
        assert.equal(
          (await status.innerText()).replace(/\s+/g, " ").trim(),
          `Connected to ${username}@${host}`,
        );
        const auth = await page.evaluate(() => JSON.parse(localStorage.getItem("navidrome-auth")));
        const visible = await page.locator("body").innerText();
        for (const secret of [password, auth.token, auth.salt])
          assert.ok(!visible.includes(secret));
        assert.ok(!JSON.stringify(auth).includes(password));
        for (const width of [320, 375, 768, 1024, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          const geometry = await page.locator(".split-layout").evaluate((element) => {
            const server = document.querySelector("#settings-server").getBoundingClientRect();
            const offline = document
              .querySelector("#settings-offline-card")
              .getBoundingClientRect();
            return {
              columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
              stacked: offline.top >= server.bottom,
              separated: offline.left >= server.right,
            };
          });
          assert.equal(geometry.columns, width >= 1024 ? 2 : 1);
          assert.equal(width >= 1024 ? geometry.separated : geometry.stacked, true);
          assert.ok(
            await page
              .locator(".settings-view")
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          );
        }
        await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
        for (const width of [320, 375]) {
          await page.setViewportSize({ width, height: 900 });
          assert.ok(
            await page
              .locator(".settings-view")
              .evaluate((element) => element.scrollWidth <= element.clientWidth),
          );
          assert.ok(
            await page.locator(".settings-view").evaluate((element) =>
              [...element.querySelectorAll("button, a")].every((control) => {
                const card = control.closest(".card").getBoundingClientRect();
                const box = control.getBoundingClientRect();
                return box.left >= card.left && box.right <= card.right;
              }),
            ),
          );
        }
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
        await page.setViewportSize({ width: 1280, height: 900 });
      },
    );

    await t.test(
      "refresh uses the real counters and retains its mounted, focused button",
      async () => {
        tailGate = gate();
        const refresh = page.locator("#settings-refresh");
        const tailRequested = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            url.pathname.endsWith("/search3.view") && Number(url.searchParams.get("songOffset")) > 0
          );
        });
        await refresh.click();
        await tailRequested;
        await page.locator("#settings-library-progress").waitFor();
        await page.waitForFunction(() =>
          document.querySelector("#settings-library-progress")?.textContent.includes("1 albums"),
        );
        assert.match(await page.locator("#settings-library-progress").textContent(), /1\s+tracks/);
        assert.equal(await status.locator("#settings-library-progress").count(), 1);
        assert.equal(
          await page
            .locator("#settings-library-progress")
            .evaluate((element) => getComputedStyle(element).color),
          "rgb(254, 238, 177)",
        );
        assert.ok(!(await status.textContent()).includes("Refreshing…"));
        assert.ok((await refresh.textContent()).includes("Refreshing…"));
        assert.equal(await refresh.getAttribute("aria-disabled"), "true");
        assert.equal(await refresh.evaluate((element) => element === document.activeElement), true);
        assert.equal(
          await page.getByRole("button", { name: "Disconnect", exact: true }).isEnabled(),
          true,
        );
        const searches = calls.filter((method) => method === "search3").length;
        await page.keyboard.press("Enter");
        assert.equal(calls.filter((method) => method === "search3").length, searches);
        tailGate.resolve();
        tailGate = undefined;
        await waitStatus("Connected");
        assert.equal(await refresh.evaluate((element) => element === document.activeElement), true);
      },
    );

    await t.test("refresh failures keep the saved library and a working retry", async () => {
      syncFailure = true;
      await page.locator("#settings-refresh").click();
      await page.getByRole("heading", { name: "Synchronization needs attention" }).waitFor();
      await waitStatus("Connected");
      assert.equal(await page.locator("form").count(), 0);
      assert.ok((await status.textContent()).includes("Connected"));
      assert.equal(
        await page.locator("#settings-server-identity").textContent(),
        `${username}@${host}`,
      );
      syncFailure = false;
      await page.locator("#settings-refresh").click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#settings-server")
            ?.textContent.includes("Synchronization needs attention"),
      );
      await waitStatus("Connected");
    });

    await t.test("keyboard offline mode persists through reload without reconnecting", async () => {
      const control = page.getByRole("switch", { name: "Offline library", exact: true });
      await control.focus();
      await page.keyboard.press("Space");
      await waitStatus("Offline mode");
      assert.equal(await control.isChecked(), true);
      assert.equal(await page.locator("#settings-refresh").isDisabled(), true);
      const pings = calls.filter((method) => method === "ping").length;
      await page.reload();
      await waitStatus("Offline mode");
      assert.equal(await control.isChecked(), true);
      assert.equal(calls.filter((method) => method === "ping").length, pings);
      await control.focus();
      await page.keyboard.press("Space");
      await waitStatus("Connected");
      assert.equal(await control.isChecked(), false);
    });

    await t.test(
      "disconnect clears the form, restores focus, and leaves offline data intact",
      async () => {
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.id === "server-host");
        for (const id of ["server-host", "server-username", "server-password"])
          assert.equal(await page.locator(`#${id}`).inputValue(), "");
        assert.equal(
          await page.getByRole("switch", { name: "Offline library", exact: true }).isChecked(),
          true,
        );
        assert.equal(
          await page.getByRole("switch", { name: "Offline library", exact: true }).isDisabled(),
          true,
        );
        assert.equal(await page.evaluate(() => localStorage.getItem("navidrome-auth")), null);
        assert.notEqual(await page.evaluate(() => localStorage.getItem("navidrome-account")), null);
      },
    );

    await t.test(
      "finishing a connection after leaving Settings does not steal navigation",
      async () => {
        await fill();
        pingGate = gate();
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await waitStatus("Connecting…");
        await page.getByRole("link", { name: "View downloads", exact: true }).click();
        await page.locator(".downloads-view").waitFor();
        pingGate.resolve();
        await page.waitForFunction(() => localStorage.getItem("navidrome-auth") !== null);
        assert.equal(new URL(page.url()).hash, "#/downloads");
        assert.equal(
          await page.getByRole("heading", { name: "Downloads", exact: true }).count(),
          1,
        );
        assert.ok(!(await page.locator("body").innerText()).includes(password));
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    for (const release of releases) release();
    await browser.close();
  }
});

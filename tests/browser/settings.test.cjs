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
  let pingCode;
  let passwordRequests = 0;
  const pingMethods = [];
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://music.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    calls.push(method);
    const body = new URLSearchParams(route.request().postData() ?? "");
    if (url.searchParams.has("p") || body.has("p")) passwordRequests++;
    let fields;
    if (method === "ping") {
      const direct = url.searchParams.has("p");
      pingMethods.push(direct ? "password" : "token");
      const fail = pingFailure && !direct;
      if (pingGate) await pingGate.promise;
      fields = fail
        ? { status: "failed", error: { code: pingCode, message: "Unauthorized" } }
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
        !!document.querySelector("#settings-server-identity") &&
        !document.querySelector("#settings-offline")?.checked &&
        document.querySelector("#settings-refresh")?.getAttribute("aria-busy") === "false",
    );

  try {
    await page.goto(base);
    await page.locator("[aria-labelledby=settings-heading]").waitFor();
    await t.test("browser validation blocks submission without shifting the card", async () => {
      await page.evaluate(() => document.fonts.ready);
      const connect = page.locator("#settings-connect");
      assert.equal(await connect.getAttribute("data-variant"), "primary");
      assert.ok((await connect.boundingBox()).height >= 44);
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
    await page.getByLabel("Password", { exact: true }).fill("password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("[aria-labelledby=library-heading] .tile").waitFor();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await waitConnected();

    await t.test("cards respond to page width and controls fit at 200% text size", async () => {
      for (const [width, ratio] of [
        [320, null],
        [1024, null],
        [1280, 1],
        [1440, 3 / 2],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page
          .locator("[aria-labelledby=settings-heading]")
          .evaluate((element) => {
            const server = element.querySelector("#settings-server").getBoundingClientRect();
            const offline = element.querySelector("#settings-offline-card").getBoundingClientRect();
            return {
              stacked: offline.top >= server.bottom,
              separated: offline.left >= server.right,
              ratio: server.width / offline.width,
              fits: element.scrollWidth <= element.clientWidth,
            };
          });
        assert.equal(ratio === null ? geometry.stacked : geometry.separated, true);
        if (ratio !== null) assert.ok(Math.abs(geometry.ratio - ratio) < 0.02);
        assert.equal(geometry.fits, true);
      }
      await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      await page.setViewportSize({ width: 320, height: 900 });
      assert.equal(
        await page.locator("[aria-labelledby=settings-heading]").evaluate(
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
      const onThumb = await control.evaluate(
        (node) => getComputedStyle(node, "::before").backgroundColor,
      );
      assert.equal(onThumb, "rgb(239, 191, 4)");
      assert.equal(
        await control.evaluate((node) => getComputedStyle(node).backgroundColor),
        "rgb(129, 0, 0)",
      );
      assert.equal(calls.filter((method) => method === "ping").length, pings);
      const searches = calls.filter((method) => method === "search3").length;
      await control.focus();
      await page.keyboard.press("Space");
      await waitConnected();
      assert.equal(await control.isChecked(), false);
      assert.notEqual(
        await control.evaluate((node) => getComputedStyle(node, "::before").backgroundColor),
        onThumb,
      );
      assert.equal(calls.filter((method) => method === "search3").length, searches);
      await page.getByRole("link", { name: "Libras home", exact: true }).click();
      await page.locator("[aria-labelledby=library-heading] .tile").waitFor();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await waitConnected();
    });

    await t.test("shared modals reduce mobile padding without crowding handles", async () => {
      const artifacts = process.env.ARTIFACT_DIR;
      if (artifacts) require("node:fs").mkdirSync(artifacts, { recursive: true });
      await page.getByRole("link", { name: "Libras home", exact: true }).click();
      await page.locator("[aria-labelledby=library-heading] .tile").waitFor();
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 740 });
        for (const selector of ["#navigation-dialog", "#artist-menu"]) {
          const modal = page.locator(selector);
          await modal.evaluate((node) => node.showModal());
          const geometry = await modal.evaluate((node) => {
            const style = getComputedStyle(node);
            const handle = node.querySelector(".dialog-handle").getBoundingClientRect();
            const content = node
              .querySelector(".dialog-handle")
              .nextElementSibling.getBoundingClientRect();
            return {
              padding: [
                style.paddingTop,
                style.paddingRight,
                style.paddingBottom,
                style.paddingLeft,
              ],
              fits: node.scrollWidth <= node.clientWidth,
              handleClear: node.classList.contains("bottom-sheet")
                ? content.top > handle.bottom
                : content.left > handle.right,
            };
          });
          assert.deepEqual(
            geometry.padding,
            width === 1280
              ? ["24px", "24px", "24px", "24px"]
              : selector === "#artist-menu"
                ? ["24px", "16px", "16px", "16px"]
                : ["16px", "16px", "16px", "24px"],
          );
          assert.equal(geometry.fits, true);
          assert.equal(geometry.handleClear, true);
          if (artifacts)
            await page.screenshot({ path: `${artifacts}/${selector.slice(1)}-${width}.png` });
          await modal.evaluate((node) => node.close());
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await waitConnected();
    });

    await t.test(
      "Disconnect safely focuses Cancel, preserves on dismissal, and keeps data",
      async () => {
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        assert.equal(
          await page
            .getByRole("button", { name: "Cancel", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        const dialog = page.getByRole("dialog", { name: "Disconnect?", exact: true });
        const checkbox = dialog.getByRole("switch", {
          name: "Delete account data and downloads from device",
          exact: true,
        });
        assert.equal(await checkbox.isChecked(), false);
        assert.equal(await checkbox.getAttribute("aria-describedby"), "disconnect-scope");
        assert.equal(
          await dialog.locator("#disconnect-scope").textContent(),
          "Server data is unaffected.",
        );
        assert.equal(await dialog.getByRole("button").count(), 2);
        for (const width of [1280, 320]) {
          await page.setViewportSize({ width, height: 740 });
          assert.equal(
            await checkbox.evaluate((node) => {
              const label = document
                .querySelector('label[for="disconnect-delete-local"]')
                .getBoundingClientRect();
              return node.getBoundingClientRect().left >= label.right;
            }),
            true,
          );
        }
        await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
        const enlarged = await dialog.evaluate((node) => {
          const label = node.querySelector('label[for="disconnect-delete-local"]');
          const text = label.firstChild;
          const words = [...text.textContent.matchAll(/\S+/g)];
          const wholeWords = words.every((word) => {
            const range = document.createRange();
            range.setStart(text, word.index);
            range.setEnd(text, word.index + word[0].length);
            return range.getClientRects().length === 1;
          });
          return {
            wholeWords,
            switchBelow:
              node.querySelector('[role="switch"]').getBoundingClientRect().top >=
              label.getBoundingClientRect().bottom,
            fits: node.scrollWidth <= node.clientWidth,
          };
        });
        assert.deepEqual(enlarged, { wholeWords: true, switchBelow: true, fits: true });
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
        await page.setViewportSize({ width: 1280, height: 900 });
        await checkbox.focus();
        await page.keyboard.press("Space");
        assert.equal(await checkbox.isChecked(), true);
        await page.keyboard.press("Escape");
        assert.ok(await page.evaluate(() => localStorage.getItem("navidrome-auth")));
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        assert.equal(await checkbox.isChecked(), false);
        await checkbox.check();
        await page.mouse.click(2, 2);
        assert.equal(await page.locator("dialog:modal").count(), 0);
        assert.ok(await page.evaluate(() => localStorage.getItem("navidrome-auth")));
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        assert.equal(await checkbox.isChecked(), false);
        await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
        await page.locator("#server-host").waitFor();
        assert.equal(
          await page.locator("#server-host").evaluate((input) => input === document.activeElement),
          true,
        );
      },
    );
    await t.test("automatic password fallback survives reload until disconnect", async () => {
      pingFailure = true;
      pingCode = 41;
      await page.getByLabel("Host", { exact: true }).fill(host);
      await page.getByLabel("Username", { exact: true }).fill(username);
      await page.getByLabel("Password", { exact: true }).fill("enc:literal-password");
      assert.equal(passwordRequests, 0);
      const before = pingMethods.length;
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page.locator("[aria-labelledby=library-heading] .tile").waitFor();
      assert.deepEqual(pingMethods.slice(before), ["token", "password"]);
      assert.ok(passwordRequests > 0);
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("navidrome-auth")).credentials.method,
        ),
        "password",
      );
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await waitConnected();
      await page.reload();
      await waitConnected();
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      assert.equal(await page.evaluate(() => localStorage.getItem("navidrome-auth")), null);
      assert.ok(await page.evaluate(() => localStorage.getItem("navidrome-account")));
    });
    await t.test(
      "cleanup removes real OPFS account data, survives deletion denial and late work",
      async () => {
        await page.getByLabel("Host", { exact: true }).fill(host);
        await page.getByLabel("Username", { exact: true }).fill(username);
        await page.getByLabel("Password", { exact: true }).fill("password");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await page.locator("[aria-labelledby=library-heading] .tile").waitFor();
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await waitConnected();
        await page.waitForTimeout(600);
        await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const accounts = await root.getDirectoryHandle("accounts");
          const unrelated = await accounts.getDirectoryHandle("unrelated", { create: true });
          const marker = await unrelated.getFileHandle("keep", { create: true });
          const writer = await marker.createWritable();
          await writer.write("preserve");
          await writer.close();
          window.originalRemove = FileSystemDirectoryHandle.prototype.removeEntry;
          FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
            if (options?.recursive && name !== "unrelated") {
              await new Promise((resolve) => {
                window.releaseCleanup = resolve;
              });
              if (!window.allowCleanup)
                throw new DOMException("Test deletion denial", "NotAllowedError");
            }
            return window.originalRemove.call(this, name, options);
          };
        });
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        const artifacts = process.env.ARTIFACT_DIR;
        if (artifacts) {
          require("node:fs").mkdirSync(artifacts, { recursive: true });
          const modal = page.getByRole("dialog", { name: "Disconnect?", exact: true });
          const padding = () => modal.evaluate((node) => getComputedStyle(node).padding);
          assert.equal(await padding(), "24px");
          await page.screenshot({ path: `${artifacts}/disconnect-desktop.png` });
          await modal.getByRole("switch").check();
          await page.screenshot({ path: `${artifacts}/disconnect-desktop-checked.png` });
          await modal.getByRole("switch").uncheck();
          await page.setViewportSize({ width: 320, height: 740 });
          assert.equal(await padding(), "16px");
          await page.screenshot({ path: `${artifacts}/disconnect-mobile.png` });
          await modal.getByRole("switch").check();
          await page.screenshot({ path: `${artifacts}/disconnect-mobile-checked.png` });
          await modal.getByRole("switch").uncheck();
          await page.locator("dialog:modal").evaluate((dialog) => {
            dialog.scrollTop = dialog.scrollHeight;
          });
          await page.screenshot({ path: `${artifacts}/disconnect-mobile-actions.png` });
          assert.equal(
            await page
              .locator("dialog:modal")
              .evaluate((node) => node.scrollWidth <= node.clientWidth),
            true,
          );
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "200%";
          });
          assert.equal(
            await page
              .locator("dialog:modal")
              .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
            true,
          );
          assert.equal(
            await modal
              .getByRole("switch")
              .evaluate((node) => node.getBoundingClientRect().width === node.offsetWidth),
            true,
          );
          await page.screenshot({ path: `${artifacts}/disconnect-enlarged.png` });
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "";
          });
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        const before = calls.length;
        await page.getByRole("dialog").getByRole("switch").check();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Disconnect", exact: true })
          .click();
        await page.waitForFunction(() => !!window.releaseCleanup);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("dialog:modal").count(), 1);
        assert.equal(
          await page
            .locator("dialog [data-cleanup-focus]")
            .evaluate((node) => node === document.activeElement),
          true,
        );
        if (artifacts) await page.screenshot({ path: `${artifacts}/disconnect-busy.png` });
        // Browser history can leave a modal view while Session continues cleanup.
        await page.goBack();
        await page.locator("[aria-labelledby=library-heading]").waitFor();
        assert.equal(await page.locator("dialog:modal").count(), 0);
        await page.evaluate(() => window.releaseCleanup());
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        const recovery = page.locator("#settings-cleanup-recovery");
        await recovery.waitFor();
        assert.equal(await page.locator("#settings-connect").count(), 0);
        await recovery.click();
        const retry = page
          .locator("dialog:modal")
          .getByRole("button", { name: "Retry cleanup", exact: true });
        await retry.waitFor();
        await page.waitForFunction(() =>
          document.activeElement?.matches("dialog [data-cleanup-focus]"),
        );
        assert.equal(await retry.getAttribute("aria-describedby"), "disconnect-cleanup-error");
        if (artifacts) await page.screenshot({ path: `${artifacts}/disconnect-error.png` });
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () => document.activeElement?.id === "settings-cleanup-recovery",
        );
        assert.equal(await page.locator("dialog:modal").count(), 0);
        if (artifacts) await page.screenshot({ path: `${artifacts}/disconnect-recovery.png` });
        await recovery.press("Enter");
        await retry.waitFor();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.waitForFunction(
          () => document.activeElement?.id === "settings-cleanup-recovery",
        );
        await recovery.press("Enter");
        await retry.waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem("navidrome-auth")), null);
        assert.equal(await page.evaluate(() => localStorage.getItem("navidrome-account")), null);
        await page.evaluate(() => {
          window.releaseCleanup = null;
          window.allowCleanup = true;
        });
        await retry.click();
        await page.waitForFunction(() => !!window.releaseCleanup);
        await page.evaluate(() => window.releaseCleanup());
        await page.waitForFunction(() => !document.querySelector("dialog:modal"));
        assert.deepEqual(calls.slice(before), []);
        const accountDirectories = () =>
          page.evaluate(async () => {
            const accounts = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle("accounts");
            return Array.fromAsync(accounts.keys());
          });
        assert.deepEqual(await accountDirectories(), ["unrelated"]);
        await page.reload();
        await page.locator("#server-host").waitFor();
        await page.waitForTimeout(700);
        assert.deepEqual(await accountDirectories(), ["unrelated"]);
        assert.equal(await page.locator("[aria-labelledby=library-heading] .tile").count(), 0);
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    for (const release of releases) release();
    await browser.close();
  }
});

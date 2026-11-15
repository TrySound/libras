// Run against the app dev server: real Web Locks + OPFS, no storage/lock substitutes.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { mkdir, writeFile } = require("node:fs/promises");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";
const artifacts = process.env.ARTIFACT_DIR;

test("exclusive account activation blocks deletion, releases on close and retries with the durable queue", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const first = await context.newPage();
  const errors = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  let second;
  try {
    if (artifacts) await mkdir(artifacts, { recursive: true });
    await first.goto(base);
    const expected = { tracks: ["same", "same", "unavailable"], index: 1, position: 37 };
    await first.evaluate(async (queue) => {
      const { Cache } = await import("/src/cache.svelte.ts");
      const { AuthStore, getAccountKey } = await import("/src/auth.ts");
      const account = { host: "https://ownership.example", username: "listener" };
      const cache = new Cache(getAccountKey(account));
      cache.setQueue(queue);
      await cache.flushQueue();
      new AuthStore().saveAccount(account);
    }, expected);
    await first.reload();
    await first
      .getByRole("heading", { name: "This account is open in another tab" })
      .waitFor({ state: "hidden" });
    // Wait for the actual browser-managed account lease, not just route rendering.
    await first.waitForFunction(async () =>
      (await navigator.locks.query()).held.some((lock) => lock.name.startsWith("libras-account:")),
    );
    second = await context.newPage();
    await second.goto(base);
    const heading = second.getByRole("heading", { name: "This account is open in another tab" });
    await heading.waitFor();
    assert.equal(await second.getByRole("button", { name: "Disconnect", exact: true }).count(), 0);
    assert.equal(await second.getByRole("checkbox", { name: /delete/i }).count(), 0);
    for (const [width, height, name] of [
      [390, 844, "blocked-narrow"],
      [1440, 900, "blocked-desktop"],
      [320, 844, "blocked-320"],
    ]) {
      await second.setViewportSize({ width, height });
      assert.equal(
        await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (artifacts) await second.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
    }
    const retry = second.getByRole("button", { name: "Retry", exact: true });
    const tabStops = [];
    for (let index = 0; index < 20; index++) {
      await second.keyboard.press("Tab");
      tabStops.push(await second.evaluate(() => document.activeElement?.textContent?.trim()));
      if (await retry.evaluate((button) => button === document.activeElement)) break;
    }
    assert.equal(await retry.evaluate((button) => button === document.activeElement), true);
    await second.keyboard.press("Enter");
    await second
      .getByRole("status")
      .filter({ hasText: "This account is still open in another tab." })
      .waitFor();
    assert.equal(await retry.evaluate((button) => button === document.activeElement), true);
    if (artifacts)
      await second.screenshot({ path: `${artifacts}/keyboard-retry-320.png`, fullPage: true });
    // Delay only the next request's callback to render Checking; acquisition remains native.
    await second.evaluate(() => {
      const request = navigator.locks.request.bind(navigator.locks);
      navigator.locks.request = (...args) =>
        new Promise((resolve, reject) => {
          window.finishOwnershipCheck = () => {
            navigator.locks.request = request;
            delete window.finishOwnershipCheck;
            return request(...args).then(resolve, reject);
          };
        });
    });
    await second.keyboard.press("Enter");
    await second.getByRole("button", { name: "Checking…" }).waitFor();
    // Hold the real busy state through browser painting as well as DOM publication.
    await second.waitForTimeout(500);
    const checkingVisibility = await heading.evaluate(async (heading) => {
      await document.fonts.ready;
      const card = heading.parentElement;
      await Promise.all(
        card
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return [heading, ...card.querySelectorAll("p, a")]
        .filter((element) => element.textContent.trim())
        .map((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          let visible =
            rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth;
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const computed = getComputedStyle(ancestor);
            visible &&=
              computed.visibility === "visible" &&
              computed.display !== "none" &&
              Number(computed.opacity) > 0;
          }
          return { text: element.textContent.trim(), visible, color: style.color };
        });
    });
    assert.equal(checkingVisibility.length, 4);
    for (const item of checkingVisibility) {
      assert.equal(item.visible, true, item.text);
      assert.notEqual(item.color, "rgba(0, 0, 0, 0)");
    }
    assert.match(checkingVisibility[0].text, /This account is open in another tab/);
    assert.match(checkingVisibility[1].text, /listener.*ownership.example/);
    assert.match(checkingVisibility[2].text, /Close the other Libras tab, then retry/);
    assert.equal(checkingVisibility[3].text, "Use another account");
    const checkingScreenshot =
      process.env.CHECKING_SCREENSHOT ?? (artifacts && `${artifacts}/checking-320.png`);
    if (checkingScreenshot) {
      await second.screenshot({ path: checkingScreenshot });
      await writeFile(
        checkingScreenshot.replace(/\.png$/, ".visibility.json"),
        JSON.stringify(checkingVisibility, null, 2),
      );
    }
    await second.evaluate(() => window.finishOwnershipCheck());
    await retry.waitFor();
    await second.waitForFunction(
      () =>
        !document.querySelector("#account-blocked-heading")?.parentElement.querySelector("button")
          ?.disabled,
    );
    await first.close();
    await second.waitForFunction(
      async () =>
        !(await navigator.locks.query()).held.some((lock) =>
          lock.name.startsWith("libras-account:"),
        ),
    );
    // No polling: closing the owner alone must leave the secondary page blocked.
    await heading.waitFor();
    await retry.focus();
    await second.keyboard.press("Enter");
    await heading.waitFor({ state: "hidden" });
    await second.waitForFunction(() => !document.querySelector("#account-blocked-heading"));
    const queue = await second.evaluate(async () => {
      const { Cache } = await import("/src/cache.svelte.ts");
      const { AuthStore, getAccountKey } = await import("/src/auth.ts");
      const cache = new Cache(getAccountKey(new AuthStore().loadAccount()));
      await cache.load();
      return cache.queue;
    });
    assert.deepEqual(queue, expected);
    assert.equal(
      await second.evaluate(() =>
        [...document.querySelectorAll("audio")].some((audio) => !audio.paused),
      ),
      false,
    );
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() =>
      Object.defineProperty(navigator, "locks", { value: undefined }),
    );
    await unsupported.goto(base);
    await unsupported
      .getByRole("heading", { name: "This browser cannot safely open this account’s local data." })
      .waitFor();
    assert.equal(await unsupported.getByRole("button", { name: "Retry", exact: true }).count(), 0);
    await unsupported.setViewportSize({ width: 390, height: 844 });
    if (artifacts)
      await unsupported.screenshot({ path: `${artifacts}/unsupported-narrow.png`, fullPage: true });
    assert.deepEqual(errors, []);
    if (artifacts)
      await writeFile(
        `${artifacts}/browser-evidence.json`,
        JSON.stringify(
          {
            browser: browser.version(),
            widths: [390, 1440, 320],
            horizontalOverflow: false,
            tabStops,
            keyboardRetry: "Enter: blocked announcement then successful retry after owner close",
            checking: true,
            unsupported: true,
            preservedQueue: queue,
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
  } finally {
    // Never leave a fixture-controlled acquisition unresolved on assertion failure.
    if (second && !second.isClosed())
      await second.evaluate(() => window.finishOwnershipCheck?.()).catch(() => {});
    await context.close();
    await browser.close();
  }
});

test("saved credentials cannot reconnect blocked or unsupported startup through navigation toggles", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const owner = await context.newPage();
  const requests = [];
  await context.route("https://ownership.example/**", async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 500, body: "Unexpected fixture request" });
  });
  try {
    await owner.goto(base);
    await owner.evaluate(async () => {
      const { acquireAccountOwnership } = await import("/src/account-ownership.ts");
      const { getAccountKey } = await import("/src/auth.ts");
      window.releaseFixtureAccount = await acquireAccountOwnership(
        getAccountKey({ host: "https://ownership.example", username: "listener" }),
      );
    });
    for (const reason of ["blocked", "unsupported"]) {
      await owner.evaluate(async () => {
        const { AuthStore } = await import("/src/auth.ts");
        localStorage.setItem("navidrome-offline-mode", "false");
        new AuthStore().save({
          host: "https://ownership.example",
          username: "listener",
          credentials: {
            method: "token",
            username: "listener",
            token: "synthetic-fixture",
            salt: "synthetic-fixture",
          },
        });
      });
      const page = await context.newPage();
      if (reason === "unsupported")
        await page.addInitScript(() =>
          Object.defineProperty(navigator, "locks", { value: undefined }),
        );
      await page.goto(base);
      const heading = page.getByRole("heading", {
        name:
          reason === "blocked"
            ? "This account is open in another tab"
            : "This browser cannot safely open this account’s local data.",
      });
      await heading.waitFor();
      const toggle = page.getByRole("button", { name: "Work offline", exact: true });
      assert.equal(await toggle.isDisabled(), true);
      // Even a dispatched handler cannot bypass the Session command guard.
      await toggle.dispatchEvent("click");
      await toggle.dispatchEvent("click");
      await heading.waitFor();
      assert.equal(
        await page.getByText("Account not active", { exact: true }).first().isVisible(),
        true,
      );
      assert.equal(await page.getByText("Connected", { exact: true }).count(), 0);
      assert.deepEqual(requests, []);
      if (reason === "blocked")
        assert.equal(
          await page.getByRole("button", { name: "Retry", exact: true }).isEnabled(),
          true,
        );
      else assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
      await page.getByRole("link", { name: "Use another account", exact: true }).click();
      await heading.waitFor({ state: "hidden" });
      assert.deepEqual(requests, []);
      await page.close();
    }
  } finally {
    await owner.evaluate(() => window.releaseFixtureAccount?.()).catch(() => {});
    await context.close();
    await browser.close();
  }
});

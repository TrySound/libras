const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = (process.env.PREVIEW_URL ?? "http://127.0.0.1:3003").replace(/\/$/, "");

async function rest(drawer) {
  await drawer.evaluate(async (d) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(d.getAnimations().map((a) => a.finished.catch(() => {})));
  });
}
async function swipe(cdp, x, y, dx, dy, during) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8 }],
    });
    if (i === 4 && during) await during();
    await new Promise((r) => setTimeout(r, 16)); // Gesture velocity, not a settling delay.
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const reducedMotion of ["reduce", "no-preference"]) {
  test(`fullscreen navigation whole-surface gestures and focus (${reducedMotion})`, async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion,
    });
    try {
      await page.goto(base);
      const menu = page.getByRole("button", { name: "Open menu", exact: true });
      const drawer = page.locator("#navigation-dialog");
      const cdp = await page.context().newCDPSession(page);
      const open = async () => {
        await menu.click();
        await rest(drawer);
      };
      const closed = async (navigating = false) => {
        await drawer.waitFor({ state: "hidden" });
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="Open menu"]').getAttribute("aria-expanded") ===
            "false",
        );
        if (!navigating)
          assert.equal(await menu.evaluate((e) => document.activeElement === e), true);
      };
      await open();
      const geometry = await drawer.evaluate((d) => {
        const rect = d.getBoundingClientRect(),
          content = d.querySelector(".navigation-content").getBoundingClientRect(),
          group = d.querySelector(".navigation-composition").getBoundingClientRect();
        const close = d.querySelector("button").getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          y: rect.y,
          centered: Math.abs(group.top + group.bottom - content.top - content.bottom) < 2,
          target: close.width >= 44 && close.height >= 44,
          dash: (() => {
            const dash = d.querySelector(".navigation-dash"),
              r = dash.getBoundingClientRect();
            return (
              r.width === 40 &&
              r.height === 6 &&
              Math.abs(r.left + r.right - rect.left - rect.right) < 2 &&
              rect.bottom - r.bottom >= 32 &&
              r.top - group.bottom >= 24 &&
              getComputedStyle(dash).position === "static"
            );
          })(),
        };
      });
      assert.deepEqual(geometry, {
        width: 390,
        height: 844,
        y: 0,
        centered: true,
        target: true,
        dash: true,
      });
      assert.equal(
        await drawer
          .getByRole("button", { name: "Close menu" })
          .evaluate((e) => e === document.activeElement),
        true,
      );
      // Fullscreen blank taps, opposite gestures and perpendicular gestures stay open.
      await page.touchscreen.tap(20, 760);
      assert.equal(await drawer.evaluate((d) => d.open), true);
      for (const [dx, dy] of [
        [0, 120],
        [120, 0],
        [0, -40],
      ]) {
        await swipe(cdp, 20, 600, dx, dy);
        await rest(drawer);
        assert.equal(
          await drawer.evaluate(
            (d) =>
              d.open &&
              !d.hasAttribute("data-dragging") &&
              !d.style.getPropertyValue("--swipe-offset"),
          ),
          true,
        );
      }
      // The dash is decorative: blank-area dragging still moves the whole dialog upward.
      await swipe(cdp, 20, 760, 0, -240, async () => {
        assert.ok(
          await drawer.evaluate(
            (d) => d.hasAttribute("data-dragging") && d.getBoundingClientRect().top < -50,
          ),
        );
      });
      await closed();
      await open();
      // Link-origin drags must dismiss without activating the route.
      const downloads = drawer.getByRole("link", { name: "Downloads", exact: true });
      let box = await downloads.boundingBox();
      const before = page.url();
      await swipe(cdp, box.x + box.width / 2, box.y + box.height / 2, 0, -240);
      await closed();
      assert.equal(page.url(), before);
      await open();
      // A subthreshold link drag must suppress its pointer click but not a later activation.
      box = await downloads.boundingBox();
      await swipe(cdp, box.x + box.width / 2, box.y + box.height / 2, 0, -40);
      await rest(drawer);
      assert.equal(page.url(), before);
      assert.equal(await drawer.evaluate((d) => d.open), true);
      await downloads.click(); // first pointer click in the shared suppression window
      assert.equal(await drawer.evaluate((d) => d.open), true);
      await downloads.click();
      // The Navigation API owns route-change focus resetting after native close.
      await closed(true);
      await page.waitForURL("**/?/downloads");
      await open();
      await page.keyboard.press("Escape");
      await closed();
      await open();
      await drawer.getByRole("button", { name: "Close menu" }).click();
      await closed();
      await open();
      await page.setViewportSize({ width: 667, height: 375 });
      await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      await rest(drawer);
      assert.equal(
        await drawer.evaluate((d) => {
          const r = d.getBoundingClientRect();
          return r.width === 667 && r.height === 375 && d.scrollWidth <= d.clientWidth;
        }),
        true,
      );
      await page.keyboard.press("Escape");
      await closed();
      // Early cancellation/reopen uses native dialog lifecycle, with no observer state.
      await menu.click();
      await page.keyboard.press("Escape");
      await closed();
    } finally {
      await browser.close();
    }
  });
}

async function overflowJourney(page, drawer, menu, cdp) {
  await drawer.locator(".navigation-composition").evaluate((e) => {
    const section = document.createElement("section");
    section.innerHTML =
      '<p class="caption">' +
      "Update failed. Retry when connected. ".repeat(30) +
      '</p><button class="menu-item">Retry update fixture</button>';
    e.append(section);
  });
  const documentTop = await page.evaluate(() => scrollY);
  await drawer.evaluate((d) => (d.scrollTop = 0));
  assert.equal(
    await drawer.evaluate(
      (d) =>
        d.scrollHeight > d.clientHeight &&
        d.scrollWidth <= d.clientWidth &&
        getComputedStyle(d).overflowY === "auto" &&
        [...d.querySelectorAll("*")].every(
          (e) => !["auto", "scroll"].includes(getComputedStyle(e).overflowY),
        ),
    ),
    true,
    "the dialog is the sole scrolling surface, with a reachable overflow start",
  );
  const close = drawer.locator(".navigation-controls button"),
    brand = drawer.locator(".navigation-brand");
  assert.ok((await close.boundingBox()).y >= 0);
  for (const control of await drawer.locator("nav a, section button, .navigation-dash").all()) {
    await control.scrollIntoViewIfNeeded();
    assert.equal(
      await control.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
      true,
    );
  }
  await drawer.evaluate((d) => (d.scrollTop = d.scrollHeight));
  assert.equal(
    await drawer.evaluate((d) => {
      const dash = d.querySelector(".navigation-dash").getBoundingClientRect();
      return (
        d.querySelector(".navigation-controls").getBoundingClientRect().bottom < 0 &&
        d.querySelector(".navigation-brand").getBoundingClientRect().bottom < 0 &&
        d.getBoundingClientRect().bottom - dash.bottom >= 31
      );
    }),
    true,
    "Close and brand scroll away; the dash has bottom breathing room",
  );
  await drawer.evaluate((d) => (d.scrollTop = 0));
  assert.ok((await close.boundingBox()).y >= 0);
  assert.ok((await brand.boundingBox()).y >= 0);
  // Reading reaches the bottom without transferring ownership mid-gesture.
  await drawer.evaluate((d) => {
    d.scrollTop = d.scrollHeight - d.clientHeight - 30;
    window.__readingEnded = false;
    const ended = (event) => {
      if (event.target === d && d.scrollHeight - d.clientHeight - d.scrollTop <= 1) {
        window.__readingEnded = true;
        d.removeEventListener("scrollend", ended);
      }
    };
    d.addEventListener("scrollend", ended);
  });
  await swipe(cdp, 100, 280, 0, -200);
  await page.waitForFunction(() => window.__readingEnded);
  assert.equal(
    await drawer.evaluate(
      (d) =>
        d.open &&
        !d.hasAttribute("data-dragging") &&
        d.scrollHeight - d.clientHeight - d.scrollTop <= 1,
    ),
    true,
  );
  assert.equal(await page.evaluate(() => scrollY), documentTop);
  await swipe(cdp, 100, 280, 0, -200);
  await drawer.waitFor({ state: "hidden" });
  await menu.click();
  await rest(drawer);
  assert.equal(
    await close.evaluate((e) => e === document.activeElement && e.getBoundingClientRect().top >= 0),
    true,
    "reopening reveals and focuses normal-flow Close",
  );
  assert.equal(await drawer.evaluate((d) => d.scrollTop === 0), true);
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
}

for (const reducedMotion of ["reduce", "no-preference"]) {
  for (const viewport of [
    { width: 320, height: 500 },
    { width: 667, height: 375 },
  ]) {
    test(`whole-dialog overflow, reading and reopen at 200% (${viewport.width}, ${reducedMotion})`, async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage({
        viewport,
        hasTouch: true,
        isMobile: true,
        reducedMotion,
      });
      try {
        await page.goto(base);
        await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
        const menu = page.getByRole("button", { name: "Open menu", exact: true });
        await menu.click();
        const drawer = page.locator("#navigation-dialog");
        await rest(drawer);
        const cdp = await page.context().newCDPSession(page);
        await overflowJourney(page, drawer, menu, cdp);
      } finally {
        await browser.close();
      }
    });
  }
}

test("styleguide shares fullscreen whole-surface upward dismissal", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    await page.goto(`${base}/styleguide.html`);
    const menu = page.getByRole("button", { name: "Open navigation specimen", exact: true });
    await menu.click();
    const drawer = page.locator("#guide-navigation");
    await rest(drawer);
    assert.equal(
      await drawer.evaluate((d) => d.getBoundingClientRect().height === innerHeight),
      true,
    );
    await page.touchscreen.tap(20, 760);
    assert.equal(await drawer.evaluate((d) => d.open), true);
    const cdp = await page.context().newCDPSession(page);
    await swipe(cdp, 20, 760, 0, -240);
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await menu.evaluate((e) => document.activeElement === e), true);
    await page.setViewportSize({ width: 320, height: 500 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    await menu.click();
    await rest(drawer);
    await overflowJourney(page, drawer, menu, cdp);
  } finally {
    await browser.close();
  }
});

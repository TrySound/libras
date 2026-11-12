const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:3003";

async function swipeUp(cdp, x, y, during) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - i * 25 }],
    });
    if (i === 4 && during) await during();
    await new Promise((resolve) => setTimeout(resolve, 16)); // Native gesture velocity.
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("fitting top navigation centers content and dismisses a link-origin upward swipe", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "no-preference",
  });
  try {
    await page.goto(base);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const drawer = page.locator("#navigation-dialog");
    await drawer.evaluate(async (d) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all(d.getAnimations().map((a) => a.finished));
    });
    assert.equal(
      await drawer.evaluate((d) => {
        const r = d.getBoundingClientRect(),
          body = d.querySelector(".sheet-body").getBoundingClientRect();
        const content = d.querySelector(".container-md").getBoundingClientRect(),
          handle = d.querySelector(".dialog-handle").getBoundingClientRect();
        return (
          r.width === innerWidth &&
          r.height === innerHeight &&
          r.top === 0 &&
          content.width <= 352 &&
          Math.abs(content.left + content.right - r.left - r.right) < 2 &&
          Math.abs(content.top + content.bottom - body.top - body.bottom) < 2 &&
          handle.width === 40 &&
          handle.height === 6 &&
          Math.abs(handle.left + handle.right - r.left - r.right) < 2 &&
          r.bottom - handle.bottom >= 32 &&
          handle.top - content.bottom >= 24
        );
      }),
      true,
    );
    const close = drawer.getByRole("button", { name: "Close menu", exact: true });
    await page.mouse.move(1, 1);
    await close.evaluate(async (e) => {
      e.blur();
      await Promise.all(e.getAnimations().map((a) => a.finished));
    });
    assert.equal(
      await close.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return (
          r.width >= 44 &&
          r.height >= 44 &&
          getComputedStyle(e).backgroundColor === "rgba(0, 0, 0, 0)"
        );
      }),
      true,
      "Close is an idle ghost with an accessible target",
    );
    await drawer.getByRole("link", { name: "Libras home", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await close.evaluate(
        (e) =>
          e === document.activeElement &&
          e.matches(":focus-visible") &&
          getComputedStyle(e).outlineStyle !== "none",
      ),
      true,
    );
    await page.touchscreen.tap(20, 760);
    assert.equal(await drawer.evaluate((d) => d.open), true, "blank space does not dismiss");
    const link = await drawer.getByRole("link", { name: "Downloads", exact: true }).boundingBox();
    const before = page.url(),
      cdp = await page.context().newCDPSession(page);
    await swipeUp(cdp, link.x + link.width / 2, link.y + link.height / 2, async () => {
      assert.ok(
        await drawer.evaluate((d) => d.getBoundingClientRect().top < -50),
        "the surface follows the finger upward",
      );
    });
    await drawer.waitFor({ state: "hidden" });
    assert.equal(page.url(), before, "dragging a link must not activate it");
  } finally {
    await browser.close();
  }
});

test("enlarged navigation scrolls as one surface before a new bottom-boundary swipe dismisses", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 320, height: 500 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    await page.goto(base);
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    await menu.click();
    const drawer = page.locator("#navigation-dialog"),
      close = drawer.getByRole("button", { name: "Close menu", exact: true });
    await drawer.locator(".container-md").evaluate((e) => {
      const section = document.createElement("section");
      section.innerHTML =
        '<p class="caption wrap-anywhere">' +
        "UnbrokenUpdateFailure".repeat(30) +
        '</p><button class="menu-item">Retry update fixture</button>';
      e.append(section);
    });
    const documentTop = await page.evaluate(() => scrollY);
    assert.equal(
      await drawer.evaluate(
        (d) =>
          d.scrollTop === 0 &&
          d.scrollHeight > d.clientHeight &&
          d.scrollWidth <= d.clientWidth &&
          getComputedStyle(d).overflowY === "auto" &&
          [...d.querySelectorAll("*")].every(
            (e) => !["auto", "scroll"].includes(getComputedStyle(e).overflowY),
          ),
      ),
      true,
      "only the dialog scrolls, with a reachable start and no horizontal overflow",
    );
    assert.ok((await close.boundingBox()).y >= 0);
    for (const control of [
      drawer.getByRole("button", { name: "Retry update fixture" }),
      drawer.locator(".dialog-handle"),
    ]) {
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
      await drawer.evaluate(
        (d) =>
          d.querySelector(".sheet-header").getBoundingClientRect().bottom < 0 &&
          d.querySelector(".brand").getBoundingClientRect().bottom < 0 &&
          d.getBoundingClientRect().bottom -
            d.querySelector(".dialog-handle").getBoundingClientRect().bottom >=
            31,
      ),
      true,
      "Close scrolls away and the final handle keeps its lower clearance",
    );
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
    const cdp = await page.context().newCDPSession(page);
    await swipeUp(cdp, 100, 280);
    await page.waitForFunction(() => window.__readingEnded);
    assert.equal(
      await drawer.evaluate((d) => d.open && d.scrollHeight - d.clientHeight - d.scrollTop <= 1),
      true,
      "reading to the boundary must not dismiss mid-gesture",
    );
    assert.equal(await page.evaluate(() => scrollY), documentTop);
    await swipeUp(cdp, 100, 280);
    await drawer.waitFor({ state: "hidden" });
    await menu.click();
    assert.equal(
      await close.evaluate(
        (e) => e === document.activeElement && e.getBoundingClientRect().top >= 0,
      ),
      true,
    );
    assert.equal(
      await drawer.evaluate((d) => d.scrollTop === 0),
      true,
      "reopening reveals Close rather than retaining the overflow end",
    );
  } finally {
    await browser.close();
  }
});

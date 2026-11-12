const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = (process.env.PREVIEW_URL ?? "http://127.0.0.1:3003").replace(/\/$/, "");
const longTitle = "A long title with " + "UnbrokenAlbumAndArtistTitle".repeat(5);

async function geometry(drawer, contentSelector) {
  return drawer.evaluate((d, selector) => {
    const content = d.querySelector(selector),
      r = d.getBoundingClientRect(),
      c = content.getBoundingClientRect();
    const cap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 22;
    return {
      fullWidth:
        Math.abs(r.width - innerWidth) < 1 ||
        Math.abs(r.width - document.documentElement.getBoundingClientRect().width) < 1,
      centered: Math.abs(c.left + c.right - r.left - r.right) < 2,
      capped: c.width <= cap + 1,
      fits: d.scrollWidth <= d.clientWidth + 1,
      bottom: Math.abs(r.bottom - innerHeight) < 1,
    };
  }, contentSelector);
}

test("top Close is idle ghost, retains keyboard feedback and shared centered cap", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    await page.goto(base);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const drawer = page.locator("#navigation-dialog"),
      close = drawer.getByRole("button", { name: "Close menu", exact: true });
    await page.mouse.move(5, 800);
    await close.evaluate((e) => e.blur());
    assert.equal(await close.getAttribute("data-variant"), "ghost");
    assert.equal(
      await close.evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgba(0, 0, 0, 0)",
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
    for (const [width, font] of [
      [1280, "100%"],
      [390, "100%"],
      [320, "200%"],
    ]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate((font) => (document.documentElement.style.fontSize = font), font);
      assert.deepEqual(await geometry(drawer, ".container-md"), {
        fullWidth: true,
        centered: true,
        capped: true,
        fits: true,
        bottom: true,
      });
      assert.equal(
        await close.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return r.width >= 44 && r.height >= 44 && r.right > innerWidth - 80;
        }),
        true,
      );
    }
  } finally {
    await browser.close();
  }
});

test("all four action consumers share the container utility in drawers and open popovers", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  try {
    await page.goto(base);
    for (const [route, id] of [
      ["?/library", "artist-menu"],
      ["?/library/album/missing", "album-detail-menu"],
      ["?/library/artist/missing", "artist-detail-menu"],
      ["?/search", "search-menu"],
    ]) {
      await page.evaluate((route) => window.navigation.navigate(route).finished, route);
      const drawer = page.locator(`#${id}`);
      await drawer.waitFor({ state: "attached" });
      // Geometry fixtures use the actual route's shared action markup, without
      // requiring an account/server; no actions or domain state are simulated.
      await drawer.evaluate((d, title) => {
        d.querySelector("h2").textContent = title;
        d.showModal();
      }, longTitle);
      for (const [width, font] of [
        [1280, "100%"],
        [390, "100%"],
        [320, "200%"],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((font) => (document.documentElement.style.fontSize = font), font);
        assert.deepEqual(
          await geometry(drawer, ":scope > .container-md"),
          { fullWidth: true, centered: true, capped: true, fits: true, bottom: true },
          `${id} at ${width}/${font}`,
        );
        assert.equal(
          await drawer.evaluate((d) => {
            const heading = d.querySelector("h2"),
              close = d.querySelector("header > button"),
              artwork = d.querySelector(".artwork");
            const c = close.getBoundingClientRect(),
              a = artwork.getBoundingClientRect(),
              content = d.querySelector(":scope > .container-md");
            return (
              content.classList.contains("container-md") &&
              parseFloat(getComputedStyle(content).maxInlineSize) ===
                22 * parseFloat(getComputedStyle(document.documentElement).fontSize) &&
              heading.scrollWidth <= heading.clientWidth + 1 &&
              c.width >= 44 &&
              a.width >= 48 &&
              heading.getBoundingClientRect().right <= c.left
            );
          }),
          true,
          `${id} long header remains readable with reachable Close`,
        );
      }
      for (const control of [
        drawer.locator("header > button"),
        drawer.locator(".menu-item").last(),
      ]) {
        await control.scrollIntoViewIfNeeded();
        assert.equal(
          await control.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
          true,
          `${id} Close and final action remain reachable at 200% text`,
        );
      }
      await drawer.getByRole("button", { name: "Close menu", exact: true }).click();
      await drawer.waitFor({ state: "hidden" });
      const popover = page.locator(".popover").first();
      await popover.locator("h2").evaluate((e) => (e.textContent = "Menu"));
      for (const [width, font] of [
        [1280, "100%"],
        [390, "100%"],
        [320, "200%"],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((font) => (document.documentElement.style.fontSize = font), font);
        await popover.evaluate((e) => e.showPopover());
        await popover.waitFor({ state: "visible" });
        assert.equal(
          await popover.evaluate((e) => {
            const content = e.firstElementChild,
              s = getComputedStyle(e),
              r = e.getBoundingClientRect(),
              c = content.getBoundingClientRect();
            const available =
              e.clientWidth - parseFloat(s.paddingInlineStart) - parseFloat(s.paddingInlineEnd);
            const left = r.left + e.clientLeft + parseFloat(s.paddingInlineStart);
            return (
              e.matches(":popover-open") &&
              content.classList.contains("container-md") &&
              parseFloat(getComputedStyle(content).maxInlineSize) ===
                22 * parseFloat(getComputedStyle(document.documentElement).fontSize) &&
              Math.abs(c.width - available) < 1 &&
              Math.abs(c.left + c.right - (2 * left + available)) < 1 &&
              content.scrollWidth <= content.clientWidth + 1 &&
              e.scrollWidth <= e.clientWidth + 1
            );
          }),
          true,
          `${id} open popover fills available content and remains centered without overflow at ${width}/${font}`,
        );
        await popover.getByRole("button", { name: "Close menu", exact: true }).click();
        await popover.waitFor({ state: "hidden" });
      }
      await page.evaluate(() => (document.documentElement.style.fontSize = "100%"));
    }
  } finally {
    await browser.close();
  }
});

test("bottom-sided handle has real dimensions, centering and spacing in block flow", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    await page.goto(`${base}/styleguide.html`);
    await page.getByRole("button", { name: "Open bottom drawer specimen", exact: true }).click();
    const geometry = await page.locator("#guide-bottom-drawer").evaluate((d) => {
      const content = d.querySelector(".container-md"),
        handle = d.querySelector(".dialog-handle");
      handle.dataset.side = "bottom";
      d.append(handle);
      const next = document.createElement("div");
      next.style.height = "1px";
      d.append(next);
      const r = handle.getBoundingClientRect(),
        p = d.getBoundingClientRect();
      return {
        blockFlow: getComputedStyle(d).display === "block",
        width: r.width,
        height: r.height,
        centered:
          Math.abs((r.left + r.right) / 2 - (p.left + d.clientLeft + d.clientWidth / 2)) < 1,
        before: r.top - content.getBoundingClientRect().bottom,
        after: next.getBoundingClientRect().top - r.bottom,
      };
    });
    assert.deepEqual(geometry, {
      blockFlow: true,
      width: 40,
      height: 6,
      centered: true,
      before: 24,
      after: 32,
    });
  } finally {
    await browser.close();
  }
});

test("shared handles keep bottom-sheet and player overlay placement", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    await page.goto(`${base}/styleguide.html`);
    for (const [name, id] of [
      ["Open bottom drawer specimen", "guide-bottom-drawer"],
      ["Open Now Playing specimen", "guide-player"],
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      const dialog = page.locator(`#${id}`);
      assert.equal(
        await dialog.locator(".dialog-handle").evaluate((e) => {
          const r = e.getBoundingClientRect(),
            parent = e.offsetParent.getBoundingClientRect();
          return (
            getComputedStyle(e).position === "absolute" &&
            r.width === 40 &&
            r.height === 6 &&
            Math.abs(r.top - parent.top - e.offsetParent.clientTop - 8) < 1
          );
        }),
        true,
        `${id} handle retains absolute top placement`,
      );
      assert.equal(
        await dialog.locator(".dialog-handle").evaluate((e) => {
          e.dataset.side = "top";
          const top = getComputedStyle(e).position === "absolute";
          e.dataset.side = "bottom";
          const style = getComputedStyle(e);
          const bottom =
            style.position === "static" &&
            style.marginBlockStart === "24px" &&
            style.marginBlockEnd === "32px";
          e.removeAttribute("data-side");
          return top && bottom;
        }),
        true,
        "handle placement follows its side attribute, not the dialog class",
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
  } finally {
    await browser.close();
  }
});

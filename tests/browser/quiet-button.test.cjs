const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium } = require("playwright");

const css = readFileSync(
  new URL("../../src/edgerunner.css", `file://${__filename}`),
  "utf8",
).replace(/@import[^;]+;/g, "");

async function fixture(browser, options = {}) {
  const page = await browser.newPage({ reducedMotion: "reduce", ...options });
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css} body { margin:0; }</style>
    <div class="app-root" style="height:400px">
      <div class="row-md" style="padding:24px">
        <button class="button-quiet" id="quiet"><span class="stack-xs">
          <span class="label text-secondary">Artist</span>
          <span class="caption text-subtle">Album</span>
        </span></button>
        <button class="button-quiet" id="disabled" disabled><span class="label">Disabled</span></button>
        <a class="button-quiet" id="unavailable" href="#" aria-disabled="true"><span class="label">Unavailable</span></a>
      </div>
    </div>`);
  return page;
}

async function colors(page, id = "quiet") {
  return page.locator(`#${id}`).evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      text: style.color,
      label: getComputedStyle(node.querySelector(".label")).color,
      caption: node.querySelector(".caption")
        ? getComputedStyle(node.querySelector(".caption")).color
        : undefined,
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      outline: style.outlineStyle,
      translate: style.translate,
    };
  });
}

async function tokenColor(page, token) {
  return page.locator(".app-root").evaluate((root, token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    root.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test("quiet controls tint nested text on hover/press without filling their background", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixture(browser);
    const quiet = page.locator("#quiet");
    const rest = await colors(page);
    const hover = await tokenColor(page, "--quiet-text-hover");
    const active = await tokenColor(page, "--quiet-text-active");
    await quiet.hover();
    const hovered = await colors(page);
    assert.notEqual(hovered.text, rest.text);
    assert.equal(hovered.text, hover);
    assert.equal(hovered.label, hover);
    assert.equal(hovered.caption, hover);
    await page.mouse.down();
    const pressed = await colors(page);
    assert.equal(pressed.text, active);
    assert.equal(pressed.label, active);
    assert.equal(pressed.caption, active);
    assert.equal(pressed.background, "rgba(0, 0, 0, 0)");
    assert.equal(pressed.backgroundImage, "none");
    await page.mouse.up();
    await page.mouse.move(500, 300);
    assert.equal((await colors(page)).label, rest.label);
    assert.equal((await colors(page)).caption, rest.caption);
    await page.keyboard.press("Tab");
    await quiet.focus();
    assert.notEqual((await colors(page)).outline, "none", "keyboard focus must remain visible");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.ok(
      await quiet.evaluate((node) => getComputedStyle(node).transitionProperty.includes("color")),
    );
    for (const id of ["disabled", "unavailable"]) {
      const before = await colors(page, id);
      await page.locator(`#${id}`).hover();
      await page.mouse.down();
      const after = await colors(page, id);
      assert.equal(after.text, before.text);
      assert.equal(after.label, before.label);
      assert.equal(after.translate, before.translate);
      await page.mouse.up();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await quiet.evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
  } finally {
    await browser.close();
  }
});

test("non-hovering devices skip hover tint but retain active feedback", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixture(browser, { isMobile: true, hasTouch: true });
    assert.equal(await page.evaluate(() => matchMedia("(hover: hover)").matches), false);
    const rest = await colors(page);
    await page.locator("#quiet").hover();
    assert.equal((await colors(page)).text, rest.text);
    await page.mouse.down();
    assert.equal((await colors(page)).label, await tokenColor(page, "--quiet-text-active"));
    await page.mouse.up();
    assert.equal((await colors(page)).text, rest.text);
  } finally {
    await browser.close();
  }
});

test("time-based feedback uses sine easing with unchanged durations; scroll depth stays linear", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await fixture(browser, { reducedMotion: "no-preference" });
    await page.locator(".app-root").evaluate((root) => {
      root.insertAdjacentHTML(
        "beforeend",
        `
        <button class="button">Action</button><input class="input"><input class="switch" type="checkbox">
        <a class="menu-item" href="#">Row</a><span class="artwork"></span>
        <article class="tile"><span class="artwork tile-artwork"><img alt=""></span></article>
        <span class="loader"><i class="loader-bar"></i><i class="loader-bar"></i><i class="loader-bar"></i></span>
        <dialog class="bottom-sheet">Sheet</dialog><dialog class="large-player">Player</dialog>
        <div class="popover" popover>Tooltip / popover</div>
        <div class="app-stage" style="height:2400px"><div class="atmosphere-frame"><div class="atmosphere-lines"></div></div></div>`,
      );
    });
    const sine = "cubic-bezier(0.445, 0.05, 0.55, 0.95)";
    const transition = async (selector, pseudo = null) =>
      page
        .locator(selector)
        .first()
        .evaluate((node, pseudo) => {
          const style = getComputedStyle(node, pseudo);
          return {
            duration: style.transitionDuration,
            delay: style.transitionDelay,
            easing: style.transitionTimingFunction,
          };
        }, pseudo);
    const expectTransition = async (selector, duration, pseudo = null) => {
      const result = await transition(selector, pseudo);
      assert.equal(result.duration, duration, selector);
      assert.ok(
        result.delay.split(", ").every((delay) => delay === "0s"),
        selector,
      );
      assert.equal(
        result.easing,
        duration
          .split(", ")
          .map(() => sine)
          .join(", "),
        selector,
      );
    };
    for (const selector of [".button-quiet", ".button", ".switch"])
      await expectTransition(selector, "0.12s, 0.08s, 0.08s");
    await expectTransition(".switch", "0.12s", "::before");
    await expectTransition(".input", "0.12s");
    await expectTransition(".menu-item", "0.12s, 0.12s, 0.08s, 0.08s");
    await expectTransition(".artwork", "0.18s");
    await expectTransition(".tile", "0.12s, 0.08s, 0.08s, 0.18s");
    await expectTransition(".tile-artwork img", "0.4s");
    for (const selector of [".bottom-sheet", ".large-player"]) {
      await expectTransition(selector, "0.12s, 0.12s, 0.12s");
      await page.locator(selector).evaluate((node) => node.showModal());
      await expectTransition(selector, "0.2s");
      if (selector === ".bottom-sheet") await expectTransition(selector, "0.2s", "::backdrop");
      await page.locator(selector).evaluate((node) => node.close());
    }
    await expectTransition(".bottom-sheet", "0.12s, 0.12s, 0.12s", "::backdrop");
    await expectTransition(".popover", "0.08s, 0.08s, 0.08s, 0.08s");
    await page.locator(".popover").evaluate((node) => node.showPopover());
    await expectTransition(".popover", "0.12s");
    const waves = await page.locator(".loader-bar").evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return [style.animationTimingFunction, style.animationDuration, style.animationDelay];
      }),
    );
    assert.deepEqual(waves, [
      [sine, "1.5s", "0s"],
      [sine, "1.5s", "0.2s"],
      [sine, "1.5s", "0.4s"],
    ]);
    assert.equal(
      await page
        .locator(".atmosphere-lines")
        .evaluate((node) => getComputedStyle(node).animationTimingFunction),
      "linear",
    );
    await page.evaluate(() => (document.documentElement.dataset.routeTransition = ""));
    assert.equal((await transition(".tile-artwork img")).duration, "0s");
    await page.evaluate(() => delete document.documentElement.dataset.routeTransition);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal((await transition(".button")).duration, "0s");
    assert.equal((await transition(".tile-artwork img")).duration, "0s");
    assert.equal(
      await page
        .locator(".loader-bar")
        .first()
        .evaluate((node) => getComputedStyle(node).animationName),
      "none",
    );
    assert.equal(
      await page
        .locator(".atmosphere-lines")
        .evaluate((node) => getComputedStyle(node).animationName),
      "none",
    );
  } finally {
    await browser.close();
  }
});

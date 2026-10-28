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

// Actual app shell in the production demo, including touch navigation and native Back.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "")}/`;
const sine = "cubic-bezier(0.445, 0.05, 0.55, 0.95)";

// Auto-generated match-element names cannot be addressed through getComputedStyle.
// Inspect the actual browser pseudo tree instead of assigning synthetic shell names.
async function shellSnapshots(cdp, layer) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const groups = [];
  function walk(node) {
    if (node.pseudoType === "view-transition-group") groups.push(node);
    for (const key of ["children", "pseudoElements"])
      for (const child of node[key] ?? []) walk(child);
  }
  walk(root);
  async function style(node) {
    const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", {
      nodeId: node.nodeId,
    });
    return Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
  }
  for (const group of groups) {
    if ((await style(group))["z-index"] !== layer) continue;
    const pair = [...(group.children ?? []), ...(group.pseudoElements ?? [])][0];
    const result = {};
    for (const node of [...(pair.children ?? []), ...(pair.pseudoElements ?? [])])
      result[node.pseudoType] = await style(node);
    return result;
  }
  throw new Error("No actual shell snapshot group found");
}

async function pixelDifference(page, before, after) {
  return page.evaluate(
    async ([before, after]) => {
      async function pixels(source) {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      }
      const a = await pixels(before),
        b = await pixels(after);
      let total = 0,
        changed = 0;
      for (let index = 0; index < a.length; index += 4) {
        const deltas = [0, 1, 2].map((channel) =>
          Math.abs(a[index + channel] - b[index + channel]),
        );
        total += deltas.reduce((sum, value) => sum + value, 0);
        if (Math.max(...deltas) > 8) changed++;
      }
      return { mean: total / ((a.length / 4) * 3), changed: changed / (a.length / 4) };
    },
    [before.toString("base64"), after.toString("base64")],
  );
}

for (const mobile of [true, false]) {
  test(
    `${mobile ? "touch header" : "desktop sidebar"} remains stationary and continuously painted through artist/Back`,
    { timeout: 60000 },
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: mobile ? 390 : 1280, height: 844 },
          isMobile: mobile,
          hasTouch: mobile,
          deviceScaleFactor: 1,
          reducedMotion: "no-preference",
        });
        await page.route("https://cdn-images.dzcdn.net/**", (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#75402e"/><circle cx="300" cy="300" r="220" fill="#d2ab63"/></svg>',
          }),
        );
        await page.addInitScript(() => {
          window.captureCount = 0;
          const original = document.startViewTransition.bind(document);
          document.startViewTransition = (update) => {
            window.captureCount++;
            const transition = original(update);
            window.captureReady = transition.ready.then(() => {
              window.captureAnimations = document
                .getAnimations()
                .filter((animation) =>
                  animation.effect?.pseudoElement?.startsWith("::view-transition"),
                );
              for (const animation of window.captureAnimations) {
                animation.pause();
                animation.currentTime = 0;
              }
            });
            window.captureFinished = transition.finished;
            return transition;
          };
        });
        await page.goto(new URL("demo/", base).href);
        await page.locator(".tile a").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        const selector = mobile ? ".app-header" : ".app-sidebar";
        const shell = page.locator(selector);
        await shell.evaluate((node) => (window.originalShell = node));
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const layer = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--layer-header").trim(),
        );
        for (const scroll of mobile ? [0, 420] : [0]) {
          await page.evaluate((scroll) => scrollTo(0, scroll), scroll);
          const link = page.locator(".tile a").nth(scroll ? 4 : 0);
          await link.scrollIntoViewIfNeeded();
          await page.waitForTimeout(100);
          const savedScroll = await page.evaluate(() => scrollY);
          const bounds = await shell.boundingBox();
          assert.equal(bounds.y, 0);
          const before = await page.screenshot({ clip: bounds });
          for (const direction of ["forward", "back"]) {
            if (direction === "back") await page.goBack();
            else if (mobile) await link.tap();
            else await link.click();
            await page.evaluate(() => window.captureReady);
            const snapshots = await shellSnapshots(cdp, layer);
            for (const type of ["view-transition-old", "view-transition-new"]) {
              assert.equal(snapshots[type]["animation-name"], "none");
              assert.equal(snapshots[type]["mix-blend-mode"], "normal");
              assert.equal(snapshots[type].opacity, type === "view-transition-new" ? "1" : "0");
            }
            const content = await page.evaluate(() => {
              const root = getComputedStyle(
                document.documentElement,
                "::view-transition-new(root)",
              );
              const cover = getComputedStyle(
                document.documentElement,
                "::view-transition-group(artist-artwork)",
              );
              return {
                root: [root.animationDuration, root.animationDelay, root.animationTimingFunction],
                cover: [cover.animationDuration, cover.animationTimingFunction],
              };
            });
            assert.deepEqual(content.root, ["0.2s", "0.12s", sine]);
            assert.deepEqual(content.cover, ["0.24s", sine]);
            for (const time of [0, 80, 160, 240, 310]) {
              await page.evaluate(async (time) => {
                for (const animation of window.captureAnimations) animation.currentTime = time;
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
              }, time);
              assert.equal(await shell.evaluate((node) => node === window.originalShell), true);
              assert.equal(
                await shell.evaluate((node) => getComputedStyle(node).viewTransitionName),
                "match-element",
              );
              assert.deepEqual(await shell.boundingBox(), bounds);
              const frame = await page.screenshot({
                clip: bounds,
                path: process.env.EVIDENCE_DIR
                  ? `${process.env.EVIDENCE_DIR}/header-test-${mobile ? "touch" : "desktop"}-${scroll}-${direction}-${time}.png`
                  : undefined,
              });
              if (time === 160 && process.env.EVIDENCE_DIR)
                await page.screenshot({
                  path: `${process.env.EVIDENCE_DIR}/header-test-${mobile ? "touch" : "desktop"}-${scroll}-${direction}-full.png`,
                });
              const delta = await pixelDifference(page, before, frame);
              assert.ok(
                delta.mean < 1 && delta.changed < 0.001,
                `${direction} ${time}ms: ${JSON.stringify(delta)}`,
              );
            }
            await page.evaluate(() => {
              for (const animation of window.captureAnimations) animation.play();
            });
            await page.evaluate(() => window.captureFinished);
            if (direction === "back")
              assert.ok(Math.abs((await page.evaluate(() => scrollY)) - savedScroll) <= 1);
          }
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        const count = await page.evaluate(() => window.captureCount);
        await page.locator(".tile a").first().scrollIntoViewIfNeeded();
        if (mobile) await page.locator(".tile a").first().tap();
        else await page.locator(".tile a").first().click();
        await page.locator(".detail-panel h1").waitFor();
        assert.equal(await page.evaluate(() => window.captureCount), count);
      } finally {
        await browser.close();
      }
    },
  );
}

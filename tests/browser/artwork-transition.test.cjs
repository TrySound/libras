// Real-engine capture regression; Linux WebKit is not macOS Safari.
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const css = readFileSync(
  new URL("../../src/edgerunner.css", `file://${__filename}`),
  "utf8",
).replace(/@import[^;]+;/g, "");
const src =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#b36030"/><circle cx="300" cy="300" r="230" fill="#1d4548"/><path d="M0 0L600 600M600 0L0 600" stroke="#ffc584" stroke-width="60"/></svg>',
  );
for (const [engine, type] of Object.entries({ chromium, webkit })) {
  test(`${engine}: artwork movement is 400ms without changing page or hover timings`, async () => {
    const browser = await type.launch({ headless: true });
    try {
      const page = await browser.newPage({ reducedMotion: "no-preference" });
      await page.setContent(`<style>${css}</style><div class="app-root">
        <span class="artwork tile-artwork" style="view-transition-name:cover"><img alt=""></span>
        <div class="view-slide-up" style="view-transition-name:up">Up</div>
        <div class="view-slide-left" style="view-transition-name:left">Left</div>
        <div class="view-shell" style="view-transition-name:shell">Shell</div>
      </div>`);
      const timings = await page.evaluate(async () => {
        const transition = document.startViewTransition(() => {
          document.querySelector(".artwork").style.width = "100px";
        });
        await transition.ready;
        const timing = (pseudo) => {
          const style = getComputedStyle(document.documentElement, pseudo);
          return {
            duration: style.animationDuration,
            delay: style.animationDelay,
            easing: style.animationTimingFunction,
          };
        };
        const result = {
          artwork: timing("::view-transition-group(cover)"),
          rootOld: timing("::view-transition-old(root)"),
          rootNew: timing("::view-transition-new(root)"),
          upOld: timing("::view-transition-old(up)"),
          upNew: timing("::view-transition-new(up)"),
          leftOld: timing("::view-transition-old(left)"),
          leftNew: timing("::view-transition-new(left)"),
          shell: getComputedStyle(document.documentElement, "::view-transition-group(shell)")
            .animationName,
          hover: getComputedStyle(document.querySelector(".tile-artwork img")).transitionDuration,
        };
        transition.skipTransition();
        await transition.finished;
        return result;
      });
      assert.deepEqual(timings.artwork, { duration: "0.4s", delay: "0s", easing: "linear" });
      assert.equal(timings.rootOld.duration, "0.12s");
      assert.equal(timings.rootOld.delay, "0s");
      assert.equal(timings.rootNew.duration, "0.2s");
      assert.equal(timings.rootNew.delay, "0.12s");
      for (const key of ["upOld", "leftOld"])
        assert.deepEqual(timings[key], { duration: "0.12s", delay: "0s", easing: "linear" });
      for (const key of ["upNew", "leftNew"])
        assert.deepEqual(timings[key], { duration: "0.2s", delay: "0.12s", easing: "linear" });
      assert.equal(timings.shell, "none");
      assert.equal(timings.hover, "0.4s");
    } finally {
      await browser.close();
    }
  });
  for (const width of [1280, 390]) {
    test(
      `${engine} ${width}: stationary cropped artwork and bounded warm capture time`,
      { timeout: 60000 },
      async () => {
        const browser = await type.launch({ headless: true });
        try {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          await page.setContent(
            `<style>${css}body{margin:0}.tile{width:220px;height:220px}.app-stage{min-height:6000px}.detail-panel{display:block}.detail-panel>.artwork{width:320px;height:320px}</style><div class="app-root"><div class="app-stage"></div></div>`,
          );
          const samples = [];
          for (let i = 0; i < 4; i++) {
            await page.evaluate((src) => {
              document.querySelector(".app-stage").innerHTML =
                `<article class="tile"><span class="artwork tile-artwork" data-size="fill" style="view-transition-name:artist-artwork"><img src="${src}"></span><div class="tile-content">Artist</div><a class="link-target" href="#artist" aria-label="Artist"></a></article>`;
            }, src);
            await page.locator(".link-target").hover();
            await page.waitForTimeout(450);
            const geometry = await page.locator(".tile-artwork").evaluate((node) => {
              const style = getComputedStyle(node);
              return {
                radius: style.borderRadius,
                parentRadius: getComputedStyle(node.parentElement).borderRadius,
                scale: style.scale,
                clip: style.overflow,
                imageScale: getComputedStyle(node.querySelector("img")).scale,
              };
            });
            assert.equal(geometry.radius, geometry.parentRadius);
            assert.equal(geometry.clip, "clip");
            assert.ok(["none", "1"].includes(geometry.scale));
            // Linux WebKit currently misses scoped :has() hover invalidation;
            // still require the stationary crop, and verify zoom in Chromium.
            if (engine === "chromium") assert.equal(geometry.imageScale, "1.04");
            if (i === 0 && process.env.EVIDENCE_DIR)
              await page.screenshot({
                path: `${process.env.EVIDENCE_DIR}/${engine}-${width}-hover.png`,
              });
            await page.evaluate((src) => {
              document.querySelector(".link-target").onclick = (event) => {
                event.preventDefault();
                const start = performance.now();
                document.documentElement.dataset.routeTransition = "";
                window.settledScale = getComputedStyle(
                  document.querySelector(".tile-artwork img"),
                ).scale;
                const transition = document.startViewTransition(() => {
                  window.times = { callback: performance.now() - start };
                  document.querySelector(".app-stage").innerHTML =
                    `<div class="atmosphere-frame"><img class="atmosphere" src="${src}" alt=""><div class="atmosphere-lines"></div></div><div class="detail-panel"><span class="artwork" data-size="cover" style="view-transition-name:artist-artwork"><img src="${src}" alt=""></span></div>`;
                  window.times.dom = performance.now() - start;
                });
                window.ready = transition.ready.then(() => {
                  window.times.ready = performance.now() - start;
                  // Freeze a genuine transition frame for deterministic visual evidence.
                  for (const animation of document.getAnimations()) {
                    if (animation.effect?.pseudoElement?.startsWith("::view-transition")) {
                      animation.pause();
                      animation.currentTime = 160;
                    }
                  }
                });
                window.done = transition.finished.then(() => {
                  window.times.finished = performance.now() - start;
                  delete document.documentElement.dataset.routeTransition;
                });
              };
            }, src);
            await page.locator(".link-target").click();
            await page.evaluate(() => window.ready);
            assert.equal(await page.evaluate(() => window.settledScale), "1");
            assert.equal(
              await page.locator(".atmosphere").evaluate((node) => getComputedStyle(node).filter),
              "blur(6px)",
            );
            if (i === 0 && process.env.EVIDENCE_DIR)
              await page.screenshot({
                path: `${process.env.EVIDENCE_DIR}/${engine}-${width}-mid.png`,
              });
            await page.evaluate(() => {
              for (const animation of document.getAnimations()) animation.play();
            });
            await page.evaluate(() => window.done);
            samples.push(await page.evaluate(() => window.times));
          }
          // Generous noise allowance, but rejects the multi-second SVG capture regression.
          for (const sample of samples.slice(1))
            assert.ok(sample.ready < 1800, JSON.stringify(sample));
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.evaluate((src) => {
            document.querySelector(".app-stage").innerHTML =
              `<div class="tile"><span class="artwork tile-artwork" data-size="fill"><img src="${src}"></span><a class="link-target" href="#artist"></a></div>`;
          }, src);
          await page.locator(".link-target").hover();
          assert.ok(
            ["none", "1"].includes(
              await page
                .locator(".tile-artwork img")
                .evaluate((node) => getComputedStyle(node).scale),
            ),
          );
          if (process.env.EVIDENCE_DIR)
            writeFileSync(
              `${process.env.EVIDENCE_DIR}/${engine}-${width}-capture.json`,
              JSON.stringify(samples, null, 2),
            );
        } finally {
          await browser.close();
        }
      },
    );
  }
}

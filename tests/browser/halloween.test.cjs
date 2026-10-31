// Optional real-browser coverage; uses the same setup as edgerunner.test.cjs.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

const base = `${(process.env.PREVIEW_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "")}/`;

test("hardcoded Halloween theme preserves default foundations", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(base);
    await page.locator(".app-root").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "halloween");
    const styles = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const app = getComputedStyle(document.querySelector(".app-root"));
      return {
        rootAccent: root.getPropertyValue("--accent").trim(),
        appAccent: app.getPropertyValue("--accent").trim(),
        corner: app.getPropertyValue("--corner-shape").trim(),
        canvas: getComputedStyle(document.documentElement).backgroundImage,
        atmosphere: getComputedStyle(document.querySelector(".atmosphere-lines")).backgroundImage,
        atmosphereRepeat: getComputedStyle(document.querySelector(".atmosphere-lines"))
          .backgroundRepeat,
        atmosphereSize: getComputedStyle(document.querySelector(".atmosphere-lines"))
          .backgroundSize,
        web: app.getPropertyValue("--halloween-web-bg"),
        heading: getComputedStyle(document.querySelector("h1")).fontFamily,
        brand: getComputedStyle(document.querySelector(".brand")).fontFamily,
        fontLoaded: [...document.fonts].some(
          (font) => font.family === "Creepster" && font.status === "loaded",
        ),
      };
    });
    assert.equal(styles.rootAccent, "#ff9b38");
    assert.equal(styles.appAccent, styles.rootAccent);
    assert.equal(styles.corner, "scoop");
    assert.doesNotMatch(styles.canvas, /data:image\/svg\+xml/);
    assert.match(styles.atmosphere, /data:image\/svg\+xml/);
    assert.equal((styles.atmosphere.match(/url\(/g) ?? []).length, 1);
    assert.equal(styles.atmosphereRepeat, "no-repeat");
    assert.equal(styles.atmosphereSize, "720px 720px");
    assert.match(styles.web, /right -70px top -100px/);
    assert.equal(
      await page.locator(".switch").evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
      "6px",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const switchColors = await page.locator(".switch").evaluate((el) => {
      const checked = el.checked;
      el.checked = true;
      const colors = {
        track: getComputedStyle(el).backgroundColor,
        thumb: getComputedStyle(el, "::before").backgroundColor,
      };
      el.checked = checked;
      return colors;
    });
    assert.equal(switchColors.track, "rgb(72, 36, 12)");
    assert.equal(switchColors.thumb, "rgb(255, 155, 56)");
    const web = decodeURIComponent(styles.web);
    assert.match(web, /Q18-54/); // Curved, hanging threads rather than rigid rings.
    assert.match(web, /<ellipse/); // Knots where rings meet the radial spokes.
    assert.equal((web.match(/<use /g) ?? []).length, 5);
    assert.ok(
      await page.evaluate(async () => {
        const background = getComputedStyle(
          document.querySelector(".atmosphere-lines"),
        ).backgroundImage;
        const url = background.match(/url\("([^"]+)"\)/)[1];
        const image = new Image();
        image.src = url;
        await image.decode();
        return image.naturalWidth === 720 && image.naturalHeight === 720;
      }),
    );
    assert.match(styles.heading, /Creepster/);
    assert.match(styles.brand, /Creepster/);
    assert.ok(styles.fontLoaded);
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    // Removing the declarative opt-in restores the original app tokens.
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    assert.equal(
      await page
        .locator(".app-root")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim()),
      "#efbf04",
    );
    await page.goto(new URL("styleguide.html", base).href);
    assert.equal(await page.locator("html").getAttribute("data-theme"), null);
    assert.match(
      await page.locator("h1").evaluate((el) => getComputedStyle(el).fontFamily),
      /Rajdhani/,
    );
  } finally {
    await browser.close();
  }
});

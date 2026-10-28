// Native fullscreen player with real cache/playback; only Subsonic is intercepted.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

// A real, silent WAV lets browser audio and Media Session run without external media.
function silence() {
  const samples = 8000 * 120;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

test("Now Playing preserves audio, queue occurrences, responsive layout and native dismissal", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const artist = { id: "artist", name: "Artist and guest artist" };
  const songs = Array.from({ length: 24 }, (_, i) => ({
    id: `track-${i}`,
    title: `Track ${i} with a long title that wraps`,
    albumId: "album",
    artists: [artist],
    duration: 120,
    contentType: "audio/wav",
  }));
  const audio = silence();
  await page.route("https://player.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const method = url.pathname.split("/").pop().replace(".view", "");
    if (["stream", "download"].includes(method)) {
      await route.fulfill({ contentType: "audio/wav", body: audio });
      return;
    }
    let fields = {};
    if (method === "ping")
      fields = { version: "1.16.1", type: "test", serverVersion: "1", openSubsonic: true };
    else if (method === "getIndexes") fields = { indexes: { lastModified: 1 } };
    else if (method === "getPlaylists") fields = { playlists: { playlist: [] } };
    else if (method === "getPlayQueue")
      fields = {
        playQueue: {
          entry: [songs[0], songs[1], songs[0], ...songs.slice(2)],
          current: "track-0",
          position: 15000,
        },
      };
    else if (method === "search3")
      fields = {
        searchResult3: {
          artist: Number(url.searchParams.get("artistOffset")) === 0 ? [artist] : [],
          album:
            Number(url.searchParams.get("albumOffset")) === 0
              ? [{ id: "album", name: "Album", artists: [artist] }]
              : [],
          song: Number(url.searchParams.get("songOffset")) === 0 ? songs : [],
        },
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }),
    });
  });
  try {
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = new Proxy(NativeAudio, {
        construct(target, args) {
          const audio = new target(...args);
          window.__audio = audio;
          return audio;
        },
      });
    });
    await page.goto(base);
    await page.getByLabel("Host", { exact: true }).fill("https://player.example.test");
    await page.getByLabel("Username", { exact: true }).fill("listener");
    await page.getByLabel("Password", { exact: true }).fill("fictional-password");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const opener = page.getByRole("button", { name: "Open Now Playing", exact: true });
    await opener.waitFor();
    await page.locator(".tile a").first().click();
    await page.getByRole("link", { name: "Open Album", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 400));
    const scroll = await page.evaluate(() => window.scrollY);
    assert.ok(scroll > 0);
    const route = page.url();
    await opener.click();
    const dialog = page.locator("#player-dialog");
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.evaluate((node) => node.matches(":modal")), true);
    assert.equal(await dialog.locator(".track-row").count(), 25);
    assert.equal(await dialog.locator('.track-row[aria-current="true"]').count(), 1);
    const seek = dialog.getByRole("slider", { name: "Playback position" });
    assert.equal(await seek.inputValue(), "15");
    await page.mouse.move(1300, 700);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.scrollY), scroll, "the modal contains scrolling");
    await dialog.evaluate((node) => {
      node.scrollTop = 0;
    });
    await seek.focus();
    await page.keyboard.press("ArrowRight");
    assert.ok(Number(await seek.inputValue()) > 15);
    await dialog.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => window.__audio && !window.__audio.paused);
    await dialog.locator(".track-row").nth(2).getByRole("button").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#player-dialog .track-row")[2].getAttribute("aria-current") ===
        "true",
    );
    const audioNode = await page.evaluateHandle(() => window.__audio);
    for (const [width, height] of [
      [1440, 900],
      [768, 900],
      [393, 852],
      [320, 740],
      [900, 390],
    ]) {
      await page.setViewportSize({ width, height });
      const layout = await dialog.evaluate((node) => {
        const panel = node.querySelector(".viewport-panel");
        const cover = node.querySelector(".viewport-panel-cover");
        const queue = node.querySelector('[aria-label="Queue"]');
        const p = panel.getBoundingClientRect(),
          q = queue.getBoundingClientRect();
        return {
          width: node.clientWidth,
          overflow: node.scrollWidth > node.clientWidth,
          beside: q.left >= p.right,
          cover: getComputedStyle(cover).display !== "none",
          height: node.clientHeight,
        };
      });
      assert.equal(layout.overflow, false, `no horizontal overflow at ${width}`);
      assert.equal(layout.beside, layout.width > 800);
      if (height < 400) assert.equal(layout.cover, false);
      assert.ok(layout.height <= height);
      assert.equal(await audioNode.evaluate((node) => node === window.__audio), true);
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await dialog.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    assert.equal(
      await dialog.locator(".topbar").evaluate((node) => node.getBoundingClientRect().top),
      0,
    );
    await page.keyboard.press("Escape");
    assert.equal(page.url(), route);
    assert.equal(await opener.evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.__audio.paused), false);
    await opener.click();
    await dialog.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.evaluate(() => {
      const node = document.querySelector("#player-dialog .topbar");
      const touch = (y) => new Touch({ identifier: 1, target: node, clientX: 80, clientY: y });
      node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(30)] }));
      node.dispatchEvent(
        new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [touch(250)] }),
      );
      node.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          changedTouches: [touch(250)],
        }),
      );
    });
    assert.equal(await dialog.isVisible(), false);
    await opener.click();
    await dialog.getByRole("button", { name: "Clear", exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog.getByText("The queue is empty.", { exact: true }).waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: "Play", exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

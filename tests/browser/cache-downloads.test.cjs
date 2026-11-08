// Real OPFS atomic-close/reopen evidence. Run against Vite dev (imports the owning module).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const base = process.env.PREVIEW_URL ?? "http://127.0.0.1:5173";

test("Cache unified downloads reconcile native OPFS failure boundaries", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(base);
    for (const stage of ["bytes", "catalog"]) {
      await t.test(stage, async () => {
        const result = await page.evaluate(async (stage) => {
          const { Cache, downloadKey } = await import("/src/cache.svelte.ts");
          const cache = new Cache(`native-opfs-${crypto.randomUUID()}`);
          const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
          const key = downloadKey(track.id, "mp3");
          const original = FileSystemFileHandle.prototype.createWritable;
          let bytesClosed = false;
          FileSystemFileHandle.prototype.createWritable = async function (...args) {
            const writable = await original.apply(this, args);
            const close = writable.close.bind(writable);
            const name = this.name;
            writable.close = async () => {
              if (
                (stage === "bytes" && name.endsWith(".audio")) ||
                (stage === "catalog" && bytesClosed && name === "downloads.json")
              )
                throw new DOMException("Injected boundary interruption", "UnknownError");
              await close();
              if (name.endsWith(".audio")) bytesClosed = true;
            };
            return writable;
          };
          let rejected = false;
          try {
            await cache.saveDownload(
              track,
              "mp3",
              "audio/mpeg",
              new Response("native audio bytes"),
              new AbortController().signal,
            );
          } catch {
            rejected = true;
          } finally {
            FileSystemFileHandle.prototype.createWritable = original;
          }
          const reopen = new Cache(cache.key);
          await reopen.load();
          const file = await reopen.readDownload(track.id, "mp3");
          return {
            rejected,
            completed: [...reopen.downloads.values()].filter(
              (entry) => entry.status === "completed",
            ).length,
            pending: reopen.downloads.get(key)?.status === "queued" ? "queued" : null,
            text: file ? await file.text() : null,
          };
        }, stage);
        assert.equal(result.rejected, true);
        if (stage === "bytes")
          assert.deepEqual(result, {
            rejected: true,
            completed: 0,
            pending: "queued",
            text: null,
          });
        else
          assert.deepEqual(result, {
            rejected: true,
            completed: 1,
            pending: null,
            text: "native audio bytes",
          });
      });
    }
    await t.test(
      "document reload restores native intent into FIFO scheduling without refetching saved files",
      async () => {
        const key = await page.evaluate(async () => {
          const { Cache } = await import("/src/cache.svelte.ts");
          const { getAccountKey } = await import("/src/auth.ts");
          const key = getAccountKey({
            host: "https://music.example",
            username: `opfs-${crypto.randomUUID()}`,
          });
          const cache = new Cache(key);
          const track = { id: "saved", title: "Track", artist: "Artist", album: "Album" };
          await cache.saveDownload(
            track,
            "mp3",
            "audio/mpeg",
            new Response("saved audio"),
            new AbortController().signal,
          );
          for (const id of ["first", "second", "third", "fourth", "fifth", "sixth"])
            await cache.enqueueDownload({ ...track, id }, "mp3", "audio/mpeg");
          return key;
        });
        await page.reload();
        const result = await page.evaluate(async (key) => {
          const { Cache } = await import("/src/cache.svelte.ts");
          const { TrackEngine } = await import("/src/track.svelte.ts");
          const { getAccountKey } = await import("/src/auth.ts");
          const [host, username] = JSON.parse(key);
          const account = { host, username };
          if (getAccountKey(account) !== key) throw new Error("Unexpected account key");
          const cache = new Cache(key);
          await cache.load();
          const requests = [];
          let active = 0;
          let peak = 0;
          const engine = new TrackEngine({
            selection: { cache },
            connection: {
              account,
              signal: new AbortController().signal,
              async read(id) {
                requests.push(id);
                active++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 20));
                active--;
                return new Response("audio");
              },
            },
          });
          try {
            await engine.restoreDownloads();
            const deadline = Date.now() + 10000;
            while (
              ([...cache.downloads.values()].filter((entry) => entry.status === "completed")
                .length !== 7 ||
                [...cache.downloads.values()].some((entry) => entry.status === "queued")) &&
              Date.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              requests,
              peak,
              completed: [...cache.downloads.values()].filter(
                (entry) => entry.status === "completed",
              ).length,
              pending: [...cache.downloads.values()].filter((entry) => entry.status === "queued")
                .length,
            };
          } finally {
            engine.destroy();
          }
        }, key);
        assert.deepEqual(result.requests, ["first", "second", "third", "fourth", "fifth", "sixth"]);
        assert.equal(result.peak, 3);
        assert.equal(result.completed, 7);
        assert.equal(result.pending, 0);
      },
    );
    await t.test("intent close is the enqueue acknowledgement", async () => {
      const result = await page.evaluate(async () => {
        const { Cache } = await import("/src/cache.svelte.ts");
        const cache = new Cache(`native-intent-${crypto.randomUUID()}`);
        const original = FileSystemFileHandle.prototype.createWritable;
        let started;
        let release;
        const closing = new Promise((resolve) => {
          started = resolve;
        });
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
          const writable = await original.apply(this, args);
          if (this.name === "downloads.json") {
            const close = writable.close.bind(writable);
            writable.close = async () => {
              started();
              await gate;
              await close();
            };
          }
          return writable;
        };
        let acknowledged = false;
        try {
          const saving = cache
            .enqueueDownload(
              { id: "track", title: "Track", artist: "Artist", album: "Album" },
              "mp3",
              "audio/mpeg",
            )
            .then(() => {
              acknowledged = true;
            });
          await closing;
          const before = { acknowledged, size: cache.downloads.size };
          release();
          await saving;
          const reopen = new Cache(cache.key);
          await reopen.load();
          return { before, after: reopen.downloads.size };
        } finally {
          release();
          FileSystemFileHandle.prototype.createWritable = original;
        }
      });
      assert.deepEqual(result, { before: { acknowledged: false, size: 0 }, after: 1 });
    });
  } finally {
    await browser.close();
  }
});

test("document destruction before byte close never promotes native OPFS partial bytes", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let page = await context.newPage();
  try {
    await page.goto(base);
    const key = await page.evaluate(async () => {
      const { Cache } = await import("/src/cache.svelte.ts");
      const key = `destroyed-page-${crypto.randomUUID()}`;
      const cache = new Cache(key);
      const original = FileSystemFileHandle.prototype.createWritable;
      let reached;
      const closing = new Promise((resolve) => {
        reached = resolve;
      });
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const writable = await original.apply(this, args);
        if (this.name.endsWith(".audio"))
          writable.close = async () => {
            reached();
            await new Promise(() => {});
          };
        return writable;
      };
      void cache
        .saveDownload(
          { id: "partial", title: "Partial", artist: "Artist", album: "Album" },
          "mp3",
          "audio/mpeg",
          new Response("unclosed audio"),
          new AbortController().signal,
        )
        .catch(() => {});
      await closing;
      return key;
    });
    await page.close();
    page = await context.newPage();
    await page.goto(base);
    const result = await page.evaluate(async (key) => {
      const { Cache } = await import("/src/cache.svelte.ts");
      const cache = new Cache(key);
      await cache.load();
      return {
        completed: [...cache.downloads.values()].filter((entry) => entry.status === "completed")
          .length,
        pending: [...cache.downloads.values()].filter((entry) => entry.status === "queued").length,
        file: await cache.readDownload("partial", "mp3"),
      };
    }, key);
    assert.deepEqual(result, { completed: 0, pending: 1, file: null });
  } finally {
    await browser.close();
  }
});

test("native OPFS completed-only migration close preserves input and reopens canonical state", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { Cache } = await import("/src/cache.svelte.ts");
      const cache = new Cache(`native-migration-${crypto.randomUUID()}`);
      const track = { id: "saved", title: "Saved", artist: "Artist", album: "Album" };
      await cache.saveDownload(
        track,
        "mp3",
        "audio/mpeg",
        new Response("saved bytes"),
        new AbortController().signal,
      );
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cache.key));
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const accounts = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("accounts");
      const directory = await accounts.getDirectoryHandle(hash);
      const handle = await directory.getFileHandle("downloads.json");
      const saved = [...cache.downloads.values()][0];
      const legacy = JSON.stringify([
        {
          track: { id: "saved", title: "Saved", artist: "Artist", album: "Album" },
          format: "mp3",
          contentType: "audio/mpeg",
          fileName: saved.fileName,
          size: saved.size,
          downloadedAt: saved.downloadedAt,
        },
      ]);
      const write = async (name, text) => {
        const writable = await (
          await directory.getFileHandle(name, { create: true })
        ).createWritable();
        await writable.write(text);
        await writable.close();
      };
      await write("downloads.json", legacy);
      const original = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const writable = await original.apply(this, args);
        if (this.name === "downloads.json")
          writable.close = async () => {
            throw new DOMException("Denied", "NotAllowedError");
          };
        return writable;
      };
      const interrupted = new Cache(cache.key);
      let rejected = false;
      let playable;
      try {
        await interrupted.load().catch(() => {
          rejected = true;
        });
        playable = await (await interrupted.readDownload("saved", "mp3"))?.text();
      } finally {
        FileSystemFileHandle.prototype.createWritable = original;
      }
      const preserved = (await (await handle.getFile()).text()) === legacy;
      const migrated = new Cache(cache.key);
      await migrated.load();

      const reopened = new Cache(cache.key);
      await reopened.load();
      return {
        rejected,
        playable,
        preserved,
        version: JSON.parse(await (await handle.getFile()).text()).version,
        count: reopened.downloads.size,
        saved: await (await reopened.readDownload("saved", "mp3"))?.text(),
      };
    });
    assert.deepEqual(result, {
      rejected: true,
      playable: "saved bytes",
      preserved: true,
      version: 2,
      count: 1,
      saved: "saved bytes",
    });
  } finally {
    await browser.close();
  }
});

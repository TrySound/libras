import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache, downloadKey } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example", username: "listener" };

// Exercise the shared implementation through both configurations, not an exported
// test-only catalog API. Their document formats and record identities stay distinct.
function domain(name: "images" | "downloads", cache: Cache) {
  return {
    records: () => (name === "images" ? cache.images : cache.downloads),
    key: (id: string) => (name === "images" ? id : downloadKey(id, "mp3")),
    read: async (id: string) =>
      name === "images"
        ? ((await cache.readImage(id))?.blob ?? null)
        : cache.readDownload(id, "mp3"),
    save: (id: string, value: string, signal = new AbortController().signal) =>
      name === "images"
        ? cache.saveImage(id, { blob: new Blob([value]), type: "image/png" }, signal)
        : cache.saveDownload(
            { id, title: id, artist: "Artist", album: "Album" },
            "mp3",
            "audio/mpeg",
            new Response(value),
            signal,
          ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["images", "downloads"] as const)("shared binary catalog: %s", (name) => {
  it("orders byte acquisition behind hydration", async () => {
    const disk = installDisk();
    const seed = domain(name, new Cache(account));
    await seed.save("item", "bytes");
    const reading = deferred<void>();
    const release = deferred<void>();
    disk.state.beforeRead = async (path) => {
      if (path.endsWith(`/${name}.json`)) {
        reading.resolve();
        await release.promise;
      }
    };
    const cache = new Cache(account);
    const restored = domain(name, cache);
    const loading = cache.load();
    await reading.promise;
    let acquired = false;
    const bytes = restored.read("item").then((file) => {
      acquired = true;
      return file;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(restored.records().size).toBe(0);
    release.resolve();
    await loading;
    expect(await (await bytes)!.text()).toBe("bytes");
  });

  it("repairs only a missing reference, retaining unrelated records and bytes", async () => {
    const disk = installDisk();
    const store = domain(name, new Cache(account));
    await store.save("missing", "first");
    await store.save("kept", "second");
    const missing = store.records().get(store.key("missing"))!.fileName;
    const path = [...disk.blobs.keys()].find((path) => path.endsWith(`/${missing}`))!;
    disk.blobs.delete(path);
    expect(await store.read("missing")).toBeNull();
    expect([...store.records().keys()]).toEqual([store.key("kept")]);
    expect(await (await store.read("kept"))!.text()).toBe("second");
    expect(disk.blobs.size).toBe(1);
    const cache = new Cache(account);
    await cache.load();
    expect([...domain(name, cache).records().keys()]).toEqual([store.key("kept")]);
  });

  it("retains committed bytes without late publication when cancelled during catalog close", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const store = domain(name, cache);
    await store.save("kept", "old");
    const controller = new AbortController();
    disk.state.afterClose = (path) => {
      if (path.endsWith(`/${name}.json`)) controller.abort();
    };
    await expect(store.save("late", "new", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect([...store.records().keys()]).toEqual([store.key("kept")]);
    expect(name === "images" ? cache.imagesError : cache.downloadsError).toBeUndefined();
    expect(disk.blobs.size).toBe(2);
    const restored = new Cache(account);
    await restored.load();
    expect(await (await domain(name, restored).read("late"))!.text()).toBe("new");
  });
});

it("keeps image operations independent of an active audio transfer", async () => {
  const disk = installDisk();
  const cache = new Cache(account);
  const writing = deferred<void>();
  disk.state.beforeWrite = (path) => {
    if (path.endsWith(".audio")) writing.resolve();
  };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const audio = cache.saveDownload(
    { id: "track", title: "Track", artist: "Artist", album: "Album" },
    "mp3",
    "audio/mpeg",
    new Response(body),
    new AbortController().signal,
  );
  source.enqueue(new TextEncoder().encode("audio"));
  await writing.promise;
  const images = domain("images", cache);
  await images.save("cover", "image");
  expect(await (await images.read("cover"))!.text()).toBe("image");
  expect(cache.downloads.size).toBe(0);
  source.close();
  expect(await (await audio).text()).toBe("audio");
  expect(cache.downloads.size).toBe(1);
});

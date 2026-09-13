import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache, downloadKey } from "../src/cache.svelte";
import { flushSync } from "svelte";
import { observeCache } from "./cache-reactivity.test.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example", username: "listener" };

// Exercise the shared implementation through both configurations, not an exported
// test-only catalog API. Their document formats and record identities stay distinct.
function domain(name: "images" | "downloads", cache: Cache) {
  return {
    flush: () => cache.flush(),
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["images", "downloads"] as const)("shared binary catalog: %s", (name) => {
  it("updates live views reactively without invalidating unrelated existing keys", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const store = domain(name, cache);
    await store.save("kept", "first");
    const records = store.records();
    const keyed = vi.fn(() => store.records().get(store.key("kept")));
    const listed = vi.fn(() => [...store.records().values()]);
    const sized = vi.fn(() => store.records().size);
    const stop = observeCache(() => {
      keyed();
    });
    const stopList = observeCache(() => {
      listed();
    });
    const stopSize = observeCache(() => {
      sized();
    });
    try {
      flushSync();
      await store.save("added", "second");
      flushSync();
      expect(store.records()).toBe(records);
      expect(records.size).toBe(2);
      expect(keyed).toHaveBeenCalledOnce();
      expect(listed).toHaveBeenCalledTimes(2);
      expect(sized).toHaveBeenCalledTimes(2);
      const fileName = records.get(store.key("kept"))!.fileName;
      disk.blobs.delete([...disk.blobs.keys()].find((path) => path.endsWith(fileName))!);
      await store.read("kept");
      flushSync();
      expect(keyed).toHaveBeenCalledTimes(2);
      expect(keyed.mock.results.at(-1)!.value).toBeUndefined();
      expect(listed).toHaveBeenCalledTimes(3);
      expect(sized.mock.results.at(-1)!.value).toBe(1);
      await store.flush();
    } finally {
      stop();
      stopList();
      stopSize();
    }
  });

  it("keeps an in-flight checkpoint separate from subsequent catalog mutations", async () => {
    vi.useFakeTimers();
    const disk = installDisk();
    const cache = new Cache(account);
    const store = domain(name, cache);
    await store.save("first", "first");
    const closing = deferred<void>();
    const release = deferred<void>();
    disk.state.beforeClose = async (path) => {
      if (path.endsWith(`/${name}.json`)) {
        closing.resolve();
        await release.promise;
      }
    };
    const saving = store.flush();
    await closing.promise;
    await store.save("second", "second");
    release.resolve();
    await saving;
    const path = [...disk.files.keys()].find((path) => path.endsWith(`/${name}.json`))!;
    expect(JSON.parse(disk.files.get(path)!)).toHaveLength(1);
    expect(store.records().size).toBe(2);
    expect(cache.dirty).toBe(true);
    await store.flush();
    expect(JSON.parse(disk.files.get(path)!)).toHaveLength(2);
    expect(cache.dirty).toBe(false);
  });

  it("does not traverse a 20,907-record catalog when adding records", async () => {
    vi.useFakeTimers();
    const disk = installDisk();
    const seed = domain(name, new Cache(account));
    await seed.save("seed", "bytes");
    await seed.flush();
    const path = [...disk.files.keys()].find((path) => path.endsWith(`/${name}.json`))!;
    const [sample] = JSON.parse(disk.files.get(path)!);
    disk.files.set(
      path,
      JSON.stringify(
        Array.from({ length: 20_907 }, (_, index) => ({
          ...sample,
          ...(name === "images"
            ? { id: String(index) }
            : { track: { ...sample.track, id: String(index) } }),
          fileName: `${index.toString(16)}.${name === "images" ? "image" : "audio"}`,
        })),
      ),
    );
    const cache = new Cache(account);
    await cache.load();
    const store = domain(name, cache);
    const records = store.records();
    const iterate = vi.spyOn(records, Symbol.iterator);
    const values = vi.spyOn(records, "values");
    for (let index = 0; index < 20; index++) await store.save(`new-${index}`, "bytes");
    expect(store.records()).toBe(records);
    expect(records.size).toBe(20_927);
    expect(iterate).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
    await store.flush();
    expect(values).toHaveBeenCalledOnce();
    expect(JSON.parse(disk.files.get(path)!)).toHaveLength(20_927);
  });

  it("orders byte acquisition behind hydration", async () => {
    const disk = installDisk();
    const seed = domain(name, new Cache(account));
    await seed.save("item", "bytes");
    await seed.flush();
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
    await store.flush();
    const cache = new Cache(account);
    await cache.load();
    expect([...domain(name, cache).records().keys()]).toEqual([store.key("kept")]);
  });

  it("does not tie checkpoints to a completed caller's cancellation signal", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const store = domain(name, cache);
    await store.save("kept", "old");
    const controller = new AbortController();
    disk.state.afterClose = (path) => {
      if (path.endsWith(`/${name}.json`)) controller.abort();
    };
    await store.save("late", "new", controller.signal);
    await store.flush();
    expect(controller.signal.aborted).toBe(true);
    expect([...store.records().keys()]).toEqual([store.key("kept"), store.key("late")]);
    expect(cache.error).toBeUndefined();
    expect(disk.blobs.size).toBe(2);
    const restored = new Cache(account);
    await restored.load();
    expect(await (await domain(name, restored).read("late"))!.text()).toBe("new");
  });
});

it("replaces image records reactively without mutating an in-flight checkpoint", async () => {
  vi.useFakeTimers();
  const disk = installDisk();
  const cache = new Cache(account);
  await cache.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" });
  const records = cache.images;
  const original = records.get("cover")!;
  const seen = vi.fn(() => cache.images.get("cover")?.etag);
  const stop = observeCache(() => {
    seen();
  });
  try {
    flushSync();
    const closing = deferred<void>();
    const release = deferred<void>();
    disk.state.beforeClose = async (path) => {
      if (path.endsWith("/images.json")) {
        closing.resolve();
        await release.promise;
      }
    };
    const saving = cache.flush();
    await closing.promise;
    await cache.updateImage("cover", original.fileName, { etag: "updated" });
    flushSync();
    expect(cache.images).toBe(records);
    expect(original.etag).toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.results.at(-1)!.value).toBe("updated");
    release.resolve();
    await saving;
    const path = [...disk.files.keys()].find((path) => path.endsWith("/images.json"))!;
    expect(JSON.parse(disk.files.get(path)!)[0].etag).toBeUndefined();
    expect(cache.dirty).toBe(true);
    await cache.flush();
    expect(JSON.parse(disk.files.get(path)!)[0].etag).toBe("updated");
    expect(cache.dirty).toBe(false);
  } finally {
    stop();
  }
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

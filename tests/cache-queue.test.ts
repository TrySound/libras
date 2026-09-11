import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { Cache, CacheLoadError, type CachedQueue, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { observeCache } from "./cache-reactivity.test.svelte";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const queue = (position = 10): CachedQueue => ({
  tracks: ["unknown", "song", "song"],
  index: 2,
  position,
});
const library: LibrarySnapshot = {
  artists: [{ id: "artist", name: "Artist", genres: [] }],
  albums: [],
  tracks: [],
  savedAt: 100,
  lastModified: 10,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function queuePath(disk: ReturnType<typeof installDisk>) {
  return [...disk.files.keys()].find((path) => path.endsWith("/queue.json"))!;
}

describe("queue cache", () => {
  it("starts empty and a clean flush performs no I/O", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    expect(cache.queue).toEqual({ tracks: [], index: -1, position: 0 });
    expect(cache.queueDirty).toBe(false);
    expect(cache.queueError).toBeUndefined();
    expect(await cache.flush()).toBe(cache.queueRevision);
    expect(disk.getDirectory).not.toHaveBeenCalled();
  });

  it("publishes a copied reactive queue before persistence and restores duplicate occurrences without metadata", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const seen: unknown[] = [];
    const stop = observeCache(() => {
      seen.push({ queue: cache.queue, dirty: cache.queueDirty });
    });
    try {
      flushSync();
      const input = queue();
      const revision = cache.setQueue(input);
      input.tracks.length = 0;
      input.index = -1;
      input.position = 0;
      flushSync();
      expect(cache.queue).toEqual(queue());
      expect(disk.files.size).toBe(0);
      expect(seen).toEqual([
        { queue: { tracks: [], index: -1, position: 0 }, dirty: false },
        { queue: queue(), dirty: true },
      ]);
      expect(await cache.flush()).toBe(revision);
      flushSync();
      expect(seen.at(-1)).toEqual({ queue: queue(), dirty: false });
      const path = queuePath(disk);
      expect(path).toMatch(/^accounts\/[a-f0-9]{64}\/queue\.json$/);
      expect(JSON.parse(disk.files.get(path) ?? "null")).toEqual({
        value: queue(),
        updatedAt: 1_000,
      });
      const restored = new Cache(account);
      await restored.load();
      expect(restored.queue).toEqual(queue());
      expect(restored.queueDirty).toBe(false);
      expect(restored.tracks.size).toBe(0);
      expect(disk.files.size).toBe(1);
    } finally {
      stop();
    }
  });

  it("debounces edits for 300ms and leaves no redundant checkpoint timer", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.load();
    cache.setQueue(queue(10));
    await vi.advanceTimersByTimeAsync(100);
    cache.setQueue(queue(20));
    await vi.advanceTimersByTimeAsync(299);
    expect(disk.state.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.state.writes).toBe(1);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null").value.position).toBe(20);
    expect(cache.queueDirty).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checkpoints continuous position updates at least every five seconds", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.load();
    cache.setQueue(queue(0));
    for (let i = 1; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(100);
      cache.setQueue(queue(i));
    }
    expect(disk.state.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(disk.state.writes).toBe(1);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null").value.position).toBe(49);
  });

  it("keeps the original five-second deadline for checkpoint-only edits", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.load();
    cache.setQueue(queue(0), { checkpoint: true });
    await vi.advanceTimersByTimeAsync(4_999);
    cache.setQueue({ ...cache.queue, position: 5 }, { checkpoint: true });
    expect(disk.state.writes).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.state.writes).toBe(1);
    expect(cache.queueDirty).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null").value).toEqual(queue(5));
  });

  it("copies incoming queue state before adoption and clears superseded checkpoints", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    cache.setQueue(queue(10));
    const incoming = queue(20);
    const adopted = cache.replaceQueue(incoming, new AbortController().signal);
    incoming.tracks.length = 0;
    incoming.index = -1;
    incoming.position = 0;
    expect(cache.queue).toEqual(queue(10));
    expect(await adopted).toBe(true);
    expect(cache.queue).toEqual(queue(20));
    expect(cache.queueDirty).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null").value).toEqual(queue(20));
    const writes = disk.state.writes;
    expect(await cache.flush()).toBe(cache.queueRevision);
    expect(disk.state.writes).toBe(writes);
  });

  it("repairs a cancelled adoption from the still-visible queue after document close", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    cache.setQueue(queue(10));
    await cache.flush();
    const revision = cache.queueRevision;
    const controller = new AbortController();
    disk.state.afterClose = (path) => {
      if (path.endsWith("/queue.json")) controller.abort();
    };
    expect(await cache.replaceQueue(queue(20), controller.signal)).toBe(false);
    expect(cache.queue).toEqual(queue(10));
    expect(cache.queueRevision).toBe(revision);
    expect(cache.queueDirty).toBe(true);
    expect(cache.queueError).toBeUndefined();
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null").value).toEqual(queue(20));
    expect(await cache.flush()).toBe(revision);
    expect(cache.queueDirty).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null").value).toEqual(queue(10));
  });

  it("coalesces overlapping flushes without rewriting library.json", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary(library);
    const original = [...disk.files][0]!;
    const revision = cache.setQueue(queue());
    expect(await Promise.all([cache.flush(), cache.flush()])).toEqual([revision, revision]);
    expect(disk.state.writes).toBe(2);
    expect(disk.files.get(original[0])).toBe(original[1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("acknowledges only the revision committed when a new edit arrives during a write", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async () => {
      closing.resolve();
      await release.promise;
    };
    const first = cache.setQueue(queue(10));
    const saved = cache.flush();
    await closing.promise;
    const second = cache.setQueue(queue(20));
    release.resolve();
    expect(await saved).toBe(first);
    expect(cache.queueRevision).toBe(second);
    expect(cache.queueDirty).toBe(true);
    expect(cache.queue.position).toBe(20);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null")).toEqual({
      value: queue(10),
      updatedAt: 1_000,
    });
    expect(vi.getTimerCount()).toBe(2);
    expect(await cache.flush()).toBe(second);
    expect(cache.queueDirty).toBe(false);
    expect(JSON.parse(disk.files.get(queuePath(disk)) ?? "null")).toEqual({
      value: queue(20),
      updatedAt: 1_001,
    });
  });

  it.each(["before", "during"])("preserves local edits made %s loading", async (when) => {
    const disk = installDisk();
    const initial = new Cache(account);
    initial.setQueue(queue(10));
    await initial.flush();
    const cache = new Cache(account);
    const reading = deferred();
    const release = deferred();
    disk.state.beforeRead = async (path) => {
      if (path.endsWith("/queue.json")) {
        reading.resolve();
        await release.promise;
      }
    };
    if (when === "before") cache.setQueue(queue(20));
    const loaded = cache.load();
    await reading.promise;
    if (when === "during") cache.setQueue(queue(20));
    release.resolve();
    await loaded;
    expect(cache.queue.position).toBe(20);
    expect(cache.queueDirty).toBe(true);
    await cache.flush();
    expect(cache.queueDirty).toBe(false);
  });

  it("preserves optimistic edits and the previous disk record on failure, then retries explicitly", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    cache.setQueue(queue(10));
    await cache.flush();
    const path = queuePath(disk);
    const original = disk.files.get(path);
    const revision = cache.setQueue(queue(20));
    disk.state.failClose = true;
    await expect(cache.flush()).rejects.toThrow("Storage full");
    expect(cache.queueError).toBeInstanceOf(Error);
    expect(cache.queueDirty).toBe(true);
    expect(cache.queue.position).toBe(20);
    expect(disk.files.get(path)).toBe(original);
    disk.state.failClose = false;
    expect(await cache.flush()).toBe(revision);
    expect(cache.queueError).toBeUndefined();
    expect(cache.queueDirty).toBe(false);
  });

  it("reports background failures without an unhandled rejection or automatic retry loop", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.load();
    const close = vi.fn(async () => {});
    disk.state.beforeClose = close;
    disk.state.failClose = true;
    cache.setQueue(queue());
    await vi.advanceTimersByTimeAsync(300);
    expect(cache.queueError).toBeInstanceOf(Error);
    expect(cache.queueDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(close).toHaveBeenCalledOnce();
    disk.state.failClose = false;
    await cache.flush();
    expect(cache.queueError).toBeUndefined();
  });

  it("reports a newer disk queue as a conflict, not a successful checkpoint or local replacement", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    first.setQueue(queue(10));
    vi.setSystemTime(2_000);
    const other = new Cache(account);
    other.setQueue(queue(20));
    await other.flush();
    const original = disk.files.get(queuePath(disk));
    await expect(first.flush()).rejects.toThrow("newer queue");
    expect(first.queue.position).toBe(10);
    expect(first.queueDirty).toBe(true);
    expect(disk.files.get(queuePath(disk))).toBe(original);
    vi.setSystemTime(3_000);
    first.setQueue(queue(30));
    await first.flush();
    expect(first.queueError).toBeUndefined();
    expect(first.queueDirty).toBe(false);
  });

  it("keeps checkpoint timestamps monotonic after loading and clock rollback", async () => {
    const disk = installDisk();
    const initial = new Cache(account);
    initial.setQueue(queue());
    await initial.flush();
    const cache = new Cache(account);
    await cache.load();
    vi.setSystemTime(500);
    cache.setQueue(queue(20));
    await cache.flush();
    expect(JSON.parse(disk.files.get(queuePath(disk))!).updatedAt).toBe(1_001);
  });

  it.each(["library", "queue", "both"])(
    "restores independent domains when %s is corrupt",
    async (corrupt) => {
      const disk = installDisk();
      const initial = new Cache(account);
      await initial.replaceLibrary(library);
      initial.setQueue(queue());
      await initial.flush();
      const queueFile = queuePath(disk);
      const libraryFile = [...disk.files.keys()].find((path) => path.endsWith("/library.json"))!;
      if (corrupt !== "queue") disk.files.set(libraryFile, "bad library");
      if (corrupt !== "library") disk.files.set(queueFile, "bad queue");
      const original = [...disk.files];
      const cache = new Cache(account);
      const error = await cache.load().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CacheLoadError);
      if (!(error instanceof CacheLoadError)) throw new Error("Expected a load error");
      expect(Object.keys(error.failures)).toEqual(
        corrupt === "both" ? ["library", "queue"] : [corrupt],
      );
      expect(cache.artists.size).toBe(corrupt === "queue" ? 1 : 0);
      expect(cache.queue).toEqual(
        corrupt === "library" ? queue() : { tracks: [], index: -1, position: 0 },
      );
      expect(cache.queueError).toBe(error.failures.queue);
      expect([...disk.files]).toEqual(original);
      await cache.replaceLibrary(library);
      expect(cache.queueError).toBe(error.failures.queue);
      cache.setQueue(queue());
      await cache.flush();
      await expect(cache.load()).resolves.toBeUndefined();
      expect(cache.queueError).toBeUndefined();
    },
  );

  it.each(["unexpected field", "invalid selection", "invalid timestamp", "flat record"])(
    "rejects a persisted %s and preserves the file until an explicit edit",
    async (kind) => {
      const disk = installDisk();
      const cache = new Cache(account);
      cache.setQueue(queue());
      await cache.flush();
      const path = queuePath(disk);
      const value = JSON.parse(disk.files.get(path) ?? "null");
      if (kind === "unexpected field") value.unexpected = true;
      if (kind === "invalid selection") value.value.index = 99;
      if (kind === "invalid timestamp") value.updatedAt = -1;
      const corrupt = JSON.stringify(
        kind === "flat record" ? { ...value.value, updatedAt: value.updatedAt } : value,
      );
      disk.files.set(path, corrupt);
      const previous = cache.queue;
      await expect(cache.load()).rejects.toBeInstanceOf(CacheLoadError);
      expect(cache.queue).toBe(previous);
      expect(disk.files.get(path)).toBe(corrupt);
      cache.setQueue(queue(20));
      await cache.flush();
      expect(cache.queueError).toBeUndefined();
      expect(JSON.parse(disk.files.get(path) ?? "null").value.index).toBe(2);
    },
  );

  it("cancels loading without publishing a stale queue or recording a storage error", async () => {
    const disk = installDisk();
    const initial = new Cache(account);
    initial.setQueue(queue());
    await initial.flush();
    const cache = new Cache(account);
    const reading = deferred();
    const release = deferred();
    disk.state.beforeRead = async () => {
      reading.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const loaded = cache.load(controller.signal);
    await reading.promise;
    controller.abort();
    release.resolve();
    await expect(loaded).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.queue.index).toBe(-1);
    expect(cache.queueError).toBeUndefined();
    await cache.load();
    expect(cache.queue).toEqual(queue());
  });

  it("does not block queue checkpoints behind library writes", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async (path) => {
      if (path.endsWith("/library.json")) {
        closing.resolve();
        await release.promise;
      }
    };
    const savingLibrary = cache.replaceLibrary(library);
    await closing.promise;
    cache.setQueue(queue());
    await cache.flush();
    expect(cache.queueDirty).toBe(false);
    expect(cache.savedAt).toBeUndefined();
    release.resolve();
    await savingLibrary;
  });

  it("isolates account queues with overlapping track IDs", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache({ ...account, username: "other" });
    first.setQueue(queue(10));
    second.setQueue(queue(20));
    await Promise.all([first.flush(), second.flush()]);
    await Promise.all([first.load(), second.load()]);
    expect(first.queue.position).toBe(10);
    expect(second.queue.position).toBe(20);
    expect(disk.files.size).toBe(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { Cache, CacheLoadError, downloadKey } from "./cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { observeCache } from "./cache-reactivity.test.svelte";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example", username: "listener" };
const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
const key = downloadKey(track.id, "mp3");
const signal = () => new AbortController().signal;
function save(cache: Cache, text = "audio", abort = signal()) {
  return cache.saveDownload(track, "mp3", "audio/mpeg", new Response(text), abort);
}
function path(disk: ReturnType<typeof installDisk>) {
  return [...disk.files.keys()].find((name) => name.endsWith("/downloads.json"))!;
}
function catalog(disk: ReturnType<typeof installDisk>) {
  return JSON.parse(disk.files.get(path(disk))!);
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  return { response: new Response(body), controller, cancel };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("download cache foundation", () => {
  it("restores independent descriptions without library metadata or eager binary reads", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const file = await save(cache);
    expect(await file.text()).toBe("audio");
    expect(cache.downloads.get(key)).toMatchObject({
      track,
      format: "mp3",
      contentType: "audio/mpeg",
      size: 5,
    });
    expect(catalog(disk)).toEqual({ account, downloads: [...cache.downloads.values()] });
    expect(catalog(disk).downloads[0]).not.toHaveProperty("key");
    expect(disk.blobs.size).toBe(1);
    const reads: string[] = [];
    disk.state.beforeRead = async (name) => {
      reads.push(name);
    };
    const restored = new Cache(account);
    await restored.load();
    expect(restored.artists.size).toBe(0);
    expect(restored.downloads).toEqual(cache.downloads);
    expect(reads.some((name) => name.endsWith(".audio"))).toBe(false);
    const bytes = vi.spyOn(File.prototype, "arrayBuffer");
    expect(await restored.readDownload(track.id, "mp3")).toBeInstanceOf(File);
    expect(bytes).not.toHaveBeenCalled();
    expect(await restored.readDownload(track.id, "raw")).toBeNull();
  });

  it("streams chunks and publishes reactively only after binary and catalog close", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const source = stream();
    const seen: number[] = [];
    const stop = observeCache(() => seen.push(cache.downloads.size));
    flushSync();
    const gate = deferred();
    const closing = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith("/downloads.json")) {
        closing.resolve();
        await gate.promise;
      }
    };
    const pending = cache.saveDownload(track, "mp3", "audio/mpeg", source.response, signal());
    source.controller.enqueue(new TextEncoder().encode("first "));
    source.controller.enqueue(new TextEncoder().encode("second"));
    source.controller.close();
    await closing.promise;
    flushSync();
    expect(seen.every((count) => count === 0)).toBe(true);
    expect(disk.blobs.size).toBe(1);
    expect(await [...disk.blobs.values()][0].text()).toBe("first second");
    gate.resolve();
    await pending;
    flushSync();
    expect(seen.filter((count) => count > 0)).toEqual([1]);
    stop();
  });

  it.each(["stream", "binary", "catalog", "empty"])(
    "cleans uncommitted files on %s failure and allows retry",
    async (stage) => {
      const disk = installDisk();
      const cache = new Cache(account);
      disk.state.beforeClose = async (name) => {
        if (
          (stage === "binary" && name.endsWith(".audio")) ||
          (stage === "catalog" && name.endsWith("/downloads.json"))
        )
          throw new Error("Storage full");
      };
      const source = stream();
      const response =
        stage === "stream" ? source.response : new Response(stage === "empty" ? "" : "audio");
      const pending = cache.saveDownload(track, "mp3", "audio/mpeg", response, signal());
      if (stage === "stream") {
        source.controller.enqueue(new TextEncoder().encode("partial"));
        source.controller.error(new Error("Truncated stream"));
      }
      await expect(pending).rejects.toThrow();
      expect(cache.downloads.size).toBe(0);
      expect(cache.downloadsError).toBeDefined();
      expect(disk.blobs.size).toBe(0);
      expect([...disk.files.keys()].some((name) => name.endsWith(".audio"))).toBe(false);
      disk.state.beforeClose = async () => {};
      expect(await (await save(cache)).text()).toBe("audio");
      expect(cache.downloadsError).toBeUndefined();
    },
  );

  it("cancels an active stream and deletes its partial file", async () => {
    const disk = installDisk();
    const source = stream();
    const cache = new Cache(account);
    const abort = new AbortController();
    const wrote = deferred();
    disk.state.beforeWrite = (name) => {
      if (name.endsWith(".audio")) wrote.resolve();
    };
    const pending = cache.saveDownload(track, "mp3", "audio/mpeg", source.response, abort.signal);
    source.controller.enqueue(new TextEncoder().encode("partial"));
    await wrote.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(cache.downloads.size).toBe(0);
    expect(cache.downloadsError).toBeUndefined();
    expect(disk.blobs.size).toBe(0);
    expect(disk.files.size).toBe(0);
  });

  it.each(["beforeWrite", "afterClose"] as const)(
    "handles cancellation at catalog %s safely",
    async (stage) => {
      const disk = installDisk();
      const cache = new Cache(account);
      const abort = new AbortController();
      disk.state[stage] = (name) => {
        if (name.endsWith("/downloads.json")) abort.abort();
      };
      await expect(save(cache, "audio", abort.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(cache.downloads.size).toBe(0);
      expect(cache.downloadsError).toBeUndefined();
      expect(disk.blobs.size).toBe(stage === "afterClose" ? 1 : 0);
      const restored = new Cache(account);
      await restored.load();
      expect(restored.downloads.size).toBe(stage === "afterClose" ? 1 : 0);
      if (stage === "afterClose")
        expect(await (await restored.readDownload(track.id, "mp3"))!.text()).toBe("audio");
    },
  );

  it("reuses a concurrent winner and cancels the unused response", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache(account);
    const gate = deferred();
    const closing = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith(".audio")) {
        closing.resolve();
        await gate.promise;
      }
    };
    const one = save(first, "winner");
    await closing.promise;
    const unused = stream();
    const two = second.saveDownload(track, "mp3", "audio/mpeg", unused.response, signal());
    gate.resolve();
    const results = await Promise.all([one, two]);
    expect(await results[0].text()).toBe("winner");
    expect(await results[1].text()).toBe("winner");
    expect(unused.cancel).toHaveBeenCalledOnce();
    expect(disk.blobs.size).toBe(1);
    expect(second.downloads).toEqual(first.downloads);
  });

  it("cancels a lock waiter and releases its unused response before the winner finishes", async () => {
    installDisk();
    const first = new Cache(account);
    const source = stream();
    const pending = first.saveDownload(track, "mp3", "audio/mpeg", source.response, signal());
    await vi.waitFor(() => expect(source.response.bodyUsed).toBe(true));
    const unused = stream();
    const abort = new AbortController();
    const second = new Cache(account).saveDownload(
      track,
      "mp3",
      "audio/mpeg",
      unused.response,
      abort.signal,
    );
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(navigator.locks.request)
          .mock.calls.filter(([name]) => name.startsWith("libras-download:")),
      ).toHaveLength(2),
    );
    abort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(unused.cancel).toHaveBeenCalledOnce();
    source.controller.enqueue(new TextEncoder().encode("winner"));
    source.controller.close();
    await pending;
  });

  it("streams different downloads concurrently and merges their catalog entries", async () => {
    installDisk();
    const cache = new Cache(account);
    const one = stream();
    const two = stream();
    const pending = [
      cache.saveDownload(track, "mp3", "audio/mpeg", one.response, signal()),
      cache.saveDownload(track, "raw", "audio/flac", two.response, signal()),
    ];
    await vi.waitFor(() => {
      expect(one.response.bodyUsed).toBe(true);
      expect(two.response.bodyUsed).toBe(true);
    });
    one.controller.enqueue(new TextEncoder().encode("mp3"));
    one.controller.close();
    two.controller.enqueue(new TextEncoder().encode("raw"));
    two.controller.close();
    await Promise.all(pending);
    expect(cache.downloads.size).toBe(2);
    expect(await (await cache.readDownload(track.id, "raw"))!.text()).toBe("raw");
  });

  it("preserves an already committed winner without Web Locks", async () => {
    const disk = installDisk();
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    const first = new Cache(account);
    const second = new Cache(account);
    const one = stream();
    const two = stream();
    const a = first.saveDownload(track, "mp3", "audio/mpeg", one.response, signal());
    const b = second.saveDownload(track, "mp3", "audio/mpeg", two.response, signal());
    await vi.waitFor(() => {
      expect(one.response.bodyUsed).toBe(true);
      expect(two.response.bodyUsed).toBe(true);
    });
    one.controller.enqueue(new TextEncoder().encode("winner"));
    one.controller.close();
    await a;
    two.controller.enqueue(new TextEncoder().encode("loser"));
    two.controller.close();
    expect(await (await b).text()).toBe("winner");
    expect(disk.blobs.size).toBe(1);
  });

  it.each(["missing", "incomplete"])(
    "repairs %s files on access without discarding other downloads",
    async (kind) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await save(cache);
      await cache.saveDownload(track, "raw", "audio/flac", new Response("original"), signal());
      const fileName = cache.downloads.get(key)!.fileName;
      const binary = [...disk.blobs.keys()].find((name) => name.endsWith(fileName))!;
      if (kind === "missing") disk.blobs.delete(binary);
      else disk.blobs.set(binary, new Blob(["x"]));
      expect(await cache.readDownload(track.id, "mp3")).toBeNull();
      expect(cache.downloads.size).toBe(1);
      expect(catalog(disk).downloads).toHaveLength(1);
      expect(disk.blobs.has(binary)).toBe(false);
      await save(cache, "replacement");
      expect(cache.downloads.get(key)!.fileName).not.toBe(fileName);
      expect(disk.blobs.size).toBe(2);
    },
  );

  it("adopts a competing replacement during stale repair", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    await save(first);
    const second = new Cache(account);
    await second.load();
    disk.blobs.clear();
    await save(second, "replacement");
    expect(await (await first.readDownload(track.id, "mp3"))!.text()).toBe("replacement");
    expect(first.downloads).toEqual(second.downloads);
    expect(catalog(disk).downloads).toHaveLength(1);
  });

  it("does not invalidate records after permission errors or cancelled reads", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await save(cache);
    const original = cache.downloads;
    disk.state.beforeRead = async (name) => {
      if (name.endsWith(".audio")) throw new DOMException("Denied", "NotAllowedError");
    };
    await expect(cache.readDownload(track.id, "mp3")).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(cache.downloads).toBe(original);
    const abort = new AbortController();
    disk.state.beforeRead = async (name) => {
      if (name.endsWith(".audio")) abort.abort();
    };
    await expect(cache.readDownload(track.id, "mp3", abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cache.downloads).toBe(original);
    expect(catalog(disk).downloads).toHaveLength(1);
  });

  it("isolates accounts and never adopts unlisted files", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    await save(first, "first");
    const second = new Cache({ ...account, username: "other" });
    await second.load();
    expect(second.downloads.size).toBe(0);
    expect(await second.readDownload(track.id, "mp3")).toBeNull();
    await save(second, "other");
    expect(await (await first.readDownload(track.id, "mp3"))!.text()).toBe("first");
    expect(await (await second.readDownload(track.id, "mp3"))!.text()).toBe("other");
    disk.files.delete(path(disk));
    const restored = new Cache(account);
    await restored.load();
    expect(await restored.readDownload(track.id, "mp3")).toBeNull();
    expect(disk.blobs.size).toBe(2);
  });

  it.each(["foreign", "duplicate", "shared file", "unsafe filename", "broken"])(
    "rejects %s catalogs independently and preserves them on attempted saves",
    async (kind) => {
      const disk = installDisk();
      const original = new Cache(account);
      await save(original);
      original.setQueue({ tracks: [track.id], index: 0, position: 0 });
      await original.flush();
      const data = catalog(disk);
      if (kind === "foreign") data.account.username = "other";
      if (kind === "duplicate") data.downloads.push(data.downloads[0]);
      if (kind === "shared file") data.downloads.push({ ...data.downloads[0], format: "raw" });
      if (kind === "unsafe filename") data.downloads[0].fileName = "../outside.audio";
      const value = kind === "broken" ? "broken JSON" : JSON.stringify(data);
      disk.files.set(path(disk), value);
      const cache = new Cache(account);
      await expect(cache.load()).rejects.toBeInstanceOf(CacheLoadError);
      expect(cache.downloadsError).toBeDefined();
      expect(cache.queue.tracks).toEqual([track.id]);
      const unused = stream();
      await expect(
        cache.saveDownload(track, "mp3", "audio/mpeg", unused.response, signal()),
      ).rejects.toThrow();
      expect(unused.cancel).toHaveBeenCalledOnce();
      expect(disk.files.get(path(disk))).toBe(value);
      expect(disk.blobs.size).toBe(1);
    },
  );

  it("restores downloads even when the library is corrupt", async () => {
    const disk = installDisk();
    await save(new Cache(account));
    disk.files.set(path(disk).replace("downloads.json", "library.json"), "broken JSON");
    const cache = new Cache(account);
    await expect(cache.load()).rejects.toMatchObject({ failures: { library: expect.any(Error) } });
    expect(cache.downloads.size).toBe(1);
    expect(await (await cache.readDownload(track.id, "mp3"))!.text()).toBe("audio");
  });

  it.each([false, true])(
    "orders hydration with writes and guards cancellation (cancel: %s)",
    async (cancel) => {
      const disk = installDisk();
      await save(new Cache(account));
      const cache = new Cache(account);
      const reading = deferred();
      const gate = deferred();
      disk.state.beforeRead = async (name) => {
        if (name.endsWith("/downloads.json")) {
          disk.state.beforeRead = async () => {};
          reading.resolve();
          await gate.promise;
        }
      };
      const abort = new AbortController();
      const loading = cache.load(abort.signal);
      await reading.promise;
      expect(cache.downloads.size).toBe(0);
      if (cancel) {
        abort.abort();
        gate.resolve();
        await expect(loading).rejects.toMatchObject({ name: "AbortError" });
        expect(cache.downloads.size).toBe(0);
      } else {
        const saving = cache.saveDownload(
          track,
          "raw",
          "audio/flac",
          new Response("raw"),
          signal(),
        );
        gate.resolve();
        await Promise.all([loading, saving]);
        expect(cache.downloads.size).toBe(2);
        expect(catalog(disk).downloads).toHaveLength(2);
      }
    },
  );

  it("validates and copies descriptions before streaming and releases invalid responses", async () => {
    installDisk();
    const cache = new Cache(account);
    const input = { ...track };
    const source = stream();
    const pending = cache.saveDownload(input, "mp3", "audio/mpeg", source.response, signal());
    input.title = "mutated";
    source.controller.enqueue(new TextEncoder().encode("audio"));
    source.controller.close();
    await pending;
    expect(cache.downloads.get(key)!.track.title).toBe("Track");
    const invalid = stream();
    await expect(
      cache.saveDownload({ ...track, id: "" }, "mp3", "audio/mpeg", invalid.response, signal()),
    ).rejects.toThrow();
    expect(invalid.cancel).toHaveBeenCalledOnce();
  });
});

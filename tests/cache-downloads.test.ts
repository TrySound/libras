import { getAccountKey } from "../src/auth";
import { downloadFailureDiagnostic } from "../src/download-error";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { Cache, downloadKey } from "../src/cache.svelte";
import { completedDownloadCount, expectCompletedDownload, installDisk } from "./cache-test-helpers";
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
  return JSON.parse(disk.files.get(path(disk))!).records;
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
  it("restores and merges downloads without losing saved bytes or queue occurrences", async () => {
    const disk = installDisk();
    const original = new Cache(getAccountKey(account));
    await save(original, "original audio");
    const queue = { tracks: [track.id, track.id, "next", track.id], index: 1, position: 23.5 };
    original.setQueue(queue);
    await original.flush();
    const originalCatalog = catalog(disk);
    const oldRecord = originalCatalog[0];
    const oldBlobs = new Map(disk.blobs);
    const writes = disk.state.writes;

    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(restored.error).toBeUndefined();
    expect(expectCompletedDownload(restored, key)).toEqual(oldRecord);
    expect(restored.queue).toEqual(queue);
    expect(disk.state.writes).toBe(writes);
    expect(catalog(disk)).toEqual(originalCatalog);
    expect(await (await restored.readDownload(track.id, "mp3"))!.text()).toBe("original audio");

    // A fresh cache also lazily decodes the old catalog during save/merge.
    const merging = new Cache(getAccountKey(account));
    await merging.saveDownload(
      { ...track, id: "next" },
      "mp3",
      "audio/mpeg",
      new Response("new audio"),
      signal(),
    );
    expect(catalog(disk)).toHaveLength(2);
    await merging.flush();
    expect(catalog(disk)).toHaveLength(2);
    expect(catalog(disk)[0]).toEqual(oldRecord);
    for (const [name, blob] of oldBlobs) expect(disk.blobs.get(name)).toBe(blob);
    const final = new Cache(getAccountKey(account));
    await final.load();
    expect(final.queue).toEqual(queue);
    expect(expectCompletedDownload(final, key).fileName).toBe(oldRecord.fileName);
    expect(await (await final.readDownload(track.id, "mp3"))!.text()).toBe("original audio");
    expect(await (await final.readDownload("next", "mp3"))!.text()).toBe("new audio");
  });

  it.each([{ unrelated: true }, { id: "" }, { title: 42 }])(
    "rejects invalid persisted download metadata %j",
    async (extra) => {
      const disk = installDisk();
      const original = new Cache(getAccountKey(account));
      await save(original);
      await original.flush();
      const record = catalog(disk)[0];
      disk.files.set(
        path(disk),
        JSON.stringify({ version: 2, records: [{ ...record, track: { ...track, ...extra } }] }),
      );
      const restored = new Cache(getAccountKey(account));
      await expect(restored.load()).rejects.toBeInstanceOf(AggregateError);
      expect(restored.error).toBeDefined();
      expect(completedDownloadCount(restored)).toBe(0);
      expect(disk.blobs.size).toBe(1);
    },
  );

  it("restores independent descriptions without library metadata or reading audio into memory", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const file = await save(cache);
    expect(await file.text()).toBe("audio");
    expect(expectCompletedDownload(cache, key)).toMatchObject({
      track,
      format: "mp3",
      contentType: "audio/mpeg",
      size: 5,
    });
    await cache.flush();
    expect(catalog(disk)).toEqual([...cache.downloads.values()]);
    expect(catalog(disk)[0]).not.toHaveProperty("key");
    expect(disk.blobs.size).toBe(1);
    const reads: string[] = [];
    disk.state.beforeRead = async (name) => {
      reads.push(name);
    };
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(restored.artists.size).toBe(0);
    expect(restored.downloads).toEqual(cache.downloads);
    expect(reads.filter((name) => name.endsWith(".audio"))).toHaveLength(1);
    const bytes = vi.spyOn(File.prototype, "arrayBuffer");
    expect(await restored.readDownload(track.id, "mp3")).toBeInstanceOf(File);
    expect(bytes).not.toHaveBeenCalled();
    expect(await restored.readDownload(track.id, "raw")).toBeNull();
  });

  it("streams chunks and publishes reactively after binary close", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    const source = stream();
    const seen: number[] = [];
    const stop = observeCache(() => seen.push(completedDownloadCount(cache)));
    flushSync();
    const gate = deferred();
    const closing = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith(".audio")) {
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
    expect(disk.blobs.size).toBe(0);
    gate.resolve();
    await pending;
    expect(await [...disk.blobs.values()][0].text()).toBe("first second");
    await cache.flush();
    flushSync();
    expect(seen.filter((count) => count > 0)).toEqual([1]);
    stop();
  });

  it.each(["stream", "binary"])(
    "cleans uncommitted files on %s failure and allows retry",
    async (stage) => {
      const disk = installDisk();
      const cache = new Cache(getAccountKey(account));
      disk.state.beforeClose = async (name) => {
        if (stage === "binary" && name.endsWith(".audio")) throw new Error("Storage full");
      };
      const source = stream();
      const response = stage === "stream" ? source.response : new Response("audio");
      const pending = cache.saveDownload(track, "mp3", "audio/mpeg", response, signal());
      if (stage === "stream") {
        source.controller.enqueue(new TextEncoder().encode("partial"));
        source.controller.error(new Error("Truncated stream"));
      }
      await expect(pending).rejects.toThrow();
      expect(completedDownloadCount(cache)).toBe(0);
      expect(cache.error).toBeDefined();
      expect(disk.blobs.size).toBe(0);
      expect([...disk.files.keys()].some((name) => name.endsWith(".audio"))).toBe(false);
      disk.state.beforeClose = async () => {};
      expect(await (await save(cache)).text()).toBe("audio");
      expect(cache.error).toBeUndefined();
    },
  );

  it("cancels an active stream and deletes its partial file", async () => {
    const disk = installDisk();
    const source = stream();
    const cache = new Cache(getAccountKey(account));
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
    expect(completedDownloadCount(cache)).toBe(0);
    expect(cache.error).toBeUndefined();
    expect(disk.blobs.size).toBe(0);
    expect([...disk.files.keys()].every((name) => name.endsWith("downloads.json"))).toBe(true);
    expect(cache.downloads.get(key)?.status).toBe("queued");
  });

  it("reuses a concurrent winner and cancels the unused response", async () => {
    const disk = installDisk();
    const first = new Cache(getAccountKey(account));
    const second = first;
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
    expect(expectCompletedDownload(second, key)).toMatchObject({ track, size: 6 });
  });

  it("cancels a lock waiter and releases its unused response before the winner finishes", async () => {
    installDisk();
    const first = new Cache(getAccountKey(account));
    const source = stream();
    const pending = first.saveDownload(track, "mp3", "audio/mpeg", source.response, signal());
    await vi.waitFor(() => expect(source.response.bodyUsed).toBe(true));
    const unused = stream();
    const abort = new AbortController();
    const second = new Cache(getAccountKey(account)).saveDownload(
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
    const cache = new Cache(getAccountKey(account));
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
    expect(completedDownloadCount(cache)).toBe(2);
    expect(await (await cache.readDownload(track.id, "raw"))!.text()).toBe("raw");
  });

  it("preserves an already committed winner without Web Locks", async () => {
    const disk = installDisk();
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    const first = new Cache(getAccountKey(account));
    const second = first;
    const one = stream();
    const two = stream();
    const a = first.saveDownload(track, "mp3", "audio/mpeg", one.response, signal());
    const b = second.saveDownload(track, "mp3", "audio/mpeg", two.response, signal());
    await vi.waitFor(() => {
      expect(one.response.bodyUsed).toBe(true);
      expect(two.response.bodyUsed).toBe(false);
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
      const cache = new Cache(getAccountKey(account));
      await save(cache);
      await cache.saveDownload(track, "raw", "audio/flac", new Response("original"), signal());
      const fileName = expectCompletedDownload(cache, key).fileName;
      const binary = [...disk.blobs.keys()].find((name) => name.endsWith(fileName))!;
      if (kind === "missing") disk.blobs.delete(binary);
      else disk.blobs.set(binary, new Blob(["x"]));
      expect(await cache.readDownload(track.id, "mp3")).toBeNull();
      expect(completedDownloadCount(cache)).toBe(1);
      await cache.flush();
      expect(catalog(disk)).toHaveLength(2);
      expect(disk.blobs.has(binary)).toBe(false);
      await save(cache, "replacement");
      expect(expectCompletedDownload(cache, key).fileName).not.toBe(fileName);
      expect(disk.blobs.size).toBe(2);
    },
  );

  it("does not invalidate records after permission errors or cancelled reads", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    await save(cache);
    await cache.flush();
    const original = expectCompletedDownload(cache, key);
    disk.state.beforeRead = async (name) => {
      if (name.endsWith(".audio")) throw new DOMException("Denied", "NotAllowedError");
    };
    await expect(cache.readDownload(track.id, "mp3")).rejects.toMatchObject({
      name: "DownloadError",
    });
    expect(expectCompletedDownload(cache, key)).toEqual(original);
    const abort = new AbortController();
    disk.state.beforeRead = async (name) => {
      if (name.endsWith(".audio")) abort.abort();
    };
    await expect(cache.readDownload(track.id, "mp3", abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(expectCompletedDownload(cache, key)).toEqual(original);
    expect(catalog(disk)).toHaveLength(1);
  });

  it("isolates accounts and never adopts unlisted files", async () => {
    const disk = installDisk();
    const first = new Cache(getAccountKey(account));
    await save(first, "first");
    const second = new Cache(getAccountKey({ ...account, username: "other" }));
    await second.load();
    expect(completedDownloadCount(second)).toBe(0);
    expect(await second.readDownload(track.id, "mp3")).toBeNull();
    await save(second, "other");
    expect(await (await first.readDownload(track.id, "mp3"))!.text()).toBe("first");
    expect(await (await second.readDownload(track.id, "mp3"))!.text()).toBe("other");
    disk.files.delete(path(disk));
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(await restored.readDownload(track.id, "mp3")).toBeNull();
    expect(disk.blobs.size).toBe(2);
  });

  it.each(["unexpected field", "duplicate", "shared file", "unsafe filename", "broken"])(
    "rejects %s catalogs independently and preserves them on attempted saves",
    async (kind) => {
      const disk = installDisk();
      const original = new Cache(getAccountKey(account));
      await save(original);
      original.setQueue({ tracks: [track.id], index: 0, position: 0 });
      await original.flush();
      const data = catalog(disk);
      if (kind === "unexpected field") data[0].unexpected = true;
      if (kind === "duplicate") data.push(data[0]);
      if (kind === "shared file") data.push({ ...data[0], format: "raw" });
      if (kind === "unsafe filename") data[0].fileName = "../outside.audio";
      const value =
        kind === "broken" ? "broken JSON" : JSON.stringify({ version: 2, records: data });
      disk.files.set(path(disk), value);
      const cache = new Cache(getAccountKey(account));
      await expect(cache.load()).rejects.toBeInstanceOf(AggregateError);
      expect(cache.error).toBeDefined();
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
    const seed = new Cache(getAccountKey(account));
    await save(seed);
    await seed.flush();
    disk.files.set(path(disk).replace("downloads.json", "library.json"), "broken JSON");
    const cache = new Cache(getAccountKey(account));
    await expect(cache.load()).rejects.toMatchObject({ errors: [expect.any(Error)] });
    expect(completedDownloadCount(cache)).toBe(1);
    expect(await (await cache.readDownload(track.id, "mp3"))!.text()).toBe("audio");
  });

  it.each([false, true])(
    "orders hydration with writes and guards cancellation (cancel: %s)",
    async (cancel) => {
      const disk = installDisk();
      const seed = new Cache(getAccountKey(account));
      await save(seed);
      await seed.flush();
      const cache = new Cache(getAccountKey(account));
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
      expect(completedDownloadCount(cache)).toBe(0);
      if (cancel) {
        abort.abort();
        gate.resolve();
        await expect(loading).rejects.toMatchObject({ name: "AbortError" });
        expect(completedDownloadCount(cache)).toBe(0);
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
        expect(completedDownloadCount(cache)).toBe(2);
        await cache.flush();
        expect(catalog(disk)).toHaveLength(2);
      }
    },
  );

  it("copies descriptions before streaming", async () => {
    installDisk();
    const cache = new Cache(getAccountKey(account));
    const input = { ...track };
    const source = stream();
    const pending = cache.saveDownload(input, "mp3", "audio/mpeg", source.response, signal());
    input.title = "mutated";
    source.controller.enqueue(new TextEncoder().encode("audio"));
    source.controller.close();
    await pending;
    expect(expectCompletedDownload(cache, key).track.title).toBe("Track");
  });
});

describe("fresh binary commit boundaries", () => {
  it("retains completed state when returning the committed file fails", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    disk.state.beforeRead = async (name) => {
      if (name.endsWith(".audio")) {
        expect(catalog(disk)[0].status).toBe("completed");
        throw new Error("getFile denied after commit");
      }
    };
    await expect(save(cache)).rejects.toMatchObject({ name: "DownloadError" });
    const completed = expectCompletedDownload(cache, key);
    expect(catalog(disk)).toEqual([completed]);
    expect(disk.blobs.size).toBe(1);
    const bytes = new Map(disk.blobs);
    await cache.failDownload(key);
    expect(cache.downloads.get(key)).toBe(completed);
    expect(catalog(disk)).toEqual([completed]);
    expect(disk.blobs).toEqual(bytes);
    disk.state.beforeRead = async () => {};
    const reopened = new Cache(cache.key);
    await reopened.load();
    expect(await (await reopened.readDownload(track.id, "mp3"))?.text()).toBe("audio");
  });

  it("keeps a canonically completed file when metadata close commits then throws", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    let closed = false;
    disk.state.afterClose = (name) => {
      if (name.endsWith(".audio")) closed = true;
      if (closed && name.endsWith("downloads.json")) throw new Error("after commit");
    };
    expect(await (await save(cache)).text()).toBe("audio");
    await cache.failDownload(key);
    expect(cache.downloads.get(key)?.status).toBe("completed");
    expect(disk.blobs.size).toBe(1);
    disk.state.afterClose = () => {};
    const reopened = new Cache(cache.key);
    await reopened.load();
    expect(await (await reopened.readDownload(track.id, "mp3"))?.text()).toBe("audio");
  });

  it("preserves possibly registered bytes when commit verification is unreadable", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    let closed = false;
    disk.state.afterClose = (name) => {
      if (name.endsWith(".audio")) closed = true;
      if (closed && name.endsWith("downloads.json")) {
        disk.state.beforeRead = async () => {
          throw new Error("denied");
        };
        throw new Error("after commit");
      }
    };
    await expect(save(cache)).rejects.toThrow();
    expect(disk.blobs.size).toBe(1);
    expect(cache.downloadStorageBlocked).toBe(true);
    await expect(cache.failDownload(key)).rejects.toThrow();
    expect(catalog(disk)[0].status).toBe("completed");
    disk.state.beforeRead = async () => {};
    disk.state.afterClose = () => {};
    const reopened = new Cache(cache.key);
    await reopened.load();
    expect(await (await reopened.readDownload(track.id, "mp3"))?.text()).toBe("audio");
  });

  it.each(["byte", "metadata"])(
    "commits despite cancellation during %s close",
    async (boundary) => {
      const disk = installDisk();
      const cache = new Cache(getAccountKey(account));
      const abort = new AbortController();
      let closed = false;
      disk.state.afterClose = (name) => {
        if (name.endsWith(".audio")) closed = true;
      };
      disk.state.beforeClose = async (name) => {
        if (
          (boundary === "byte" && name.endsWith(".audio")) ||
          (boundary === "metadata" && closed && name.endsWith("downloads.json"))
        )
          abort.abort();
      };
      expect(await (await save(cache, "audio", abort.signal)).text()).toBe("audio");
      expect(cache.downloads.get(key)?.status).toBe("completed");
    },
  );

  it("rejects a known HTTP length mismatch before close", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    await expect(
      cache.saveDownload(
        track,
        "mp3",
        "audio/mpeg",
        new Response("audio", { headers: { "content-length": "99" } }),
        signal(),
      ),
    ).rejects.toThrow();
    expect(disk.blobs.size).toBe(0);
    expect(cache.downloads.get(key)?.status).toBe("queued");
  });
});

describe("durable download intent", () => {
  it("acknowledges ordered whitelisted intent only after its canonical close", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith("downloads.json")) {
        closing.resolve();
        await release.promise;
      }
    };
    let acknowledged = false;
    const input = { ...track, url: "https://secret/?token=secret", credentials: "secret" };
    const saving = cache.enqueueDownload(input, "mp3", "audio/mpeg").then(() => {
      acknowledged = true;
    });
    await closing.promise;
    expect(acknowledged).toBe(false);
    expect(cache.downloads.size).toBe(0);
    release.resolve();
    await saving;
    await cache.enqueueDownload({ ...track, id: "next" }, "raw", "audio/flac");
    await cache.enqueueDownload(track, "mp3", "audio/mpeg");
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect([...restored.downloads.keys()]).toEqual([key, downloadKey("next", "raw")]);
    expect([...disk.files.values()].join()).not.toMatch(/secret|credentials|url/);
  });

  it.each(["bytes", "catalog"])("restarts from scratch after interruption at %s", async (stage) => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    let prepared = false;
    disk.state.beforeClose = async (name) => {
      if (name.endsWith(".audio")) {
        prepared = true;
        if (stage === "bytes") throw new Error("interrupted close");
      }
      if (prepared && stage === "catalog" && name.endsWith("/downloads.json"))
        throw new Error("interrupted catalog");
    };
    await expect(save(cache)).rejects.toThrow();
    disk.state.beforeClose = async () => {};
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(completedDownloadCount(restored)).toBe(0);
    expect(restored.downloads.get(key)?.status).toBe("queued");
    expect(await restored.readDownload(track.id, "mp3")).toBeNull();
    expect(disk.blobs.size).toBe(0);
    expect(await (await save(restored, "fresh bytes")).text()).toBe("fresh bytes");
    expect(catalog(disk)[0]).not.toHaveProperty("attempt");
  });

  it("converts missing completed-only metadata to intent before durable catalog eviction", async () => {
    const disk = installDisk();
    const seed = new Cache(getAccountKey(account));
    await save(seed);
    disk.blobs.clear();
    const restored = new Cache(getAccountKey(account));
    disk.state.beforeClose = async (name) => {
      if (name.endsWith("downloads.json")) throw new Error("full");
    };
    await expect(restored.load()).rejects.toThrow();
    expect(catalog(disk)).toHaveLength(1);
    disk.state.beforeClose = async () => {};
    // Atomic failure retained the previous committed catalog; reopen can recover intent.
    const recovered = new Cache(getAccountKey(account));
    await recovered.load();
    expect(catalog(disk)).toMatchObject([{ status: "queued" }]);
    expect(recovered.downloads.get(key)?.status).toBe("queued");
  });
});

it("places explicit Retry at the durable FIFO tail", async () => {
  installDisk();
  const cache = new Cache(getAccountKey(account));
  await cache.enqueueDownload(track, "mp3", "audio/mpeg");
  await cache.failDownload(key);
  await cache.enqueueDownload({ ...track, id: "waiting" }, "raw", "audio/flac");
  await cache.enqueueDownload(track, "mp3", "audio/mpeg", true);
  const restored = new Cache(cache.key);
  await restored.load();
  expect([...restored.downloads.keys()]).toEqual([downloadKey("waiting", "raw"), key]);
});

it.each([
  ["version", {}],
  ["unknown envelope field", {}],
  ["duplicate identity", { track }],
  ["invalid format", { format: "ogg" }],
  ["invalid content type", { contentType: "" }],
  ["invalid status", { status: "active" }],
  ["invalid diagnostic", { status: "failed", diagnostic: "arbitrary error" }],
  ["invalid track ID", { track: { ...track, id: "" } }],
  ["invalid track title", { track: { ...track, title: 42 } }],
  ["unknown track field", { track: { ...track, extra: true } }],
])("preserves unreadable download stores (%s)", async (kind, extra) => {
  const disk = installDisk();
  const seed = new Cache(getAccountKey(account));
  await save(seed);
  const completed = catalog(disk)[0];
  const pending = {
    track: { ...track, id: "old" },
    format: "mp3",
    contentType: "audio/mpeg",
    status: "queued",
    ...extra,
  };
  const original = JSON.stringify({
    version: kind === "version" ? 3 : 2,
    records: [completed, pending],
    ...(kind === "unknown envelope field" ? { extra: true } : {}),
  });
  disk.files.set(path(disk), original);
  const blobs = new Map(disk.blobs);
  const cache = new Cache(seed.key);
  await expect(cache.load()).rejects.toThrow();
  await expect(cache.enqueueDownload(track, "raw", "audio/flac")).rejects.toThrow();
  expect(disk.files.get(path(disk))).toBe(original);
  expect(disk.blobs).toEqual(blobs);
  expect(cache.downloadStorageBlocked).toBe(true);
});

it.each([false, true])(
  "strips unknown job fields without rewriting on load (denied=%s)",
  async (denied) => {
    const disk = installDisk();
    const seed = new Cache(getAccountKey(account));
    await save(seed);
    await seed.saveDownload(track, "raw", "audio/flac", new Response("raw"), signal());
    const completed = catalog(disk);
    const oldFile = `${crypto.randomUUID()}.audio`;
    const attemptPath = [...disk.blobs.keys()][0].replace(/[^/]+$/, oldFile);
    disk.blobs.set(attemptPath, new Blob(["complete old bytes"]));
    const attempts = [
      { fileName: oldFile, size: 18, downloadedAt: 1 },
      { fileName: completed[0].fileName, size: 0, progress: true },
      { fileName: "../outside.audio" },
      null,
      "malformed",
      { unrelated: [true] },
    ];
    const pending = attempts.map((attempt, index) => ({
      track: { ...track, id: `old-${index}`, title: `Old ${index}` },
      format: index % 2 ? ("raw" as const) : ("mp3" as const),
      contentType: index % 2 ? "audio/flac" : "audio/mpeg",
      status: index % 2 ? ("failed" as const) : ("queued" as const),
      ...(index % 2 ? { diagnostic: downloadFailureDiagnostic } : {}),
      attempt,
      unused: { progress: 99 },
    }));
    const stripped = pending.map(({ attempt: _attempt, unused: _unused, ...entry }) => entry);
    const expected = [...completed, ...stripped];
    const original = JSON.stringify({ version: 2, records: [...completed, ...pending] });
    disk.files.set(path(disk), original);
    const blobs = new Map(disk.blobs);
    const writes = disk.state.writes;
    const reads: string[] = [];
    disk.state.beforeRead = async (name) => {
      reads.push(name);
    };
    if (denied)
      disk.state.beforeClose = async () => {
        throw new Error("metadata writes denied");
      };
    const cache = new Cache(seed.key);
    await cache.load();
    expect([...cache.downloads.values()]).toEqual(expected);
    expect(cache.downloadStorageBlocked).toBe(false);
    expect(await (await cache.readDownload(track.id, "raw"))?.text()).toBe("raw");
    expect(await cache.readDownload("old-0", "mp3")).toBeNull();
    expect(reads.filter((name) => name.endsWith(".audio"))).toEqual(
      reads.filter((name) =>
        completed.some((entry: { fileName: string }) => name.endsWith(entry.fileName)),
      ),
    );
    expect(disk.state.writes).toBe(writes);
    expect(disk.files.get(path(disk))).toBe(original);
    expect(disk.blobs).toEqual(blobs);
    if (denied) {
      await expect(
        cache.enqueueDownload({ ...track, id: "new" }, "mp3", "audio/mpeg"),
      ).rejects.toThrow();
      expect(disk.files.get(path(disk))).toBe(original);
      disk.state.beforeClose = async () => {};
    }
    await cache.enqueueDownload({ ...track, id: "new" }, "mp3", "audio/mpeg");
    expect(catalog(disk)).toEqual([
      ...expected,
      {
        track: { ...track, id: "new" },
        format: "mp3",
        contentType: "audio/mpeg",
        status: "queued",
      },
    ]);
    expect(disk.blobs).toEqual(blobs); // Ignored attempt bytes are never reclaimed.
    await cache.saveDownload(
      pending[0].track,
      "mp3",
      "audio/mpeg",
      new Response("fresh"),
      signal(),
    );
    expect(expectCompletedDownload(cache, downloadKey("old-0", "mp3")).fileName).not.toBe(oldFile);
    expect(disk.blobs.get(attemptPath)).toBe(blobs.get(attemptPath));
  },
);

/** Restore the representation used by released completed-only installs. */
function legacy(disk: ReturnType<typeof installDisk>, cache: Cache) {
  const records = [...cache.downloads.keys()].map((key) => {
    const record = expectCompletedDownload(cache, key);
    return {
      track: {
        id: record.track.id,
        title: record.track.title,
        artist: record.track.artist,
        album: record.track.album,
      },
      format: record.format,
      contentType: record.contentType,
      fileName: record.fileName,
      size: record.size,
      downloadedAt: record.downloadedAt,
    };
  });
  disk.files.set(path(disk), JSON.stringify(records));
  return records;
}

it("migrates completed-only installs once, preserving saved metadata and both formats", async () => {
  const disk = installDisk();
  const seed = new Cache(getAccountKey(account));
  await save(seed);
  await seed.saveDownload(track, "raw", "audio/flac", new Response("raw"), signal());
  const before = legacy(disk, seed);
  const cache = new Cache(seed.key);
  await cache.load();
  expect(catalog(disk)).toEqual(
    before.map((record: object) => ({ ...record, status: "completed" })),
  );
  const writes = disk.state.writes;
  const reopened = new Cache(seed.key);
  await reopened.load();
  expect(disk.state.writes).toBe(writes);
  expect(await (await reopened.readDownload(track.id, "raw"))?.text()).toBe("raw");
});

it("does not write partial legacy fallback after a transient migration failure", async () => {
  const disk = installDisk();
  const seed = new Cache(getAccountKey(account));
  await save(seed);
  await seed.saveDownload(
    { ...track, id: "saved" },
    "raw",
    "audio/flac",
    new Response("saved"),
    signal(),
  );
  legacy(disk, seed);
  const missing = expectCompletedDownload(seed, key);
  disk.blobs.delete([...disk.blobs.keys()].find((name) => name.endsWith(missing.fileName))!);
  const before = new Map(disk.files);
  disk.state.beforeClose = async (name) => {
    if (name.endsWith("downloads.json")) {
      disk.state.beforeClose = async () => {};
      throw new Error("transient migration failure");
    }
  };
  const cache = new Cache(seed.key);
  expect(await cache.readDownload(track.id, "mp3")).toBeNull();
  expect(disk.files).toEqual(before);
  await cache.load();
  const reopened = new Cache(seed.key);
  await reopened.load();
  expect(reopened.downloads.get(key)?.status).toBe("queued");
  expect(await (await reopened.readDownload("saved", "raw"))?.text()).toBe("saved");
});

it.each(["before", "after"])(
  "uses canonical close as the migration commit (%s close interruption)",
  async (boundary) => {
    const disk = installDisk();
    const seed = new Cache(getAccountKey(account));
    await save(seed);
    legacy(disk, seed);
    const previous = disk.files.get(path(disk));
    if (boundary === "before")
      disk.state.beforeClose = async (name) => {
        if (name.endsWith("downloads.json")) throw new DOMException("Denied", "NotAllowedError");
      };
    else
      disk.state.afterClose = (name) => {
        if (name.endsWith("downloads.json")) throw new Error("page interrupted after commit");
      };
    const cache = new Cache(seed.key);
    await expect(cache.load()).rejects.toThrow();
    expect(await (await cache.readDownload(track.id, "mp3"))?.text()).toBe("audio");
    if (boundary === "before") expect(disk.files.get(path(disk))).toBe(previous);
    disk.state.beforeClose = async () => {};
    disk.state.afterClose = () => {};
    const reopened = new Cache(seed.key);
    await reopened.load();
    expect(await (await reopened.readDownload(track.id, "mp3"))?.text()).toBe("audio");
    await reopened.cancelPendingDownloads();
    const again = new Cache(seed.key);
    await again.load();
    expect(again.downloads.size).toBe(1);
  },
);

it.each(["null", "", "broken JSON", '[{"invalid":true}]'])(
  "preserves corrupt completed-only catalog %j and blocks writes",
  async (corrupt) => {
    const disk = installDisk();
    const seed = new Cache(getAccountKey(account));
    await save(seed);
    disk.files.set(path(disk), corrupt);
    const cache = new Cache(seed.key);
    await expect(cache.load()).rejects.toThrow();
    await expect(save(cache)).rejects.toThrow();
    expect(disk.files.get(path(disk))).toBe(corrupt);
    expect(disk.blobs.size).toBe(1);
  },
);

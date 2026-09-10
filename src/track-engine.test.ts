import { afterEach, describe, expect, it, vi } from "vitest";
import { Network } from "./network.svelte";
import { TrackEngine } from "./track-engine";
import { Storage } from "./storage";
import { Memory as AppMemory } from "./memory.svelte";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};
const account = { host: auth.host, username: auth.username };

/** TrackEngine consumes an already selected workspace; Session owns this in the app. */
class Memory extends AppMemory {
  constructor() {
    super();
    this.account = { host: auth.host, username: auth.username };
  }
}

function installOpfs(
  initialFile: File | null = null,
  canPlayType: CanPlayTypeResult = "",
  failCatalogWrite = false,
  audioWrite?: () => void,
) {
  const files = new Map<string, File>();
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && initialFile && name.endsWith(".audio")) files.set(name, initialFile);
      if (!files.has(name) && !options?.create) throw new DOMException("Missing", "NotFoundError");
      if (!files.has(name)) files.set(name, new File([], name));
      return {
        async getFile() {
          const file = files.get(name);
          if (!file) throw new DOMException("Missing", "NotFoundError");
          return file;
        },
        async createWritable() {
          if (name === "downloads.json" && failCatalogWrite) {
            failCatalogWrite = false;
            throw new Error("Catalog write failed");
          }
          const chunks: BlobPart[] = [];
          const close = () => {
            files.set(name, new File(chunks, name));
          };
          return Object.assign(
            new WritableStream<Uint8Array>({
              write(chunk) {
                if (name.endsWith(".audio")) audioWrite?.();
                chunks.push(chunk.slice().buffer as ArrayBuffer);
              },
              close,
            }),
            {
              async write(chunk: BlobPart) {
                chunks.push(chunk);
              },
              async close() {
                close();
              },
              async abort() {},
            },
          );
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };

  vi.stubGlobal("document", {
    createElement: () => ({ canPlayType: () => canPlayType }),
  });
  vi.stubGlobal("navigator", {
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory;
          },
        };
      },
    },
  });
  return files;
}

function installTrackLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn(
    (
      name: string,
      options: LockOptions | (() => Promise<unknown>),
      callback?: () => Promise<unknown>,
    ) => {
      const action = typeof options === "function" ? options : callback!;
      const signal = typeof options === "function" ? undefined : options.signal;
      const result = (tails.get(name) ?? Promise.resolve()).then(() => {
        signal?.throwIfAborted();
        return action();
      });
      tails.set(
        name,
        result.catch(() => {}),
      );
      if (!signal) return result;
      let abort: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      return Promise.race([result, cancelled]).finally(() =>
        signal.removeEventListener("abort", abort),
      );
    },
  );
  Object.assign(navigator, { locks: { request } });
  return request;
}

function download() {
  return {
    descriptor: {
      host: auth.host,
      username: auth.username,
      key: `${auth.host}\n${auth.username}\none\nmp3-v1`,
      format: "mp3" as const,
      contentType: "audio/mpeg",
    },
    track: { id: "one", title: "One", artist: "Artist", album: "Album" },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("track engine", () => {
  it("uses injected Storage and keeps cached playback object URLs engine-owned", async () => {
    installOpfs();
    const getDirectory = vi.spyOn(navigator.storage, "getDirectory");
    const file = new File(["audio"], "cached.audio");
    const audio = {
      list: vi.fn(async () => []),
      entries: vi.fn(async () => []),
      read: vi.fn(async () => file),
      save: vi.fn(async () => file),
    };
    const storage = { account: auth, audio };
    const memory = new Memory();
    memory.account = { host: auth.host, username: auth.username };
    const engine = new TrackEngine({ memory, storage });
    await engine.ready();
    const source = await engine.getSource({ id: "one" });
    expect(source.cached).toBe(true);
    expect(audio.list).toHaveBeenCalledOnce();
    expect(audio.read).toHaveBeenCalledWith(
      expect.objectContaining({ host: auth.host, username: auth.username }),
      expect.objectContaining({ id: "one" }),
    );
    expect(getDirectory).not.toHaveBeenCalled();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    engine.destroy();
    expect(revoke).toHaveBeenCalledWith(source.url);
  });

  it("restores completed downloads into Memory and plays them without credentials", async () => {
    installOpfs(null, "probably");
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const memory = new Memory();

    const writer = new TrackEngine({
      storage: new Storage(account),
      memory: memory,
      connection: createConnection(auth),
    });
    const track = { id: "offline", title: "Offline", contentType: "audio/flac" };
    await writer.cache(track, { forceTranscode: true });
    expect(memory.downloads.size).toBe(1);
    const completed = [...memory.downloads.values()][0];
    expect(completed).toMatchObject({ track: { id: "offline" }, format: "mp3" });
    expect(completed).not.toHaveProperty("url");
    expect(completed).not.toHaveProperty("status");
    writer.setConnection(undefined);
    expect(memory.account).toEqual({ host: auth.host, username: auth.username });
    expect(memory.downloads.size).toBe(1);
    fetcher.mockClear();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:offline");
    expect(await writer.getSource(track)).toEqual({ cached: true, url: "blob:offline" });
    writer.destroy();
    const restoredMemory = new Memory();
    restoredMemory.account = { host: auth.host, username: auth.username };

    const reader = new TrackEngine({ storage: new Storage(account), memory: restoredMemory });
    await reader.ready();
    expect([...restoredMemory.downloads.values()]).toEqual([completed]);
    expect(reader.getStatus(track.id)).toBe("downloaded");
    await reader.scanCached([track]);
    expect(await reader.getSource(track, { position: 120 })).toEqual({
      cached: true,
      url: "blob:offline",
    });
    expect(reader.downloadJobs).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    reader.destroy();
  });

  it("publishes only completed downloads to Memory and storage", async () => {
    const files = installOpfs();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const memory = new Memory();

    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: memory,
      connection: createConnection(auth),
    });
    await engine.ready();
    const emptyCatalog = memory.downloads;
    const pending = engine.cache({ id: "pending" });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(memory.downloads).toBe(emptyCatalog);
    expect(memory.downloads.size).toBe(0);
    expect(files.has("downloads.json")).toBe(false);
    expect(engine.downloadJobs[0]).toMatchObject({
      track: { id: "pending" },
      status: "downloading",
    });
    expect(engine.downloadJobs[0]).not.toHaveProperty("url");
    resolve(new Response("audio"));
    await pending;
    expect(memory.downloads).not.toBe(emptyCatalog);
    expect(emptyCatalog.size).toBe(0);
    expect(memory.downloads.size).toBe(1);
    expect(engine.downloadJobs).toEqual([]);
    engine.destroy();
  });

  it("does not play another account's files or stream with mismatched credentials", async () => {
    installOpfs();
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const memory = new Memory();

    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: memory,
      connection: createConnection(auth),
    });
    await engine.cache({ id: "same-id" });
    fetcher.mockClear();
    memory.account = { host: auth.host, username: "other" };
    expect(engine.getStatus("same-id")).toBe("idle");
    await expect(engine.getSource({ id: "same-id" })).rejects.toThrow(
      "Audio storage belongs to a different account",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(memory.downloads.size).toBe(1);
    memory.account = { host: auth.host, username: auth.username };
    engine.setConnection(undefined);
    await expect(engine.getSource({ id: "missing" })).rejects.toThrow(
      "Connect to its music server",
    );
    expect(fetcher).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("rejects a cached source resolved after the selected account changes", async () => {
    installOpfs();
    const memory = new Memory();
    memory.account = { host: auth.host, username: auth.username };

    const storage = new Storage(account);
    const engine = new TrackEngine({ storage, memory: memory });
    await engine.ready();
    let resolve!: (file: File) => void;
    vi.spyOn(storage.audio, "read").mockImplementationOnce(
      () =>
        new Promise<File>((done) => {
          resolve = done;
        }),
    );
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const pending = engine.getSource({ id: "old" });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    memory.account = { host: auth.host, username: "other" };
    resolve(new File(["audio"], "cached.audio"));
    await rejected;
    expect(createUrl).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("reuses another writer's completed file even when the later response has failed", async () => {
    const files = installOpfs();
    installTrackLocks();
    const first = new Storage(account).audio;
    const second = new Storage(account).audio;
    const { descriptor, track } = download();
    const signal = new AbortController().signal;
    expect(await first.read(descriptor, track)).toBeNull();
    expect(await second.read(descriptor, track)).toBeNull();
    await first.save(descriptor, track, new Response("complete"), signal);
    const failed = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Network failed"));
        },
      }),
    );
    expect(await (await second.save(descriptor, track, failed, signal)).text()).toBe("complete");
    const records = JSON.parse(await files.get("downloads.json")!.text());
    expect(records).toHaveLength(1);
    expect(await files.get(records[0].fileName)!.text()).toBe("complete");
  });

  it.each([false, true])(
    "keeps a complete orphan when a later writer fails (locks: %s)",
    async (locks) => {
      const files = installOpfs(null, "", true);
      if (locks) installTrackLocks();
      const first = new Storage(account).audio;
      const second = new Storage(account).audio;
      const { descriptor, track } = download();
      const signal = new AbortController().signal;
      await expect(first.save(descriptor, track, new Response("complete"), signal)).rejects.toThrow(
        "Catalog write failed",
      );
      const failed = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Network failed"));
          },
        }),
      );
      await expect(second.save(descriptor, track, failed, signal)).rejects.toThrow(
        "Network failed",
      );
      const fileName = [...files.keys()].find((name) => name.endsWith(".audio"))!;
      expect(await files.get(fileName)!.text()).toBe("complete");
      expect(await (await second.read(descriptor, track))!.text()).toBe("complete");
      expect(JSON.parse(await files.get("downloads.json")!.text())).toHaveLength(1);
    },
  );

  it("does not mistake a rejected truncated file for a completed concurrent download", async () => {
    const files = installOpfs();
    installTrackLocks();
    const store = new Storage(account).audio;
    const { descriptor, track } = download();
    const signal = new AbortController().signal;
    await store.save(descriptor, track, new Response("complete"), signal);
    const [record] = JSON.parse(await files.get("downloads.json")!.text());
    files.set(record.fileName, new File(["x"], record.fileName));
    expect(await store.read(descriptor, track)).toBeNull();
    expect(
      await (await store.save(descriptor, track, new Response("repaired"), signal)).text(),
    ).toBe("repaired");
    expect(await files.get(record.fileName)!.text()).toBe("repaired");
  });

  it.each(["complete", "fail", "cancel waiter"])(
    "coordinates simultaneous audio writers when the first writer will %s",
    async (outcome) => {
      const audioWrite = vi.fn();
      const files = installOpfs(null, "", false, audioWrite);
      const request = installTrackLocks();
      const first = new Storage(account).audio;
      const second = new Storage(account).audio;
      const { descriptor, track } = download();
      const signal = new AbortController().signal;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      );
      const writing = first.save(descriptor, track, source, signal);
      const firstResult =
        outcome === "fail" ? expect(writing).rejects.toThrow("Network failed") : writing;
      await vi.waitFor(() => expect(audioWrite).toHaveBeenCalledOnce());
      const cancel = vi.fn();
      const unused = new Response(
        new ReadableStream({
          start(value) {
            value.enqueue(new TextEncoder().encode("second"));
            value.close();
          },
          cancel,
        }),
      );
      const abort = new AbortController();
      const waiting = second.save(descriptor, track, unused, abort.signal);
      const cancelled =
        outcome === "cancel waiter"
          ? expect(waiting).rejects.toMatchObject({ name: "AbortError" })
          : undefined;
      await vi.waitFor(() =>
        expect(
          request.mock.calls.filter(([name]) => name.startsWith("music-web-audio:")).length,
        ).toBeGreaterThanOrEqual(2),
      );
      expect(audioWrite).toHaveBeenCalledOnce();
      if (outcome === "cancel waiter") {
        abort.abort();
        await cancelled;
        expect(cancel).toHaveBeenCalledOnce();
      }
      if (outcome === "fail") controller.error(new Error("Network failed"));
      else controller.close();
      await firstResult;
      if (outcome !== "cancel waiter") {
        expect(await (await waiting).text()).toBe(outcome === "complete" ? "first" : "second");
        if (outcome === "complete") expect(cancel).toHaveBeenCalledOnce();
      }
      const records = JSON.parse(await files.get("downloads.json")!.text());
      expect(records).toHaveLength(1);
      expect(await files.get(records[0].fileName)!.text()).toBe(
        outcome === "fail" ? "second" : "first",
      );
    },
  );

  it("persists completed files with track metadata, but never credentials or pending jobs", async () => {
    const files = installOpfs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    const track = { id: "one", title: "Song", artist: "Artist", album: "Album", coverArt: "cover" };
    await engine.cache(track);
    const json = await files.get("downloads.json")!.text();
    const records = JSON.parse(json);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      track,
      format: "mp3",
      size: 5,
      host: auth.host,
      username: auth.username,
    });
    expect(records[0].fileName).toMatch(/^[a-f0-9]{64}\.audio$/);
    expect(files.has(records[0].fileName)).toBe(true);
    expect(records[0]).not.toHaveProperty("url");
    expect(records[0]).not.toHaveProperty("status");
    expect(json).not.toContain(auth.token);
    expect(json).not.toContain(auth.salt);
    engine.destroy();
    const restoredMemory = new Memory();
    const restored = new TrackEngine({
      storage: new Storage(account),
      memory: restoredMemory,
      connection: createConnection(auth),
    });
    await vi.waitFor(() => expect(restored.downloadsLoading).toBe(false));
    expect([...restoredMemory.downloads.values()][0]).toMatchObject({ track });
    expect(restored.getStatus(track.id)).toBe("downloaded");
    restored.destroy();
  });

  it("migrates legacy cached audio and remembers its original file date", async () => {
    const files = installOpfs(new File(["legacy"], "track.audio", { lastModified: 123 }));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    await engine.scanCached([{ id: "legacy", title: "Old song" }]);
    expect([...engineMemory.downloads.values()][0]).toMatchObject({
      track: { id: "legacy", title: "Old song" },
      downloadedAt: 123,
    });
    expect(JSON.parse(await files.get("downloads.json")!.text())).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("does not catalog failed or empty downloads and continues the queue", async () => {
    const files = installOpfs();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response(""))
        .mockResolvedValueOnce(new Response("audio")),
    );
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
      concurrency: 1,
    });
    const results = await Promise.allSettled([
      engine.cache({ id: "failed" }),
      engine.cache({ id: "empty" }),
      engine.cache({ id: "good" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(
      JSON.parse(await files.get("downloads.json")!.text()).map(
        (entry: { track: { id: string } }) => entry.track.id,
      ),
    ).toEqual(["good"]);
    expect(engine.getStatus("failed")).toBe("idle");
    engine.destroy();
  });

  it("removes missing file references on startup and rejects a corrupt catalog without overwriting it", async () => {
    const files = installOpfs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    await engine.cache({ id: "missing" });
    engine.destroy();
    for (const name of files.keys()) if (name.endsWith(".audio")) files.delete(name);
    const restoredMemory = new Memory();
    const restored = new TrackEngine({
      storage: new Storage(account),
      memory: restoredMemory,
      connection: createConnection(auth),
    });
    await vi.waitFor(() => expect(restored.downloadsLoading).toBe(false));
    expect(restoredMemory.downloads.size).toBe(0);
    expect(JSON.parse(await files.get("downloads.json")!.text())).toEqual([]);
    restored.destroy();
    files.set("downloads.json", new File(["not-json"], "downloads.json"));
    const brokenMemory = new Memory();
    const broken = new TrackEngine({
      storage: new Storage(account),
      memory: brokenMemory,
      connection: createConnection(auth),
    });
    await vi.waitFor(() => expect(broken.error).toBeDefined());
    await expect(broken.cache({ id: "new" })).rejects.toThrow();
    expect(await files.get("downloads.json")!.text()).toBe("not-json");
    broken.destroy();
  });

  it("finds cached MP3 fallback even when the browser reports raw support", async () => {
    installOpfs(null, "probably");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("mp3")),
    );
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    const track = { id: "flac", contentType: "audio/flac" };
    await engine.cache(track, { forceTranscode: true });
    expect((await engine.getSource(track)).cached).toBe(true);
    expect(engine.getStatus(track.id)).toBe("downloaded");
    engine.destroy();
  });

  it("serializes concurrent completions without losing catalog entries", async () => {
    const files = installOpfs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    await Promise.all(["one", "two", "three", "four"].map((id) => engine.cache({ id })));
    expect(JSON.parse(await files.get("downloads.json")!.text())).toHaveLength(4);
    expect(engineMemory.downloads.size).toBe(4);
    engine.destroy();
  });

  it("merges catalog completions across instances under the existing Web Lock", async () => {
    const files = installOpfs();
    const request = installTrackLocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const firstMemory = new Memory();
    const first = new TrackEngine({
      storage: new Storage(account),
      memory: firstMemory,
      connection: createConnection(auth),
    });
    const secondMemory = new Memory();
    const second = new TrackEngine({
      storage: new Storage(account),
      memory: secondMemory,
      connection: createConnection(auth),
    });
    try {
      await Promise.all([first.cache({ id: "one" }), second.cache({ id: "two" })]);
      const records = JSON.parse(await files.get("downloads.json")!.text());
      expect(records.map((record: { track: { id: string } }) => record.track.id).sort()).toEqual([
        "one",
        "two",
      ]);
      expect(request.mock.calls.some(([name]) => name === "music-web-downloads-index")).toBe(true);
      const restoredMemory = new Memory();
      const restored = new TrackEngine({
        storage: new Storage(account),
        memory: restoredMemory,
        connection: createConnection(auth),
      });
      try {
        await restored.ready();
        expect(restoredMemory.downloads.size).toBe(2);
      } finally {
        restored.destroy();
      }
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  it.each(["file reference", "duplicate key"])(
    "preserves a catalog with an invalid %s introduced after loading",
    async (invalid) => {
      const files = installOpfs();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("audio")),
      );
      const engineMemory = new Memory();
      const engine = new TrackEngine({
        storage: new Storage(account),
        memory: engineMemory,
        connection: createConnection(auth),
      });
      try {
        await engine.cache({ id: "one" });
        const records = JSON.parse(await files.get("downloads.json")!.text());
        if (invalid === "file reference") records[0].fileName = `${"0".repeat(64)}.audio`;
        else records.push(records[0]);
        const invalidCatalog = JSON.stringify(records);
        files.set("downloads.json", new File([invalidCatalog], "downloads.json"));
        await expect(engine.cache({ id: "two" })).rejects.toThrow("invalid file reference");
        expect(await files.get("downloads.json")!.text()).toBe(invalidCatalog);
      } finally {
        engine.destroy();
      }
    },
  );

  it("recovers a complete audio file after its first catalog write failed", async () => {
    const files = installOpfs(null, "", true);
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    await expect(engine.cache({ id: "one" })).rejects.toThrow("Catalog write failed");
    expect(engineMemory.downloads.size).toBe(0);
    await engine.cache({ id: "one", title: "Recovered" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(await files.get("downloads.json")!.text())[0].track.title).toBe("Recovered");
    engine.destroy();
  });

  it("keeps identical track IDs from different accounts separate", async () => {
    const files = installOpfs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    await engine.cache({ id: "one" });
    const other = { host: auth.host, username: "other" };
    engineMemory.account = other;
    await engine.restore(new Storage(other));
    engine.setConnection(createConnection({ ...auth, username: "other" }));
    expect(engine.getStatus("one")).toBe("idle");
    await engine.cache({ id: "one" });
    const records = JSON.parse(await files.get("downloads.json")!.text());
    expect(records).toHaveLength(2);
    expect(new Set(records.map((entry: { fileName: string }) => entry.fileName)).size).toBe(2);
    engine.destroy();
  });

  it("starts queued downloads in FIFO order and reuses duplicate requests", async () => {
    installOpfs();
    let resolve!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockImplementation(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
      concurrency: 1,
    });
    const active = engine.cache({ id: "active" });
    const queued = engine.cache({ id: "queued" });
    const last = engine.cache({ id: "last" });
    expect(engine.cache({ id: "last" })).toBe(last);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(engine.cache({ id: "active" })).toBe(active);
    expect(engine.downloadJobs.map((entry) => [entry.track.id, entry.status])).toEqual([
      ["active", "downloading"],
      ["queued", "queued"],
      ["last", "queued"],
    ]);
    expect(engine.getStatus("active")).toBe("downloading");
    expect(engine.getStatus("queued")).toBe("queued");
    resolve(new Response("audio"));
    await Promise.all([active, queued, last]);
    expect(engine.getStatus("active")).toBe("downloaded");
    expect(engineMemory.downloads.size).toBe(3);
    expect(engine.downloadJobs).toEqual([]);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("id"))).toEqual([
      "active",
      "queued",
      "last",
    ]);
    engine.destroy();
  });

  it.each(["detach", "destroy"])(
    "cancels queued and active work on %s without persisting it",
    async (action) => {
      const files = installOpfs();
      const fetcher = vi.fn(
        (_url, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const engineMemory = new Memory();
      const engine = new TrackEngine({
        storage: new Storage(account),
        memory: engineMemory,
        connection: createConnection(auth),
        concurrency: 1,
      });
      const result = Promise.allSettled([
        engine.cache({ id: "active" }),
        engine.cache({ id: "queued" }),
      ]);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      if (action === "detach") engine.setConnection(undefined);
      else engine.destroy();
      expect(engine.downloadJobs).toEqual([]);
      expect((await result).map((item) => item.status)).toEqual(["rejected", "rejected"]);
      expect(files.has("downloads.json")).toBe(false);
      expect(engineMemory.account).toEqual({ host: auth.host, username: auth.username });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(engine.error).toBeUndefined();
      engine.destroy();
    },
  );

  it("cancels an in-progress body and queued work when Network goes offline", async () => {
    const write = vi.fn();
    const files = installOpfs(null, "", false, write);
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel: cancelled,
    });
    const fetcher = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetcher);
    const network = new Network();
    const client = network.accept(network.prepare(auth));
    const memory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory,
      connection: client.audio,
      concurrency: 1,
    });
    const result = Promise.allSettled([
      engine.cache({ id: "active" }),
      engine.cache({ id: "queued" }),
    ]);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    network.setMode("offline");
    expect(await result).toEqual([
      { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
      { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
    ]);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(files.has("downloads.json")).toBe(false);
    expect(memory.downloads.size).toBe(0);
    expect(engine.downloadJobs).toEqual([]);
    expect(engine.error).toBeUndefined();
    network.setMode("online");
    engine.setConnection(network.open(auth).audio);
    fetcher.mockImplementation(async () => new Response("complete"));
    expect(await (await engine.cache({ id: "active" })).text()).toBe("complete");
    expect(memory.downloads.size).toBe(1);
    engine.destroy();
    network.setMode("offline");
  });

  it("ignores an aborted transfer even if its late response arrives during a retry", async () => {
    const files = installOpfs();
    const responses: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal("fetch", fetcher);
    const memory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory,
      connection: createConnection(auth),
    });
    const first = engine.cache({ id: "same" });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    engine.setConnection(undefined);
    await rejected;
    engine.setConnection(createConnection(auth));
    const retry = engine.cache({ id: "same" });
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    responses[0](new Response("old"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.downloadJobs).toHaveLength(1);
    expect(files.has("downloads.json")).toBe(false);
    responses[1](new Response("new"));
    await retry;
    expect(memory.downloads.size).toBe(1);
    expect(engine.error).toBeUndefined();
    engine.destroy();
  });

  it("filters offline tracks from memory without opening storage again", async () => {
    installOpfs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const connection = createConnection(auth);
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection,
    });
    await engine.cache({ id: "saved" });
    engine.destroy();
    const restoredMemory = new Memory();
    const restored = new TrackEngine({
      storage: new Storage(account),
      memory: restoredMemory,
      connection,
    });
    await restored.ready();
    const storage = vi.spyOn(navigator.storage, "getDirectory");
    storage.mockClear();
    expect(["saved", "missing"].filter((id) => restored.getStatus(id) === "downloaded")).toEqual([
      "saved",
    ]);
    await restored.ready();
    expect(restored.getStatus("saved")).toBe("downloaded");
    expect(storage).not.toHaveBeenCalled();
    restoredMemory.account = { host: auth.host, username: "other" };
    restored.setConnection(createConnection({ ...auth, username: "other" }));
    expect(restored.getStatus("saved")).toBe("idle");
    restoredMemory.account = { host: auth.host, username: auth.username };
    restored.setConnection(connection);
    expect(restored.getStatus("saved")).toBe("downloaded");
    expect(storage).not.toHaveBeenCalled();
    restored.destroy();
  });

  it("reports an in-progress transfer before an already downloaded format", async () => {
    installOpfs(null, "probably");
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    const track = { id: "saved", contentType: "audio/flac" };
    await engine.cache(track);
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = engine.cache(track, { forceTranscode: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(engine.getStatus(track.id)).toBe("downloading");
    resolve(new Response("mp3"));
    await pending;
    expect(engine.getStatus(track.id)).toBe("downloaded");
    engine.destroy();
  });

  it.each([
    { support: "probably", forceTranscode: false, format: "raw" },
    { support: "", forceTranscode: false, format: "mp3" },
    { support: "probably", forceTranscode: true, format: "mp3" },
  ] as const)(
    "streams $format with support='$support' and forceTranscode=$forceTranscode",
    async ({ support, forceTranscode, format }) => {
      installOpfs(null, support);
      const memory = new Memory();
      const engine = new TrackEngine({
        storage: new Storage(account),
        memory,
        connection: createConnection(auth),
      });
      const source = await engine.getSource(
        { id: "track-1", contentType: "audio/flac" },
        { forceTranscode },
      );
      const url = new URL(source.url);
      expect(url.pathname).toBe("/rest/stream.view");
      expect(url.searchParams.get("format")).toBe(format);
      expect(source.cached).toBe(false);
      expect(source.nativeSeeking).toBe(format === "raw");
      engine.destroy();
    },
  );

  it("requests an MP3 offset stream without downloading or caching a partial track", async () => {
    installOpfs(null, "probably");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    const source = await engine.getSource(
      { id: "track-1", contentType: "audio/flac" },
      { position: 120.5 },
    );
    const query = new URL(source.url).searchParams;
    expect(query.get("format")).toBe("mp3");
    expect(query.get("timeOffset")).toBe("120");
    expect(source.offset).toBe(120);
    expect(source.nativeSeeking).not.toBe(true);
    expect(source.cached).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(engine.getStatus("track-1")).toBe("idle");
    engine.destroy();
  });

  it("prefers a complete cached original for a resumed track", async () => {
    installOpfs(new File(["cached"], "track.audio"), "probably");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-track");
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });
    const source = await engine.getSource(
      { id: "track-1", contentType: "audio/flac" },
      { position: 120 },
    );
    expect(source).toEqual({ cached: true, url: "blob:cached-track" });
    engine.destroy();
  });

  it("owns cached object URLs through replacement, release, and destruction", async () => {
    installOpfs(new File(["cached"], "track.audio"));
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-track")
      .mockReturnValueOnce("blob:second-track")
      .mockReturnValueOnce("blob:third-track");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const memory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory,
      connection: createConnection(auth),
    });

    expect(await engine.getSource({ id: "track-1", contentType: "audio/flac" })).toEqual({
      cached: true,
      url: "blob:first-track",
    });
    expect(engine.getStatus("track-1")).toBe("downloaded");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await engine.getSource({ id: "track-2", contentType: "audio/flac" });
    expect(revokeObjectURL.mock.calls).toEqual([["blob:first-track"]]);
    engine.releaseSource();
    expect(revokeObjectURL.mock.calls).toEqual([["blob:first-track"], ["blob:second-track"]]);
    await engine.getSource({ id: "track-3", contentType: "audio/flac" });
    engine.destroy();
    expect(revokeObjectURL.mock.calls).toEqual([
      ["blob:first-track"],
      ["blob:second-track"],
      ["blob:third-track"],
    ]);
  });

  it("loads cached track state without returning storage details", async () => {
    installOpfs(new File(["cached"], "track.audio"));
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });

    const result = await engine.scanCached([{ id: "track-1" }, { id: "track-2" }]);

    expect(result).toBeUndefined();
    expect(engine.getStatus("track-1")).toBe("downloaded");
    expect(engine.getStatus("track-2")).toBe("downloaded");
  });

  it("handles unavailable browser storage while scanning", async () => {
    installOpfs();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => Promise.reject(new Error("Storage unavailable")) },
    });
    const engineMemory = new Memory();
    const engine = new TrackEngine({
      storage: new Storage(account),
      memory: engineMemory,
      connection: createConnection(auth),
    });

    await expect(engine.scanCached([{ id: "track-1" }])).resolves.toBeUndefined();
  });
});

function createConnection(auth: Parameters<Network["prepare"]>[0]) {
  const network = new Network();
  const client = network.prepare(auth);
  return network.accept(client).audio;
}

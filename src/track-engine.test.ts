import { afterEach, describe, expect, it, vi } from "vitest";
import { SubsonicClient } from "./subsonic-client";
import { TrackEngine } from "./track-engine";
import { OpfsTrackStore } from "./track-store";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

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
  it("reuses another writer's completed file even when the later response has failed", async () => {
    const files = installOpfs();
    installTrackLocks();
    const first = new OpfsTrackStore();
    const second = new OpfsTrackStore();
    const { descriptor, track } = download();
    const signal = new AbortController().signal;
    expect(await first.get(descriptor, track)).toBeNull();
    expect(await second.get(descriptor, track)).toBeNull();
    await first.put(descriptor, track, new Response("complete"), signal);
    const failed = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Network failed"));
        },
      }),
    );
    expect(await (await second.put(descriptor, track, failed, signal)).text()).toBe("complete");
    const records = JSON.parse(await files.get("downloads.json")!.text());
    expect(records).toHaveLength(1);
    expect(await files.get(records[0].fileName)!.text()).toBe("complete");
  });

  it.each([false, true])(
    "keeps a complete orphan when a later writer fails (locks: %s)",
    async (locks) => {
      const files = installOpfs(null, "", true);
      if (locks) installTrackLocks();
      const first = new OpfsTrackStore();
      const second = new OpfsTrackStore();
      const { descriptor, track } = download();
      const signal = new AbortController().signal;
      await expect(first.put(descriptor, track, new Response("complete"), signal)).rejects.toThrow(
        "Catalog write failed",
      );
      const failed = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Network failed"));
          },
        }),
      );
      await expect(second.put(descriptor, track, failed, signal)).rejects.toThrow("Network failed");
      const fileName = [...files.keys()].find((name) => name.endsWith(".audio"))!;
      expect(await files.get(fileName)!.text()).toBe("complete");
      expect(await (await second.get(descriptor, track))!.text()).toBe("complete");
      expect(JSON.parse(await files.get("downloads.json")!.text())).toHaveLength(1);
    },
  );

  it("does not mistake a rejected truncated file for a completed concurrent download", async () => {
    const files = installOpfs();
    installTrackLocks();
    const store = new OpfsTrackStore();
    const { descriptor, track } = download();
    const signal = new AbortController().signal;
    await store.put(descriptor, track, new Response("complete"), signal);
    const [record] = JSON.parse(await files.get("downloads.json")!.text());
    files.set(record.fileName, new File(["x"], record.fileName));
    expect(await store.get(descriptor, track)).toBeNull();
    expect(
      await (await store.put(descriptor, track, new Response("repaired"), signal)).text(),
    ).toBe("repaired");
    expect(await files.get(record.fileName)!.text()).toBe("repaired");
  });

  it.each(["complete", "fail", "cancel waiter"])(
    "coordinates simultaneous audio writers when the first writer will %s",
    async (outcome) => {
      const audioWrite = vi.fn();
      const files = installOpfs(null, "", false, audioWrite);
      const request = installTrackLocks();
      const first = new OpfsTrackStore();
      const second = new OpfsTrackStore();
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
      const writing = first.put(descriptor, track, source, signal);
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
      const waiting = second.put(descriptor, track, unused, abort.signal);
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
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
    const restored = new TrackEngine({ client: new SubsonicClient(auth) });
    await vi.waitFor(() => expect(restored.downloadsLoading).toBe(false));
    expect(restored.downloads[0]).toMatchObject({ track, status: "downloaded" });
    expect(restored.getStatus(track.id)).toBe("downloaded");
    restored.destroy();
  });

  it("lists active jobs, queued jobs, and newest completed files in that order", async () => {
    const files = installOpfs();
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const engine = new TrackEngine({ client: new SubsonicClient(auth), concurrency: 1 });
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    await engine.cache({ id: "old" });
    await engine.cache({ id: "new" });
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const first = engine.cache({ id: "active" });
    const second = engine.cache({ id: "queued" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(engine.downloads.map((entry) => [entry.track.id, entry.status])).toEqual([
      ["active", "downloading"],
      ["queued", "queued"],
      ["new", "downloaded"],
      ["old", "downloaded"],
    ]);
    expect(engine.getStatus("queued")).toBe("queued");
    expect(JSON.parse(await files.get("downloads.json")!.text())).toHaveLength(2);
    resolve(new Response("audio"));
    await Promise.all([first, second]);
    expect(engine.downloads).toHaveLength(4);
    expect(engine.downloads.every((entry) => entry.status === "downloaded")).toBe(true);
    engine.destroy();
  });

  it("migrates legacy cached audio and remembers its original file date", async () => {
    const files = installOpfs(new File(["legacy"], "track.audio", { lastModified: 123 }));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
    await engine.scanCached([{ id: "legacy", title: "Old song" }]);
    expect(engine.downloads[0]).toMatchObject({
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth), concurrency: 1 });
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
    await engine.cache({ id: "missing" });
    engine.destroy();
    for (const name of files.keys()) if (name.endsWith(".audio")) files.delete(name);
    const restored = new TrackEngine({ client: new SubsonicClient(auth) });
    await vi.waitFor(() => expect(restored.downloadsLoading).toBe(false));
    expect(restored.downloads).toEqual([]);
    expect(JSON.parse(await files.get("downloads.json")!.text())).toEqual([]);
    restored.destroy();
    files.set("downloads.json", new File(["not-json"], "downloads.json"));
    const broken = new TrackEngine({ client: new SubsonicClient(auth) });
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
    await Promise.all(["one", "two", "three", "four"].map((id) => engine.cache({ id })));
    expect(JSON.parse(await files.get("downloads.json")!.text())).toHaveLength(4);
    expect(engine.downloads).toHaveLength(4);
    engine.destroy();
  });

  it("merges catalog completions across instances under the existing Web Lock", async () => {
    const files = installOpfs();
    const request = installTrackLocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const first = new TrackEngine({ client: new SubsonicClient(auth) });
    const second = new TrackEngine({ client: new SubsonicClient(auth) });
    try {
      await Promise.all([first.cache({ id: "one" }), second.cache({ id: "two" })]);
      const records = JSON.parse(await files.get("downloads.json")!.text());
      expect(records.map((record: { track: { id: string } }) => record.track.id).sort()).toEqual([
        "one",
        "two",
      ]);
      expect(request.mock.calls.some(([name]) => name === "music-web-downloads-index")).toBe(true);
      const restored = new TrackEngine({ client: new SubsonicClient(auth) });
      try {
        await restored.ready();
        expect(restored.downloads).toHaveLength(2);
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
      const engine = new TrackEngine({ client: new SubsonicClient(auth) });
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
    await expect(engine.cache({ id: "one" })).rejects.toThrow("Catalog write failed");
    expect(engine.downloads).toEqual([]);
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
    await engine.cache({ id: "one" });
    engine.setClient(new SubsonicClient({ ...auth, username: "other" }));
    expect(engine.getStatus("one")).toBe("idle");
    await engine.cache({ id: "one" });
    const records = JSON.parse(await files.get("downloads.json")!.text());
    expect(records).toHaveLength(2);
    expect(new Set(records.map((entry: { fileName: string }) => entry.fileName)).size).toBe(2);
    engine.destroy();
  });

  it("prioritizes a playback seek over bulk queued downloads", async () => {
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
    const engine = new TrackEngine({ client: new SubsonicClient(auth), concurrency: 1 });
    const active = engine.cache({ id: "active" });
    const queued = engine.cache({ id: "queued" });
    const seek = engine.cache({ id: "seek" }, { priority: "playback" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(engine.downloads.map((entry) => entry.track.id)).toEqual(["active", "seek", "queued"]);
    resolve(new Response("audio"));
    await Promise.all([active, queued, seek]);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("id"))).toEqual([
      "active",
      "seek",
      "queued",
    ]);
    engine.destroy();
  });

  it("cancels queued and active work on destruction without persisting it", async () => {
    const files = installOpfs();
    const fetcher = vi.fn(
      (_url, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engine = new TrackEngine({ client: new SubsonicClient(auth), concurrency: 1 });
    const result = Promise.allSettled([
      engine.cache({ id: "active" }),
      engine.cache({ id: "queued" }),
    ]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    engine.destroy();
    expect((await result).map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(files.has("downloads.json")).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("filters offline tracks from memory without opening storage again", async () => {
    installOpfs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const client = new SubsonicClient(auth);
    const engine = new TrackEngine({ client });
    await engine.cache({ id: "saved" });
    engine.destroy();
    const restored = new TrackEngine({ client });
    await restored.ready();
    const storage = vi.spyOn(navigator.storage, "getDirectory");
    storage.mockClear();
    expect(["saved", "missing"].filter((id) => restored.getStatus(id) === "downloaded")).toEqual([
      "saved",
    ]);
    await restored.ready();
    expect(restored.getStatus("saved")).toBe("downloaded");
    expect(storage).not.toHaveBeenCalled();
    restored.setClient(new SubsonicClient({ ...auth, username: "other" }));
    expect(restored.getStatus("saved")).toBe("idle");
    restored.setClient(client);
    expect(restored.getStatus("saved")).toBe("downloaded");
    expect(storage).not.toHaveBeenCalled();
    restored.destroy();
  });

  it("reports an in-progress transfer before an already downloaded format", async () => {
    installOpfs(null, "probably");
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });
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

  it("uses the original format when the browser supports it", async () => {
    installOpfs(null, "probably");
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    const source = await engine.getSource({ id: "track-1", contentType: "audio/flac" });

    expect(new URL(source.url).searchParams.get("format")).toBe("raw");
  });

  it("can force MP3 when a browser rejects a reportedly supported format", async () => {
    installOpfs(null, "probably");
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    const source = await engine.getSource(
      { id: "track-1", contentType: "audio/flac" },
      { forceTranscode: true },
    );

    expect(new URL(source.url).searchParams.get("format")).toBe("mp3");
  });

  it("falls back to MP3 for unsupported formats", async () => {
    installOpfs();
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    const source = await engine.getSource({ id: "track-1", contentType: "audio/unknown" });

    expect(new URL(source.url).searchParams.get("format")).toBe("mp3");
  });

  it("returns and releases an object URL for cached tracks", async () => {
    installOpfs(new File(["cached"], "track.audio"));
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-track");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    const source = await engine.getSource({ id: "track-1", contentType: "audio/flac" });

    expect(source.cached).toBe(true);
    expect(engine.getStatus("track-1")).toBe("downloaded");
    expect(source.url).toBe("blob:cached-track");
    expect(createObjectURL).toHaveBeenCalledOnce();
    engine.releaseSource();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cached-track");
  });

  it("releases the previous object URL when resolving another source", async () => {
    installOpfs(new File(["cached"], "track.audio"));
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-track")
      .mockReturnValueOnce("blob:second-track");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    await engine.getSource({ id: "track-1", contentType: "audio/flac" });
    await engine.getSource({ id: "track-2", contentType: "audio/flac" });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-track");
    engine.destroy();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second-track");
  });

  it("returns the Navidrome URL when a track is not cached", async () => {
    installOpfs();
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    const source = await engine.getSource({ id: "track-1" });

    expect(source.cached).toBe(false);
    expect(source.url).toContain("/rest/stream.view?");
    expect(source).not.toHaveProperty("release");
  });

  it("loads cached track state without returning storage details", async () => {
    installOpfs(new File(["cached"], "track.audio"));
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

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
    const engine = new TrackEngine({ client: new SubsonicClient(auth) });

    await expect(engine.scanCached([{ id: "track-1" }])).resolves.toBeUndefined();
  });

  it("exposes downloading and downloaded state", async () => {
    installOpfs();
    let statusDuringFetch = "";
    let engine: TrackEngine;
    const fetcher = vi.fn(async () => {
      statusDuringFetch = engine.getStatus("track-1");
      return new Response("audio");
    });
    vi.stubGlobal("fetch", fetcher);
    engine = new TrackEngine({ client: new SubsonicClient(auth) });
    const track = { id: "track-1" };

    await Promise.all([engine.cache(track), engine.cache(track)]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(statusDuringFetch).toBe("downloading");
    expect(engine.getStatus(track.id)).toBe("downloaded");
  });
});

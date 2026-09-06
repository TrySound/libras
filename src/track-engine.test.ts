import { afterEach, describe, expect, it, vi } from "vitest";
import { SubsonicClient } from "./subsonic-client";
import { TrackEngine } from "./track-engine";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("track engine", () => {
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

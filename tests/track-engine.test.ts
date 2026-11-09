import { getAccountKey } from "../src/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Network } from "../src/network.svelte";
import { TrackEngine } from "../src/track.svelte";
import { Cache, downloadKey } from "../src/cache.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { completedDownloadCount, expectCompletedDownload, installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const auth = {
  ...account,
  credentials: {
    method: "token" as const,
    username: account.username,
    token: "token",
    salt: "salt",
  },
};
const track = {
  id: "track",
  title: "Track",
  artist: "Artist",
  album: "Album",
  contentType: "audio/flac",
};
const engines: TrackEngine[] = [];
function install(support = "") {
  const disk = installDisk();
  vi.stubGlobal("document", { createElement: () => ({ canPlayType: () => support }) });
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:track-${++sequence}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return disk;
}
function connection(credentials = auth) {
  const network = new Network();
  return network.accept(network.prepare(credentials)).audio;
}
function setup(options: { cache?: Cache; online?: boolean; concurrency?: number } = {}) {
  const selection = new TestSelection();
  const cache = options.cache ?? new Cache(getAccountKey(account));
  selection.cache = cache;
  const engine = new TrackEngine({
    selection,
    concurrency: options.concurrency,
  });
  if (options.online) {
    const audio = connection();
    engine.setPlaybackConnection(audio);
    engine.setDownloadConnection(audio);
  }
  engines.push(engine);
  engine.activate();
  return { selection, cache, engine };
}
async function seed(cache = new Cache(getAccountKey(account)), format: "raw" | "mp3" = "mp3") {
  await cache.saveDownload(
    track,
    format,
    format === "mp3" ? "audio/mpeg" : "audio/flac",
    new Response("cached"),
    new AbortController().signal,
  );
  await cache.flush();
  return cache;
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TrackEngine using Cache", () => {
  it("batches only missing tracks, skipping either saved format and pending jobs in input order", async () => {
    install();
    const { cache, engine } = setup({ online: true, concurrency: 1 });
    for (const format of ["raw", "mp3"] as const) {
      await cache.saveDownload(
        { ...track, id: `saved-${format}` },
        format,
        "audio/mpeg",
        new Response("cached"),
        new AbortController().signal,
      );
    }
    const pending = deferred<Response>();
    const fetcher = vi
      .fn(async () => new Response("audio"))
      .mockImplementationOnce(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const active = engine.download("active");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const queued = engine.download("queued");
    const download = vi.spyOn(engine, "download");
    const read = vi.spyOn(cache, "readDownload");
    const ids = ["saved-raw", "active", "new-a", "queued", "new-a", "saved-mp3", "new-b"];
    engine.downloadMany(ids);
    engine.downloadMany(ids);
    expect(download.mock.calls.map(([id]) => id)).toEqual(["new-a", "new-b"]);
    expect(engine.downloadJobs.map((job) => job.track.id)).toEqual([
      "active",
      "queued",
      "new-a",
      "new-b",
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    pending.resolve(new Response("audio"));
    await active;
    await queued;
    await vi.waitFor(() => expect(engine.downloadJobs).toHaveLength(0));
    expect(engine.getStatus("new-a")).toBe("downloaded");
    expect(engine.getStatus("new-b")).toBe("downloaded");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not require a connection or disk reads for an already saved batch", async () => {
    install("probably");
    const { cache, engine } = setup({ cache: await seed() });
    const read = vi.spyOn(cache, "readDownload");
    const download = vi.spyOn(engine, "download");
    engine.downloadMany([track.id, track.id]);
    engine.downloadMany([]);
    expect(download).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("deduplicates waiting offline intent without reporting a setup failure", async () => {
    install();
    const { engine, cache } = setup();
    engine.downloadMany(["missing", "missing"]);
    await vi.waitFor(() => expect(cache.downloads.size).toBe(1));
    expect(engine.downloadCount).toBe(1);
    expect(engine.getStatus("missing")).toBe("queued");
  });

  it("continues a batch after an individual transfer fails", async () => {
    install();
    const { engine } = setup({ online: true, concurrency: 1 });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("failure", { status: 500 }))
        .mockResolvedValueOnce(new Response("audio")),
    );
    engine.downloadMany(["bad", "good"]);
    await vi.waitFor(() => expect(engine.getStatus("good")).toBe("downloaded"));
    expect(engine.downloadJobs).toHaveLength(0);
    expect(engine.getStatus("bad")).toBe("failed");
  });

  it.each([undefined, "Track artist"])(
    "resolves download metadata from the selected cache (artist override: %s)",
    async (artistName) => {
      install("probably");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("audio")),
      );
      const { cache, engine } = setup({ online: true });
      await cache.replaceLibrary({
        artists: [{ id: "artist", name: "Library artist" }],
        albums: [{ id: "album", artistIds: ["artist"], title: "Library album", genres: [] }],
        tracks: [
          {
            id: track.id,
            title: "Library track",
            artistIds: ["artist"],
            displayArtist: artistName,
            albumId: "album",
            mimeType: "audio/flac",
            genres: [],
          },
        ],
        lastModified: 1,
        savedAt: 1,
      });

      const pending = engine.download(track.id);
      expect(engine.downloadJobs[0]).toMatchObject({
        format: "raw",
        track: {
          id: track.id,
          title: "Library track",
          artist: artistName ?? "Library artist",
          album: "Library album",
          contentType: "audio/flac",
        },
      });
      await pending;
      expect(expectCompletedDownload(cache, downloadKey(track.id, "raw")).track.title).toBe(
        "Library track",
      );
    },
  );

  it("downloads a normalized single by its server ID and restores its source offline", async () => {
    install();
    const network = new Network();
    const connection = network.accept(network.prepare(auth));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("search3.view")) {
        return new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              searchResult3: {
                song:
                  url.searchParams.get("songOffset") === "0"
                    ? [
                        {
                          id: "single",
                          title: "Standalone",
                          displayArtist: "Solo",
                          contentType: "audio/mpeg",
                        },
                      ]
                    : [],
              },
            },
          }),
        );
      }
      expect(url.pathname).toMatch(/stream.view$/);
      expect(url.searchParams.get("id")).toBe("single");
      return new Response("audio bytes", { headers: { "Content-Type": "audio/mpeg" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const { cache, engine, selection } = setup();
    await cache.replaceLibrary({
      ...(await connection.metadata.readLibrary(connection.signal)),
      savedAt: 1,
      lastModified: null,
    });
    engine.setDownloadConnection(connection.audio);
    await engine.download("single", { format: "mp3" });
    expect(expectCompletedDownload(cache, downloadKey("single", "mp3")).track).toMatchObject({
      id: "single",
      title: "Standalone",
      artist: "Solo",
      album: "Singles",
    });
    await cache.flush();
    const restored = new Cache(cache.key);
    await restored.load();
    selection.cache = restored;
    engine.activate();
    network.setMode("offline");
    engine.setDownloadConnection(undefined);
    engine.setPlaybackConnection(undefined);
    const requestCount = fetcher.mock.calls.length;
    const source = await engine.getSource({ id: "single" });
    expect(source).toMatchObject({ cached: true, url: "blob:track-1" });
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
    source.release();
  });

  it("exposes a safe setup error without an account", async () => {
    install();
    const { engine, selection } = setup();
    selection.cache = undefined;
    await expect(engine.download(track.id)).rejects.toBeInstanceOf(Error);
    expect(engine.downloadJobs).toEqual([]);
  });

  it("keeps queued intent when the connection owner has already interrupted execution", async () => {
    install();
    const { engine, cache } = setup();
    const controller = new AbortController();
    controller.abort();
    engine.setDownloadConnection({ ...connection(), signal: controller.signal });
    void engine.download(track.id);
    await vi.waitFor(() => expect(cache.downloads.size).toBe(1));
    expect(engine.getStatus(track.id)).toBe("queued");
  });

  it("reads normalized Cache records and owns offline playback URLs", async () => {
    const disk = install();
    await seed();
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    const { engine, selection } = setup({ cache });
    expect(cache.tracks.size).toBe(0);
    const record = expectCompletedDownload(cache, downloadKey(track.id, "mp3"));
    expect(record).not.toHaveProperty("key");
    expect(record).not.toHaveProperty("host");
    expect(expectCompletedDownload(selection.cache!, downloadKey(track.id, "mp3"))).toEqual(record);
    disk.getDirectory.mockClear();
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(engine.downloadJobs).toEqual([]);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const first = await engine.getSource(track);
    expect(first).toMatchObject({ cached: true, url: "blob:track-1" });
    engine.setPlaybackConnection(connection());
    engine.setPlaybackConnection(undefined);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(engine.getStatus(track.id)).toBe("downloaded");
    const second = await engine.getSource(track);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    first.release();
    first.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:track-1");
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-2");
    await engine.getSource(track);
    engine.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-3");
  });

  it("allows concurrent source requests and independent handle lifetimes", async () => {
    install();
    const { engine } = setup({ cache: await seed() });
    const controller = new AbortController();
    const [first, second] = await Promise.all([
      engine.getSource(track, { signal: controller.signal }),
      engine.getSource(track),
    ]);
    expect(first.url).not.toBe(second.url);
    controller.abort();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    first.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(first.url);
    engine.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith(second.url);
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("aborting one pending source does not cancel another", async () => {
    const disk = install();
    const { engine } = setup({ cache: await seed() });
    const gate = deferred();
    const reading = deferred();
    disk.state.beforeRead = async (path) => {
      if (path.endsWith(".audio")) {
        disk.state.beforeRead = async () => {};
        reading.resolve();
        await gate.promise;
      }
    };
    const controller = new AbortController();
    const first = engine.getSource(track, { signal: controller.signal });
    const reason = new Error("Source request canceled");
    const rejected = expect(first).rejects.toBe(reason);
    await reading.promise;
    const second = engine.getSource(track);
    controller.abort(reason);
    gate.resolve();
    await rejected;
    expect((await second).cached).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("waits behind Cache's pending load", async () => {
    const disk = install();
    await seed();
    const reading = deferred();
    const gate = deferred();
    disk.state.beforeRead = async (path) => {
      if (path.endsWith("/downloads.json")) {
        reading.resolve();
        await gate.promise;
      }
    };
    const { cache, engine } = setup();
    const loading = cache.load();
    await reading.promise;
    const source = engine.getSource(track);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    gate.resolve();
    await loading;
    expect((await source).cached).toBe(true);
    expect(engine.getStatus(track.id)).toBe("downloaded");
  });

  it("exposes load errors without maintaining a second catalog", async () => {
    const disk = install();
    await seed();
    const path = [...disk.files.keys()].find((path) => path.endsWith("/downloads.json"))!;
    disk.files.set(path, "broken");
    const { cache, engine } = setup();
    await expect(cache.load()).rejects.toThrow();
    expect(cache.error).toBeInstanceOf(AggregateError);
    engine.activate();
    expect(disk.files.get(path)).toBe("broken");
  });

  it("publishes only complete files and removes jobs after durable save", async () => {
    const disk = install();
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const { engine, selection, cache } = setup({ online: true });
    expect(engine.getStatus(track.id)).toBe("idle");
    expect(engine.downloadCount).toBe(0);
    const pending = engine.download(track.id);
    expect(cache.downloads.has(downloadKey(track.id, "mp3"))).toBe(false);
    expect(engine.getStatus(track.id)).toBe("queued");
    expect(engine.downloadCount).toBe(1);
    expect(completedDownloadCount(selection.cache!)).toBe(0);
    response.resolve(new Response("audio"));
    await pending;
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(engine.downloadJobs).toEqual([]);
    expectCompletedDownload(selection.cache!, downloadKey(track.id, "mp3"));
    expect(completedDownloadCount(cache)).toBe(1);
    expect(disk.blobs.size).toBe(1);
    const json = [...disk.files.values()].join();
    for (const secret of ["token", "salt", "blob:", "downloading", "queued", "getStream"])
      expect(json).not.toContain(secret);
  });

  it("uses FIFO scheduling, bounded concurrency and duplicate job promises", async () => {
    install();
    const response = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockImplementation(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    const { engine, cache } = setup({ online: true, concurrency: 1 });
    const active = engine.download("active");
    const queued = engine.download("queued");
    const last = engine.download("last");
    expect(engine.download("active")).toBe(active);
    expect(engine.download("last")).toBe(last);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cache.downloads.size).toBe(3));
    expect(engine.downloadJobs.map((job) => [job.track.id, job.status])).toEqual([
      ["active", "downloading"],
      ["queued", "queued"],
      ["last", "queued"],
    ]);
    expect(engine.getStatus("queued")).toBe("queued");
    response.resolve(new Response("audio"));
    await Promise.all([active, queued, last]);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("id"))).toEqual([
      "active",
      "queued",
      "last",
    ]);
    expect(completedDownloadCount(cache)).toBe(3);
  });

  it.each(["HTTP", "binary"])(
    "continues queued work after %s failure and permits retry",
    async (failure) => {
      const disk = install();
      const fetcher = vi
        .fn()
        .mockImplementationOnce(
          async () => new Response("bad", { status: failure === "HTTP" ? 500 : 200 }),
        )
        .mockImplementation(async () => new Response("good"));
      vi.stubGlobal("fetch", fetcher);
      if (failure === "binary")
        disk.state.beforeWrite = (path) => {
          if (path.endsWith(".audio")) {
            disk.state.beforeWrite = () => {};
            throw new Error("Storage full");
          }
        };
      const { engine, cache } = setup({ online: true, concurrency: 1 });
      const results = await Promise.allSettled([engine.download("bad"), engine.download("good")]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(engine.getStatus("bad")).toBe("failed");
      expect(engine.getStatus("good")).toBe("downloaded");
      expect(disk.blobs.size).toBe(1);
      expect(await (await engine.download("bad", { format: "mp3" })).text()).toBe("good");
      await vi.waitFor(() => expect(completedDownloadCount(cache)).toBe(2));
    },
  );

  it("reuses a completed download without fetching or blocking streaming", async () => {
    install();
    const cache = await seed();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { engine } = setup({ cache });
    expect(await (await engine.download(track.id)).text()).toBe("cached");
    expect(fetcher).not.toHaveBeenCalled();
    engine.setPlaybackConnection(connection());
    const source = await engine.getSource({ id: "remote" });
    expect(source.cached).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps missing completed bytes queued offline without adopting old bytes, then resolves on connection", async () => {
    const disk = install();
    const cache = await seed();
    const fetcher = vi.fn(async () => new Response("replacement"));
    vi.stubGlobal("fetch", fetcher);
    const { engine } = setup({ cache });
    expect(await (await engine.download(track.id)).text()).toBe("cached");
    disk.blobs.clear();
    disk.files.set("tracks/old.audio", "legacy");
    const pending = engine.download(track.id);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(engine.getStatus(track.id)).toBe("queued"));
    expect(engine.download(track.id)).toBe(pending);
    await turn();
    expect(settled).toBe(false);
    expect(cache.downloads.get(downloadKey(track.id, "mp3"))?.status).toBe("queued");
    expect(fetcher).not.toHaveBeenCalled();
    expect(disk.files.get("tracks/old.audio")).toBe("legacy");
    engine.setDownloadConnection(connection());
    expect(await (await pending).text()).toBe("replacement");
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses MP3 fallback offline despite claimed raw support", async () => {
    install("probably");
    const { engine } = setup({ cache: await seed() });
    expect((await engine.getSource(track)).cached).toBe(true);
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe("audio/mpeg");
  });

  it("uses saved MP3 when reading a completed raw file is denied", async () => {
    const disk = install("probably");
    const cache = await seed();
    await seed(cache, "raw");
    const raw = expectCompletedDownload(cache, downloadKey(track.id, "raw"));
    disk.state.beforeRead = async (path) => {
      if (path.endsWith(raw.fileName)) throw new DOMException("Denied", "NotAllowedError");
    };
    const { engine } = setup({ cache });
    const source = await engine.getSource(track);
    expect(source.cached).toBe(true);
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe("audio/mpeg");
    source.release();
  });

  it("streams denied cached audio but preserves unavailable-source and unrelated failures", async () => {
    const disk = install("probably");
    const cache = await seed(undefined, "raw");
    disk.state.beforeRead = async (path) => {
      if (path.endsWith(".audio")) throw new DOMException("Denied", "NotAllowedError");
    };
    const { engine } = setup({ cache, online: true });
    const source = await engine.getSource(track);
    expect(source.cached).toBe(false);
    expect(new URL(source.url).pathname).toBe("/rest/stream.view");
    const failure = new Error("Stream source failed");
    engine.setPlaybackConnection({ ...connection(), url: vi.fn().mockRejectedValue(failure) });
    await expect(engine.getSource(track)).rejects.toBe(failure);
    engine.setPlaybackConnection(undefined);
    await expect(engine.getSource(track)).rejects.toThrow(
      "This track is not downloaded. Connect to its music server to stream it.",
    );
    vi.spyOn(cache, "readDownload").mockRejectedValue(failure);
    await expect(engine.getSource(track)).rejects.toBe(failure);
  });

  it.each([
    { support: "probably", forceTranscode: false, format: "raw" },
    { support: "", forceTranscode: false, format: "mp3" },
    { support: "probably", forceTranscode: true, format: "mp3" },
  ])(
    "streams $format with support=$support and forceTranscode=$forceTranscode",
    async ({ support, forceTranscode, format }) => {
      install(support);
      const { engine } = setup({ online: true });
      const source = await engine.getSource(track, { forceTranscode });
      const url = new URL(source.url);
      expect(url.pathname).toBe("/rest/stream.view");
      expect(url.searchParams.get("format")).toBe(format);
      expect(source.cached).toBe(false);
      expect(source.nativeSeeking).toBe(format === "raw");
    },
  );

  it.each([
    "audio/mpeg",
    "audio/mp3",
    "audio/x-mp3",
    "Audio/MPEG; charset=binary",
    "application/octet-stream",
    undefined,
  ])("does not assume a server-side offset for %s sources", async (contentType) => {
    install("probably");
    const { engine } = setup({ online: true });
    for (const forceTranscode of [false, true]) {
      const source = await engine.getSource(
        { ...track, contentType },
        { position: 45.5, forceTranscode },
      );
      expect(new URL(source.url).searchParams.has("timeOffset")).toBe(false);
      expect(source.offset).toBeUndefined();
    }
  });

  it("uses an MP3 offset URL without saving partial tracks, but prefers cached originals", async () => {
    const disk = install("probably");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { engine, cache } = setup({ online: true });
    const source = await engine.getSource(track, { position: 120.5 });
    expect(new URL(source.url).searchParams.get("timeOffset")).toBe("120");
    expect(new URL(source.url).searchParams.get("format")).toBe("mp3");
    expect(source.offset).toBe(120);
    expect(source.nativeSeeking).not.toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(disk.blobs.size).toBe(0);
    await seed(cache, "raw");
    expect(await engine.getSource(track, { position: 120 })).toMatchObject({
      cached: true,
      url: "blob:track-1",
    });
  });

  it("reports active downloads before an already completed alternative format", async () => {
    install("probably");
    const cache = await seed(undefined, "raw");
    const { engine } = setup({ cache, online: true });
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const pending = engine.download(track.id, { forceTranscode: true });
    expect(engine.getStatus(track.id)).toBe("queued");
    response.resolve(new Response("mp3"));
    await pending;
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(completedDownloadCount(cache)).toBe(2);
  });

  it.each(["detach", "destroy", "activate"])(
    "cancels active and queued requests on %s",
    async (action) => {
      const disk = install();
      const fetcher = vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const { engine, cache } = setup({ online: true, concurrency: 1 });
      const results = Promise.allSettled([engine.download("active"), engine.download("queued")]);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      if (action === "detach") engine.setDownloadConnection(undefined);
      else if (action === "destroy") engine.destroy();
      else engine.activate();
      expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(engine.downloadCount).toBe(2);
      expect(completedDownloadCount(cache)).toBe(0);
      expect(disk.blobs.size).toBe(0);
    },
  );

  it("interrupts an in-progress stream and queued work when download access closes", async () => {
    const disk = install();
    const wrote = deferred();
    disk.state.beforeWrite = (path) => {
      if (path.endsWith(".audio")) wrote.resolve();
    };
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel,
    });
    const fetcher = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetcher);
    const network = new Network();
    const controller = new AbortController();
    const { engine, cache } = setup({ concurrency: 1 });
    engine.setDownloadConnection(network.open(auth, controller.signal).audio);
    const results = Promise.allSettled([engine.download("active"), engine.download("queued")]);
    await wrote.promise;
    controller.abort();
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(disk.blobs.size).toBe(0);
    expect(completedDownloadCount(cache)).toBe(0);
    expect(engine.downloadCount).toBe(2);
  });

  it.each(["listener", "other"])(
    "isolates late downloads after selecting another cache (%s)",
    async (username) => {
      const disk = install();
      const first = deferred<Response>();
      const next = deferred<Response>();
      const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
      vi.stubGlobal("fetch", fetcher);
      const { engine, selection, cache } = setup({ online: true });
      const old = engine.download(track.id);
      const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      selection.cache = new Cache(getAccountKey({ ...account, username }));
      engine.activate();
      engine.setDownloadConnection(
        connection({ ...auth, username, credentials: { ...auth.credentials, username } }),
      );
      await rejected;
      const retry = engine.download(track.id);
      await turn();
      expect(fetcher).toHaveBeenCalledOnce();
      const cancel = vi.fn();
      const late = new Response(new ReadableStream({ cancel }));
      first.resolve(late);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(cancel).toHaveBeenCalledOnce();
      expect(engine.downloadJobs).toHaveLength(1);
      next.resolve(new Response("new"));
      await retry;
      expect(completedDownloadCount(cache)).toBe(0);
      expect(completedDownloadCount(selection.cache)).toBe(1);
      expect(disk.blobs.size).toBe(1);
    },
  );

  it.each(["switch", "abort", "destroy", "disconnect"])(
    "rejects a late cached source after %s",
    async (action) => {
      const disk = install();
      const { cache, engine, selection } = setup({ cache: await seed() });
      const gate = deferred();
      const reading = deferred();
      disk.state.beforeRead = async (path) => {
        if (path.endsWith(".audio")) {
          disk.state.beforeRead = async () => {};
          reading.resolve();
          await gate.promise;
        }
      };
      const controller = new AbortController();
      const pending = engine.getSource(track, { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await reading.promise;
      if (action === "switch") {
        selection.cache = new Cache(getAccountKey(account));
        engine.activate();
      }
      if (action === "abort") controller.abort();
      if (action === "destroy") engine.destroy();
      if (action === "disconnect") engine.setPlaybackConnection(connection());
      gate.resolve();
      await rejected;
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(completedDownloadCount(cache)).toBe(1);
    },
  );

  it("does not stream with a foreign connection and drops old account resources on activation", async () => {
    install();
    const { engine, selection } = setup({ cache: await seed(), online: true });
    await engine.getSource(track);
    selection.cache = new Cache(getAccountKey({ ...account, username: "other" }));
    engine.activate();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-1");
    expect(engine.getStatus(track.id)).toBe("idle");
    expect(completedDownloadCount(selection.cache!)).toBe(0);
    await expect(engine.getSource(track)).rejects.toThrow("Connect");
  });

  it.each(["beforeWrite", "afterClose"] as const)(
    "prevents late publication when detached at binary %s",
    async (stage) => {
      const disk = install();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("audio")),
      );
      const { engine, cache } = setup({ online: true });
      const save = vi.spyOn(cache, "saveDownload");
      disk.state[stage] = (path) => {
        if (path.endsWith(".audio")) engine.setDownloadConnection(undefined);
      };
      await expect(engine.download(track.id)).rejects.toMatchObject({ name: "AbortError" });
      if (stage === "beforeWrite")
        await expect(save.mock.results[0].value).rejects.toMatchObject({ name: "AbortError" });
      else await expect(save.mock.results[0].value).resolves.toBeInstanceOf(File);
      expect(completedDownloadCount(cache)).toBe(stage === "afterClose" ? 1 : 0);
      expect(disk.blobs.size).toBe(stage === "afterClose" ? 1 : 0);
    },
  );

  it("merges concurrent completions and reuses duplicate downloads in one cache", async () => {
    const disk = install();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const first = setup({ online: true });
    const second = setup({ online: true, cache: first.cache });
    await Promise.all([
      first.engine.download(track.id),
      second.engine.download(track.id),
      second.engine.download("other"),
    ]);
    expect(disk.blobs.size).toBe(2);
    await first.cache.flush();
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(completedDownloadCount(restored)).toBe(2);
  });

  it.each([0, -1, 1.5])("rejects invalid download concurrency %s", (concurrency) => {
    install();
    expect(() => setup({ concurrency })).toThrow("positive integer");
  });
});

describe("durable download scheduling", () => {
  it("counts six distinct files with three active, three queued, deduplicated batches and independent formats", async () => {
    install("probably");
    const { engine, cache } = setup({ online: true });
    const releases: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => releases.push(() => resolve(new Response("audio")))),
      ),
    );
    engine.downloadMany(["a", "b", "c", "d", "e", "f", "a"]);
    engine.downloadMany(["a", "b", "c", "d", "e", "f"]);
    await vi.waitFor(() => expect(cache.downloads.size).toBe(6));
    expect(engine.downloadJobs.filter((job) => job.status === "downloading")).toHaveLength(3);
    expect(engine.downloadJobs.filter((job) => job.status === "queued")).toHaveLength(3);
    expect(engine.downloadCount).toBe(6);
    const cancel = engine.cancelDownloads();
    for (const release of releases) release();
    await cancel;
    expect(engine.downloadCount).toBe(0);
    const restored = new Cache(cache.key);
    await restored.load();
    expect(restored.downloads.size).toBe(0);
  });

  it("restores pending work without retrying failures until explicit bulk Download", async () => {
    install();
    const first = setup({ online: true, concurrency: 1 });
    const fetcher = vi.fn(async () => new Response("bad", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(first.engine.download("bad")).rejects.toThrow();
    first.engine.setDownloadConnection(undefined);
    first.engine.downloadMany(["first", "second"]);
    await vi.waitFor(() => expect(first.cache.downloads.size).toBe(3));
    first.engine.destroy();
    const restored = new Cache(first.cache.key);
    await restored.load();
    const next = setup({ cache: restored, concurrency: 1 });
    fetcher.mockImplementation(async () => new Response("audio"));
    next.engine.setDownloadConnection(connection());
    await vi.waitFor(() => expect(completedDownloadCount(restored)).toBe(2));
    expect(next.engine.getStatus("bad")).toBe("failed");
    await next.engine.restoreDownloads();
    expect(next.engine.getStatus("bad")).toBe("failed");
    expect(fetcher.mock.calls).toHaveLength(3);
    next.engine.downloadMany(["bad", "bad"]);
    await vi.waitFor(() => expect(completedDownloadCount(restored)).toBe(3));
    expect(fetcher.mock.calls).toHaveLength(4);
  });

  it("joins close before confirmed cancellation, preserves committed files and failures, and never restarts canceled intent", async () => {
    const disk = install();
    const { engine, cache } = setup({ online: true, concurrency: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    await cache.enqueueDownload({ ...track, id: "failed" }, "mp3", "audio/mpeg");
    await cache.failDownload(downloadKey("failed", "mp3"));
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith(".audio")) {
        closing.resolve();
        await release.promise;
      }
    };
    void engine.download("closing");
    void engine.download("queued");
    await closing.promise;
    let acknowledged = false;
    const cancel = engine.cancelDownloads().then(() => {
      acknowledged = true;
    });
    await turn();
    expect(acknowledged).toBe(false);
    release.resolve();
    await cancel;
    expect(completedDownloadCount(cache)).toBe(1);
    expect([...cache.downloads.values()].map((item) => item.status)).toEqual([
      "failed",
      "completed",
    ]);
    const reopened = new Cache(cache.key);
    await reopened.load();
    expect(completedDownloadCount(reopened)).toBe(1);
    expect(reopened.downloads.has(downloadKey("queued", "mp3"))).toBe(false);
    expect(engine.downloadCount).toBe(0);
  });
});

it("counts raw and MP3 as independent files and treats untrusted AbortError rejection as sticky failure", async () => {
  install("probably");
  const { engine, cache } = setup({ online: true });
  await cache.replaceLibrary({
    artists: [],
    albums: [],
    tracks: [
      {
        id: "formats",
        title: "Formats",
        artistIds: [],
        albumId: "album",
        genres: [],
        mimeType: "audio/flac",
      },
    ],
    lastModified: 1,
    savedAt: 1,
  });
  const response = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const raw = engine.download("formats");
  const mp3 = engine.download("formats", { forceTranscode: true });
  await vi.waitFor(() => expect(cache.downloads.size).toBe(2));
  expect(engine.downloadCount).toBe(2);
  expect(new Set(engine.downloadJobs.map((job) => job.format))).toEqual(new Set(["raw", "mp3"]));
  response.reject(new DOMException("untrusted request rejection with secret", "AbortError"));
  await Promise.allSettled([raw, mp3]);
  expect([...cache.downloads.values()].map((intent) => intent.status)).toEqual([
    "failed",
    "failed",
  ]);
  expect(
    [...cache.downloads.values()]
      .map((intent) => ("diagnostic" in intent ? intent.diagnostic : undefined))
      .join(),
  ).not.toContain("secret");
  expect(engine.downloadCount).toBe(0);
});

it("bulk Download retries only selected failed formats without duplicating work or saved files", async () => {
  install();
  const { engine, cache } = setup();
  await seed(cache);
  for (const [id, format] of [
    ["selected", "raw"],
    ["selected", "mp3"],
    ["other", "mp3"],
  ] as const) {
    await cache.enqueueDownload({ ...track, id }, format, "audio/mpeg");
    await cache.failDownload(downloadKey(id, format));
  }
  const fetcher = vi.fn(async () => new Response("audio"));
  vi.stubGlobal("fetch", fetcher);
  engine.setDownloadConnection(connection());
  await engine.restoreDownloads();
  expect(fetcher).not.toHaveBeenCalled();
  engine.downloadMany(["selected", track.id, "selected"]);
  engine.downloadMany(["selected", track.id]);
  await vi.waitFor(() => expect(completedDownloadCount(cache)).toBe(3));
  expectCompletedDownload(cache, downloadKey("selected", "raw"));
  expectCompletedDownload(cache, downloadKey("selected", "mp3"));
  expect(cache.downloads.get(downloadKey("other", "mp3"))?.status).toBe("failed");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not acknowledge failed durable cancellation and preserves unconfirmed intent", async () => {
  const disk = install();
  const { engine, cache } = setup();
  void engine.download("waiting");
  await vi.waitFor(() => expect(cache.downloads.size).toBe(1));
  disk.state.beforeClose = async (name) => {
    if (name.endsWith("downloads.json")) throw new Error("full");
  };
  await expect(engine.cancelDownloads()).rejects.toThrow();
  expect(engine.downloadCount).toBe(1);
  disk.state.beforeClose = async () => {};
  const reopened = new Cache(cache.key);
  await reopened.load();
  expect(reopened.downloads.size).toBe(1);
  await engine.cancelDownloads();
  const canceled = new Cache(cache.key);
  await canceled.load();
  expect(canceled.downloads.size).toBe(0);
});

describe("reviewed download failure boundaries", () => {
  it("keeps attributable corrupt-catalog setup failures as safe sticky rows", async () => {
    const disk = install();
    const { cache } = setup();
    await cache.enqueueDownload(track, "mp3", "audio/mpeg");
    const catalogPath = [...disk.files.keys()].find((name) => name.endsWith("downloads.json"))!;
    disk.files.set(catalogPath, "corrupt secret catalog");
    const reopened = new Cache(cache.key);
    const next = setup({ cache: reopened, online: true });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(next.engine.download("known")).rejects.toThrow();
    expect(next.engine.getStatus("known")).toBe("failed");
    expect(reopened.downloads.get(downloadKey("known", "mp3"))).toMatchObject({
      track: { id: "known" },
      status: "failed",
    });
    next.engine.downloadMany(["known"]);
    await next.engine.restoreDownloads();
    expect(next.engine.getStatus("known")).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
    expect(disk.files.get(catalogPath)).toBe("corrupt secret catalog");
    expect(JSON.stringify([...reopened.downloads.values()])).not.toContain("secret");
  });

  it("streams cache misses and uses saved MP3 when legacy migration and recovery writes are denied", async () => {
    const disk = install("probably");
    const seeded = await seed();
    await seed(seeded, "raw");
    const catalogPath = [...disk.files.keys()].find((name) => name.endsWith("downloads.json"))!;
    const legacy = (["mp3", "raw"] as const).map((format) => {
      const record = expectCompletedDownload(seeded, downloadKey(track.id, format));
      return {
        track: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          contentType: track.contentType,
        },
        format,
        contentType: format === "mp3" ? "audio/mpeg" : "audio/flac",
        fileName: record.fileName,
        size: record.size,
        downloadedAt: record.downloadedAt,
      };
    });
    const raw = expectCompletedDownload(seeded, downloadKey(track.id, "raw"));
    disk.blobs.delete([...disk.blobs.keys()].find((name) => name.endsWith(raw.fileName))!);
    disk.files.set(catalogPath, "[]");
    disk.state.beforeClose = async (name) => {
      if (name.endsWith("downloads.json")) throw new DOMException("Denied", "NotAllowedError");
    };
    const { cache, engine } = setup({ cache: new Cache(seeded.key), online: true });
    expect((await engine.getSource({ id: "unsaved", contentType: "audio/flac" })).cached).toBe(
      false,
    );
    expect(disk.files.get(catalogPath)).toBe("[]");
    disk.files.set(catalogPath, JSON.stringify(legacy));
    const source = await engine.getSource(track);
    expect(source.cached).toBe(true);
    source.release();
    expect(disk.files.get(catalogPath)).toBe(JSON.stringify(legacy));
    await expect(
      cache.enqueueDownload({ ...track, id: "new" }, "mp3", "audio/mpeg"),
    ).rejects.toThrow();
    expect(cache.reportingError).toBeUndefined();
  });

  it("does not queue or execute rejected Retry persistence on reconnect or reopen", async () => {
    const disk = install();
    const { engine, cache } = setup({ online: true });
    const fetcher = vi.fn(async () => new Response("failure", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(engine.download("bad")).rejects.toThrow();
    const failed = cache.downloads.get(downloadKey("bad", "mp3"));
    disk.state.beforeClose = async (name) => {
      if (name.endsWith("downloads.json")) throw new Error("full");
    };
    await expect(engine.download("bad", { format: "mp3" })).rejects.toThrow();
    expect(cache.downloads.get(downloadKey("bad", "mp3"))).toBe(failed);
    disk.state.beforeClose = async () => {};
    engine.setDownloadConnection(undefined);
    engine.setDownloadConnection(connection());
    await engine.restoreDownloads();
    expect(engine.getStatus("bad")).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
    const reopened = new Cache(cache.key);
    await reopened.load();
    expect(reopened.downloads.get(downloadKey("bad", "mp3"))?.status).toBe("failed");
  });

  it.each([false, true])(
    "Retry fetches fresh bytes after catalog failure (reopen=%s)",
    async (reopen) => {
      const disk = install();
      const first = setup({ online: true });
      const fetcher = vi.fn(async () => new Response("complete audio"));
      vi.stubGlobal("fetch", fetcher);
      let bytesClosed = false;
      disk.state.afterClose = (name) => {
        if (name.endsWith(".audio")) bytesClosed = true;
      };
      disk.state.beforeClose = async (name) => {
        if (bytesClosed && name.endsWith("/downloads.json")) {
          bytesClosed = false;
          throw new Error("catalog unavailable");
        }
      };
      await expect(first.engine.download("recoverable")).rejects.toThrow();
      const key = downloadKey("recoverable", "mp3");
      const entry = first.cache.downloads.get(key);
      expect(entry).not.toHaveProperty("attempt");
      expect(disk.blobs.size).toBe(0);
      expect(first.engine.getStatus("recoverable")).toBe("failed");
      disk.state.beforeClose = async () => {};
      const current = reopen ? setup({ cache: new Cache(first.cache.key), online: true }) : first;
      await current.engine.restoreDownloads();
      expect(current.engine.getStatus("recoverable")).toBe("failed");
      expect(fetcher).toHaveBeenCalledOnce();
      await current.engine.download("recoverable", { format: "mp3" });
      expect(expectCompletedDownload(current.cache, key).size).toBe(14);
      expect(current.engine.getStatus("recoverable")).toBe("downloaded");
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("does not replace an interrupted close on reconnect before joining it", async () => {
    const disk = install();
    const { engine, cache } = setup({ online: true });
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith(".audio")) {
        closing.resolve();
        await release.promise;
      }
    };
    const fetcher = vi.fn(async () => new Response("complete"));
    vi.stubGlobal("fetch", fetcher);
    void engine.download("closing");
    await closing.promise;
    engine.setDownloadConnection(undefined);
    engine.setDownloadConnection(connection());
    let joined = false;
    const restoration = engine.restoreDownloads().then(() => {
      joined = true;
    });
    await turn();
    expect(joined).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    release.resolve();
    await restoration;
    expect(completedDownloadCount(cache)).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("restores the selected account after another account's cancellation freeze ends", async () => {
    const disk = install();
    const { engine, selection } = setup({ online: true });
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async (name) => {
      if (name.endsWith(".audio")) {
        closing.resolve();
        await release.promise;
      }
    };
    const fetcher = vi.fn(async () => new Response("audio"));
    vi.stubGlobal("fetch", fetcher);
    void engine.download("a");
    await closing.promise;
    const cancel = engine.cancelDownloads();
    const other = {
      ...auth,
      username: "other",
      credentials: { ...auth.credentials, username: "other" },
    };
    const next = new Cache(getAccountKey(other));
    await next.enqueueDownload({ ...track, id: "b" }, "mp3", "audio/mpeg");
    selection.cache = next;
    engine.activate();
    engine.setDownloadConnection(connection(other));
    release.resolve();
    await cancel;
    await vi.waitFor(() => expect(completedDownloadCount(next)).toBe(1));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it("generalized exact-format Download retries both failed formats at the FIFO tail with shared completion promises", async () => {
  install();
  const { cache, engine } = setup({ online: true, concurrency: 1 });
  for (const format of ["raw", "mp3"] as const) {
    await cache.enqueueDownload(track, format, format === "raw" ? "audio/flac" : "audio/mpeg");
    await cache.failDownload(downloadKey(track.id, format));
  }
  const read = deferred<Response>();
  const fetcher = vi.fn(async () => read.promise);
  vi.stubGlobal("fetch", fetcher);
  const older = engine.download("older");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  engine.downloadMany([track.id, track.id]);
  const raw = engine.download(track.id, { format: "raw" });
  const mp3 = engine.download(track.id, { format: "mp3" });
  engine.downloadMany([track.id]);
  expect(engine.download(track.id, { format: "raw" })).toBe(raw);
  await vi.waitFor(() =>
    expect([...cache.downloads.values()].map((entry) => entry.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]),
  );
  expect([...cache.downloads.keys()]).toEqual([
    downloadKey("older", "mp3"),
    downloadKey(track.id, "raw"),
    downloadKey(track.id, "mp3"),
  ]);
  let completed = false;
  void raw.then(() => {
    completed = true;
  });
  expect(completed).toBe(false);
  fetcher.mockImplementation(async () => new Response("retried audio"));
  read.resolve(new Response("older audio"));
  await older;
  expect(await (await raw).text()).toBe("retried audio");
  expect(await (await mp3).text()).toBe("retried audio");
  expect(fetcher.mock.calls).toHaveLength(3);
  for (const format of ["raw", "mp3"] as const) {
    expect(expectCompletedDownload(cache, downloadKey(track.id, format)).track).toEqual(track);
  }
});

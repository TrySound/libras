import { afterEach, describe, expect, it, vi } from "vitest";
import { Network } from "./network.svelte";
import { TrackEngine } from "./track.svelte";
import { Cache, downloadKey } from "./cache.svelte";
import { Memory } from "./memory.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
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
  const memory = new Memory();
  const cache = options.cache ?? new Cache(account);
  memory.cache = cache;
  memory.account = cache.account;
  const engine = new TrackEngine({
    memory,
    concurrency: options.concurrency,
    connection: options.online ? connection({ ...auth, ...cache.account }) : undefined,
  });
  engines.push(engine);
  engine.activate();
  return { memory, cache, engine };
}
async function seed(cache = new Cache(account), format: "raw" | "mp3" = "mp3") {
  await cache.saveDownload(
    track,
    format,
    format === "mp3" ? "audio/mpeg" : "audio/flac",
    new Response("cached"),
    new AbortController().signal,
  );
  return cache;
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TrackEngine using Cache", () => {
  it("uses a read-only Memory projection and owns offline playback URLs", async () => {
    const disk = install();
    await seed();
    const cache = new Cache(account);
    await cache.load();
    const { engine, memory } = setup({ cache });
    expect(cache.tracks.size).toBe(0);
    const record = cache.downloads.get(downloadKey(track.id, "mp3"))!;
    expect([...memory.downloads.values()]).toEqual([
      { ...record, ...account, key: downloadKey(track.id, "mp3") },
    ]);
    expect([...memory.downloads.values()][0].track).toBe(record.track);
    expect(Object.getOwnPropertyDescriptor(Memory.prototype, "downloads")?.set).toBeUndefined();
    disk.getDirectory.mockClear();
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(engine.downloadJobs).toEqual([]);
    expect(engine.downloadsLoading).toBe(false);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await engine.getSource(track)).toEqual({ cached: true, url: "blob:track-1" });
    engine.setConnection(connection());
    engine.setConnection(undefined);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(engine.getStatus(track.id)).toBe("downloaded");
    await engine.getSource(track);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-1");
    engine.releaseSource();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-2");
    await engine.getSource(track);
    engine.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-3");
  });

  it("proxies hydration progress and waits behind Cache's pending load", async () => {
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
    expect(engine.downloadsLoading).toBe(true);
    const source = engine.getSource(track);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    gate.resolve();
    await loading;
    expect((await source).cached).toBe(true);
    expect(engine.downloadsLoading).toBe(false);
    expect(engine.getStatus(track.id)).toBe("downloaded");
  });

  it("exposes load errors without maintaining a second catalog", async () => {
    const disk = install();
    await seed();
    const path = [...disk.files.keys()].find((path) => path.endsWith("/downloads.json"))!;
    disk.files.set(path, "broken");
    const { cache, engine } = setup();
    await expect(cache.load()).rejects.toThrow();
    expect(engine.error).toBe(cache.downloadsError);
    expect(engine.downloadsLoading).toBe(false);
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
    const { engine, memory, cache } = setup({ online: true });
    const pending = engine.cache(track);
    expect(engine.getStatus(track.id)).toBe("downloading");
    expect(memory.downloads.size).toBe(0);
    response.resolve(new Response("audio"));
    await pending;
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(engine.downloadJobs).toEqual([]);
    expect([...memory.downloads.values()][0].key).toBe(downloadKey(track.id, "mp3"));
    expect(cache.downloads.size).toBe(1);
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
    const active = engine.cache({ id: "active" });
    const queued = engine.cache({ id: "queued" });
    const last = engine.cache({ id: "last" });
    expect(engine.cache({ id: "active" })).toBe(active);
    expect(engine.cache({ id: "last" })).toBe(last);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
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
    expect(cache.downloads.size).toBe(3);
  });

  it.each(["HTTP", "empty", "catalog"])(
    "continues queued work after %s failure and permits retry",
    async (failure) => {
      const disk = install();
      const fetcher = vi
        .fn()
        .mockImplementationOnce(
          async () =>
            new Response(failure === "empty" ? "" : "bad", {
              status: failure === "HTTP" ? 500 : 200,
            }),
        )
        .mockImplementation(async () => new Response("good"));
      vi.stubGlobal("fetch", fetcher);
      if (failure === "catalog")
        disk.state.beforeWrite = (path) => {
          if (path.endsWith("/downloads.json")) {
            disk.state.beforeWrite = () => {};
            throw new Error("Storage full");
          }
        };
      const { engine, cache } = setup({ online: true, concurrency: 1 });
      const results = await Promise.allSettled([
        engine.cache({ id: "bad" }),
        engine.cache({ id: "good" }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(engine.error).toBeDefined();
      expect(engine.getStatus("bad")).toBe("idle");
      expect(engine.getStatus("good")).toBe("downloaded");
      expect(disk.blobs.size).toBe(1);
      await engine.cache({ id: "bad" });
      expect(engine.error).toBeUndefined();
      expect(cache.downloads.size).toBe(2);
    },
  );

  it("reuses a completed download without fetching or blocking streaming", async () => {
    install();
    const cache = await seed();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { engine } = setup({ cache, online: true });
    expect(await (await engine.cache(track)).text()).toBe("cached");
    expect(fetcher).not.toHaveBeenCalled();
    const source = await engine.getSource({ id: "remote" });
    expect(source.cached).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("repairs missing files lazily without adopting old or unlisted bytes", async () => {
    const disk = install();
    const cache = await seed();
    disk.blobs.clear();
    disk.files.set("tracks/old.audio", "legacy");
    const { engine } = setup({ cache });
    expect(engine.getStatus(track.id)).toBe("downloaded");
    await expect(engine.getSource(track)).rejects.toThrow("Connect");
    expect(engine.getStatus(track.id)).toBe("idle");
    expect(disk.files.get("tracks/old.audio")).toBe("legacy");
    engine.setConnection(connection());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("replacement")),
    );
    await engine.cache(track);
    expect(engine.getStatus(track.id)).toBe("downloaded");
  });

  it("uses MP3 fallback offline despite claimed raw support", async () => {
    install("probably");
    const { engine } = setup({ cache: await seed() });
    expect((await engine.getSource(track)).cached).toBe(true);
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe("audio/mpeg");
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
    expect(await engine.getSource(track, { position: 120 })).toEqual({
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
    const pending = engine.cache(track, { forceTranscode: true });
    expect(engine.getStatus(track.id)).toBe("downloading");
    response.resolve(new Response("mp3"));
    await pending;
    expect(engine.getStatus(track.id)).toBe("downloaded");
    expect(cache.downloads.size).toBe(2);
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
      const results = Promise.allSettled([
        engine.cache({ id: "active" }),
        engine.cache({ id: "queued" }),
      ]);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      if (action === "detach") engine.setConnection(undefined);
      else if (action === "destroy") engine.destroy();
      else engine.activate();
      expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(engine.downloadJobs).toEqual([]);
      expect(cache.downloads.size).toBe(0);
      expect(disk.blobs.size).toBe(0);
      expect(engine.error).toBeUndefined();
    },
  );

  it("cancels an in-progress stream and queued work when Network goes offline", async () => {
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
    const client = network.accept(network.prepare(auth));
    const { engine, cache } = setup({ concurrency: 1 });
    engine.setConnection(client.audio);
    const results = Promise.allSettled([
      engine.cache({ id: "active" }),
      engine.cache({ id: "queued" }),
    ]);
    await wrote.promise;
    network.setMode("offline");
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(disk.blobs.size).toBe(0);
    expect(cache.downloads.size).toBe(0);
    expect(engine.downloadJobs).toEqual([]);
    expect(engine.error).toBeUndefined();
  });

  it.each(["listener", "other"])(
    "isolates late downloads after selecting another cache (%s)",
    async (username) => {
      const disk = install();
      const first = deferred<Response>();
      const next = deferred<Response>();
      const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
      vi.stubGlobal("fetch", fetcher);
      const { engine, memory, cache } = setup({ online: true });
      const old = engine.cache(track);
      const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      memory.cache = new Cache({ ...account, username });
      memory.account = memory.cache.account;
      engine.activate();
      engine.setConnection(connection({ ...auth, username }));
      await rejected;
      const retry = engine.cache(track);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      const cancel = vi.fn();
      const late = new Response(new ReadableStream({ cancel }));
      first.resolve(late);
      await turn();
      expect(cancel).toHaveBeenCalledOnce();
      expect(engine.downloadJobs).toHaveLength(1);
      next.resolve(new Response("new"));
      await retry;
      expect(cache.downloads.size).toBe(0);
      expect(memory.cache.downloads.size).toBe(1);
      expect(disk.blobs.size).toBe(1);
      expect(engine.error).toBeUndefined();
    },
  );

  it.each(["switch", "release", "destroy", "supersede"])(
    "rejects a late cached source after %s",
    async (action) => {
      const disk = install();
      const { cache, engine, memory } = setup({ cache: await seed() });
      const gate = deferred();
      const reading = deferred();
      disk.state.beforeRead = async (path) => {
        if (path.endsWith(".audio")) {
          disk.state.beforeRead = async () => {};
          reading.resolve();
          await gate.promise;
        }
      };
      const pending = engine.getSource(track);
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await reading.promise;
      let current: ReturnType<TrackEngine["getSource"]> | undefined;
      if (action === "switch") {
        memory.cache = new Cache(account);
        engine.activate();
      }
      if (action === "release") engine.releaseSource();
      if (action === "destroy") engine.destroy();
      if (action === "supersede") current = engine.getSource(track);
      gate.resolve();
      await rejected;
      if (current) {
        expect((await current).cached).toBe(true);
        expect(URL.createObjectURL).toHaveBeenCalledOnce();
      } else expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(cache.downloads.size).toBe(1);
    },
  );

  it("does not stream with a foreign connection and drops old account resources on activation", async () => {
    install();
    const { engine, memory } = setup({ cache: await seed(), online: true });
    await engine.getSource(track);
    memory.cache = new Cache({ ...account, username: "other" });
    memory.account = memory.cache.account;
    engine.activate();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:track-1");
    expect(engine.getStatus(track.id)).toBe("idle");
    expect(memory.downloads.size).toBe(0);
    await expect(engine.getSource(track)).rejects.toThrow("Connect");
  });

  it.each(["beforeWrite", "afterClose"] as const)(
    "prevents late publication when detached at catalog %s",
    async (stage) => {
      const disk = install();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("audio")),
      );
      const { engine, cache } = setup({ online: true });
      const save = vi.spyOn(cache, "saveDownload");
      disk.state[stage] = (path) => {
        if (path.endsWith("/downloads.json")) engine.setConnection(undefined);
      };
      await expect(engine.cache(track)).rejects.toMatchObject({ name: "AbortError" });
      await expect(save.mock.results[0].value).rejects.toMatchObject({ name: "AbortError" });
      expect(cache.downloads.size).toBe(0);
      expect(engine.error).toBeUndefined();
      expect(disk.blobs.size).toBe(stage === "afterClose" ? 1 : 0);
      if (stage === "afterClose") {
        const restored = new Cache(account);
        await restored.load();
        expect((await setup({ cache: restored }).engine.getSource(track)).cached).toBe(true);
      }
    },
  );

  it("merges concurrent completions and reuses duplicate cross-tab downloads", async () => {
    const disk = install();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("audio")),
    );
    const first = setup({ online: true });
    const second = setup({ online: true });
    await Promise.all([
      first.engine.cache(track),
      second.engine.cache(track),
      second.engine.cache({ id: "other" }),
    ]);
    expect(disk.blobs.size).toBe(2);
    const restored = new Cache(account);
    await restored.load();
    expect(restored.downloads.size).toBe(2);
  });

  it.each([0, -1, 1.5])("rejects invalid download concurrency %s", (concurrency) => {
    install();
    expect(() => setup({ concurrency })).toThrow("positive integer");
  });
});

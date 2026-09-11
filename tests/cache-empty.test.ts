import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";

const library = { artists: [], albums: [], tracks: [], savedAt: 1, lastModified: null };
const queue = { tracks: ["track"], index: 0, position: 0 };
const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unscoped empty Cache", () => {
  it("provides stable empty collections and queue defaults without storage access", async () => {
    const disk = installDisk();
    const cache = new Cache();
    const collections = [
      cache.artists,
      cache.albums,
      cache.tracks,
      cache.artistAlbums,
      cache.albumTracks,
      cache.artistArtwork,
      cache.albumArtwork,
      cache.trackArtwork,
      cache.images,
      cache.downloads,
    ];
    expect(collections.every((collection) => collection.size === 0)).toBe(true);
    expect(cache.account).toBeUndefined();
    expect(cache.savedAt).toBeUndefined();
    expect(cache.lastModified).toBeUndefined();
    expect(cache.queue).toEqual({ tracks: [], index: -1, position: 0 });
    expect(cache.queueDirty).toBe(false);
    expect(cache.downloadsLoading).toBe(false);
    await cache.load();
    expect(await cache.flush()).toBe(0);
    expect(await cache.readImage("cover")).toBeNull();
    expect(await cache.readDownload("track", "mp3")).toBeNull();
    expect(cache.artists).toBe(collections[0]);
    expect(cache.downloads).toBe(collections.at(-1));
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(navigator.locks.request).not.toHaveBeenCalled();
  });

  it("rejects all mutations before publication, timers, or persistence", async () => {
    const disk = installDisk();
    const cache = new Cache();
    const timer = vi.spyOn(globalThis, "setTimeout");
    expect(() => cache.setQueue(queue)).toThrow("No account selected");
    await expect(cache.replaceQueue(queue, new AbortController().signal)).rejects.toThrow(
      "No account selected",
    );
    await expect(cache.replaceLibrary(library)).rejects.toThrow("No account selected");
    await expect(
      cache.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" }),
    ).rejects.toThrow("No account selected");
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(
      cache.saveDownload(track, "mp3", "audio/mpeg", response, new AbortController().signal),
    ).rejects.toThrow("No account selected");
    expect(cancel).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
    expect(cache.queueRevision).toBe(0);
    expect(cache.queueDirty).toBe(false);
    expect(cache.images.size).toBe(0);
    expect(cache.downloads.size).toBe(0);
    expect(cache.savedAt).toBeUndefined();
    expect(cache.queueError).toBeUndefined();
    expect(cache.imagesError).toBeUndefined();
    expect(cache.downloadsError).toBeUndefined();
    expect(disk.getDirectory).not.toHaveBeenCalled();
  });

  it("honors cancellation for otherwise empty reads and loads", async () => {
    const disk = installDisk();
    const cache = new Cache();
    const controller = new AbortController();
    controller.abort();
    await expect(cache.load(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(cache.readImage("cover", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(cache.readDownload("track", "mp3", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(disk.getDirectory).not.toHaveBeenCalled();
  });

  it("stays empty when a separate account cache is populated", async () => {
    installDisk();
    const empty = new Cache();
    const selected = new Cache({ host: "https://music.example", username: "listener" });
    await selected.replaceLibrary(library);
    selected.setQueue(queue);
    await selected.flush();
    expect(selected.account).toEqual({ host: "https://music.example", username: "listener" });
    expect(selected.savedAt).toBe(1);
    expect(empty.account).toBeUndefined();
    expect(empty.savedAt).toBeUndefined();
    expect(empty.queue.tracks).toEqual([]);
  });
});

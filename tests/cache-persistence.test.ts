import { getAccountKey } from "../src/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { flushSync } from "svelte";
import { observeCache } from "./cache-reactivity.test.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example", username: "listener" };
const library = (savedAt = 1) => ({
  savedAt,
  lastModified: savedAt,
  artists: [],
  albums: [],
  tracks: [],
});
const queue = { tracks: ["track"], index: 0, position: 1 };
const image = { blob: new Blob(["image"]), type: "image/png" };
const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
async function edit(cache: Cache, version = 1) {
  await cache.replaceLibrary(library(version));
  cache.setQueue({ ...queue, position: version });
  await cache.saveImage("cover", image);
  await cache.saveDownload(
    track,
    "mp3",
    "audio/mpeg",
    new Response("audio"),
    new AbortController().signal,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("general checkpoints", () => {
  it("aggregates failures reactively and clears only recovered domains", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    const libraryFailure = new Error("Library full");
    const imageFailure = new Error("Images full");
    const seen: (AggregateError | undefined)[] = [];
    const stop = observeCache(() => seen.push(cache.error));
    try {
      await edit(cache);
      disk.state.beforeClose = async (path) => {
        if (path.endsWith("/library.json")) throw libraryFailure;
        if (path.endsWith("/images.json")) throw imageFailure;
      };
      await expect(cache.flush()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [libraryFailure, imageFailure],
      });
      flushSync();
      expect(cache.error).toBeInstanceOf(AggregateError);
      expect(seen.at(-1)).toBe(cache.error);
      expect(cache.error?.errors).toEqual([libraryFailure, imageFailure]);
      disk.state.beforeClose = async (path) => {
        if (path.endsWith("/images.json")) throw imageFailure;
      };
      await expect(cache.flush()).rejects.toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ message: "Images full" })]),
      });
      flushSync();
      expect(seen.at(-1)?.errors).toEqual([imageFailure]);
      disk.state.beforeClose = async () => {};
      await cache.flush();
      flushSync();
      expect(cache.error).toBeUndefined();
      expect(seen.at(-1)).toBeUndefined();
    } finally {
      stop();
    }
  });

  it.each(["", "workspace/with:delimiters", "音楽"])(
    "persists opaque keys without interpreting account data: %j",
    async (key) => {
      installDisk();
      const cache = new Cache(key);
      expect(cache.key).toBe(key);
      cache.setQueue(queue);
      await cache.flush();
      const restored = new Cache(key);
      await restored.load();
      expect(restored.queue).toEqual(queue);
    },
  );

  it("reads and updates the existing account hash directory without migration", async () => {
    const disk = installDisk();
    const path =
      "accounts/de88847aa783bc5e9af2363746a0fdb7d40951bc7b13c1a14f71840ee35896ad/queue.json";
    disk.files.set(path, JSON.stringify(queue));
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    expect(cache.queue).toEqual(queue);
    cache.setQueue({ ...queue, position: 42 });
    await cache.flush();
    expect([...disk.files.keys()]).toEqual([path]);
    expect(JSON.parse(disk.files.get(path)!).position).toBe(42);
  });

  it("hashes once without opening storage and clean flushes do no I/O", async () => {
    const disk = installDisk();
    const digest = vi.spyOn(crypto.subtle, "digest");
    const cache = new Cache(getAccountKey(account));
    expect(digest).toHaveBeenCalledOnce();
    await cache.flush();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    await cache.load();
    await edit(cache);
    await cache.flush();
    expect(digest).toHaveBeenCalledOnce();
  });

  it("coalesces edits in every document without rereading or writing JSON per mutation", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    const read = vi.fn(async (_path: string) => {});
    disk.state.beforeRead = read;
    for (let version = 1; version <= 10; version++) await edit(cache, version);
    expect([...disk.files.keys()].filter((path) => path.endsWith(".json"))).toHaveLength(0);
    expect(read.mock.calls.some(([path]) => String(path).endsWith(".json"))).toBe(false);
    const writes = disk.state.writes;
    await vi.advanceTimersByTimeAsync(300);
    expect(disk.state.writes - writes).toBe(4);
    expect(cache.dirty).toBe(false);
    expect(disk.blobs.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    disk.getDirectory.mockClear();
    await cache.flush();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(restored.savedAt).toBe(10);
    expect(restored.queue.position).toBe(10);
    expect(restored.images.size).toBe(1);
    expect(restored.downloads.size).toBe(1);
  });

  it("captures the latest state when a queued flush starts and acknowledges only its revision", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async () => {
      closing.resolve();
      await release.promise;
    };
    cache.setQueue(queue);
    const saving = cache.flush();
    await closing.promise;
    for (let position = 2; position <= 100; position++) cache.setQueue({ ...queue, position });
    const next = cache.flush();
    cache.setQueue({ ...queue, position: 101 });
    release.resolve();
    await Promise.all([saving, next]);
    expect(cache.queueDirty).toBe(false);
    expect(disk.state.writes).toBe(2);
    expect(JSON.parse([...disk.files.values()][0]).position).toBe(101);
  });

  it("flushes independent domains even when one fails, and queue durability stays independent", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    await edit(cache);
    disk.state.beforeClose = async (path) => {
      if (path.endsWith("/images.json")) throw new Error("Full");
    };
    await expect(cache.flush()).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: "Full" })]),
    });
    expect(cache.error).toBeDefined();
    expect(cache.queueDirty).toBe(false);
    const writes = disk.state.writes;
    await expect(cache.flush()).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: "Full" })]),
    });
    expect(disk.state.writes).toBe(writes);
    expect(cache.savedAt).toBe(1);
    expect(cache.downloads.size).toBe(1);
    // A successful resource read must not hide the checkpoint error.
    await cache.readImage("cover");
    expect(cache.error).toBeDefined();
    disk.state.beforeClose = async () => {};
    await cache.flush();
    expect(cache.error).toBeUndefined();
  });

  it.each(["library", "queue", "images", "downloads"])(
    "retains %s placeholders on failed close and retries without rereading",
    async (name) => {
      const disk = installDisk();
      const cache = new Cache(getAccountKey(account));
      await edit(cache);
      disk.state.beforeClose = async (path) => {
        if (path.endsWith(`/${name}.json`)) throw new Error("Close failed");
      };
      await expect(cache.flush()).rejects.toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ message: "Close failed" })]),
      });
      const path = [...disk.files.keys()].find((path) => path.endsWith(`/${name}.json`))!;
      expect(disk.files.get(path)).toBe("");
      expect(cache.dirty).toBe(true);
      disk.state.beforeClose = async () => {};
      const reads = vi.fn(async () => {
        throw new Error("Unexpected read");
      });
      disk.state.beforeRead = reads;
      await cache.flush();
      expect(JSON.parse(disk.files.get(path)!)).toBeDefined();
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...account, host: "https://other.example" },
    { ...account, username: "other" },
  ])("isolates account documents and bytes: %j", async (other) => {
    const disk = installDisk();
    const first = new Cache(getAccountKey(account));
    const second = new Cache(getAccountKey(other));
    await edit(first, 1);
    await edit(second, 2);
    await Promise.all([first.flush(), second.flush()]);
    expect(disk.files.size).toBe(8);
    for (const text of disk.files.values()) {
      expect(JSON.parse(text)).not.toHaveProperty("account");
      expect(text).not.toContain(account.username);
    }
    for (const [identity, version] of [
      [account, 1],
      [other, 2],
    ] as const) {
      const restored = new Cache(getAccountKey(identity));
      await restored.load();
      expect(restored.savedAt).toBe(version);
      expect(restored.queue.position).toBe(version);
      expect(await (await restored.readImage("cover"))!.blob.text()).toBe("image");
      expect(await (await restored.readDownload(track.id, "mp3"))!.text()).toBe("audio");
    }
  });

  it("reports hash failures on I/O, not memory mutations, without retrying the hash", async () => {
    const disk = installDisk();
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("Hash unavailable"));
    const cache = new Cache(getAccountKey(account));
    await Promise.resolve();
    await expect(cache.load()).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: "Hash unavailable" })]),
    });
    await cache.replaceLibrary(library());
    await expect(cache.flush()).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: "Hash unavailable" })]),
    });
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(digest).toHaveBeenCalledOnce();
  });
});

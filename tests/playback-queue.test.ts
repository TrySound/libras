// @vitest-environment happy-dom
import { getAccountKey } from "../src/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Playback } from "../src/playback.svelte";
import { TrackEngine } from "../src/track.svelte";
import { CoverEngine } from "../src/cover.svelte";
import Player from "../src/player.svelte";
import { flushSync, mount, unmount } from "svelte";
import { AudioStub } from "./audio-test-helpers";
import { Cache, type CachedQueue } from "../src/cache.svelte";
import { TestSelection, playbackLibrary } from "./cache-selection-test-helpers.svelte";
import { Network, type RemoteQueue } from "../src/network.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const local = (): CachedQueue => ({ tracks: ["a", "b", "a"], index: 2, position: 12.5 });
const remote = (): RemoteQueue => ({ trackIds: ["remote"], currentTrackId: "remote", position: 9 });
let disk: ReturnType<typeof installDisk>;
const cleanups: (() => Promise<void>)[] = [];
const caches: Cache[] = [];
function createPlayback(selection: TestSelection) {
  if (selection.cache) {
    playbackLibrary(selection.cache).tracks = new Map(
      ["a", "b", "remote", "online", "local", "first", "second", "other", "new-local", "new"].map(
        (id) => [id, { id, title: id, artistId: "artist", albumId: "album", genres: [] }],
      ),
    );
  }
  const tracks = new TrackEngine({ selection });
  vi.spyOn(tracks, "getSource").mockImplementation(async (track) => ({
    cached: true,
    url: `blob:${track.id}`,
    release() {},
  }));
  const covers = new CoverEngine(selection);
  const playback = new Playback({ selection, tracks, covers });
  const audio = new AudioStub();
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const component = mount(Player, {
    target: document.createElement("div"),
    props: {
      hasNext: true,
      hasPrevious: true,
      onnext: () => {
        void playback.next();
      },
      onprevious: () => {
        void playback.previous();
      },
      onposition: (position) => playback.setPosition(position),
      onended: () => playback.ended(),
    },
  });
  flushSync();
  playback.attach(component);
  flushSync();
  cleanups.push(async () => {
    await playback.destroy();
    await unmount(component);
    tracks.destroy();
    covers.destroy();
  });
  return { playback, component };
}
function client(identity = account) {
  const controller = new AbortController();
  return {
    account: identity,
    signal: controller.signal,
    read: vi.fn(async (): Promise<RemoteQueue> => remote()),
    write: vi.fn(async (_value: RemoteQueue) => {}),
    abort: () => controller.abort(),
  };
}
async function path(identity = account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([identity.host, identity.username])),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `accounts/${hash}/queue.json`;
}
async function seed(queue = local(), identity = account) {
  disk.files.set(await path(identity), JSON.stringify(queue));
}
async function json(identity = account) {
  return JSON.parse(disk.files.get(await path(identity))!);
}
async function setup(identity = account) {
  const cache = new Cache(getAccountKey(identity));
  caches.push(cache);
  const selection = new TestSelection();
  selection.cache = cache;
  const { playback, component } = createPlayback(selection);
  await cache.load().catch(() => {});
  playback.activate();
  return { cache, selection, playback, component };
}
beforeEach(() => {
  disk = installDisk();
});
afterEach(async () => {
  disk.state.failClose = false;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const cache of caches.splice(0)) await cache.flush().catch(() => {});
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("playback queue synchronization", () => {
  it("configures and activates without performing local or network I/O", () => {
    const selection = new TestSelection();
    const { playback } = createPlayback(selection);
    const connection = client();
    playback.setConnection(connection);
    playback.setConnection(undefined);
    playback.activate();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(connection.read).not.toHaveBeenCalled();
    expect(connection.write).not.toHaveBeenCalled();
  });

  it("publishes a complete normalized queue before unloading the previous selection", async () => {
    const { playback, selection, component } = await setup();
    const seen: unknown[] = [];
    const unload = component.unload;
    vi.spyOn(component, "unload").mockImplementation(() => {
      seen.push(selection.cache!.queue);
      unload();
    });
    const tracks = ["a", "b", "a"];
    playback.setQueue({ tracks, index: 2, position: 12 });
    const publishedTracks = selection.cache!.queue.tracks;
    tracks.push("changed");
    playback.setPosition(15);
    expect(selection.cache!.queue.tracks).toBe(publishedTracks);
    playback.setQueue({ tracks: ["b"], index: 9, position: 20 });
    expect(seen).toEqual([
      { tracks: ["a", "b", "a"], index: 2, position: 12 },
      { tracks: ["b"], index: -1, position: 0 },
    ]);
    await playback.flushQueue();
    expect(seen).toHaveLength(2);
  });

  it.each([
    { placement: "next" as const, index: 1, expected: ["a", "b", "b", "missing", "a"] },
    { placement: "last" as const, index: 1, expected: ["a", "b", "a", "b", "missing"] },
    { placement: "next" as const, index: -1, expected: ["b", "missing", "a", "b", "a"] },
    { placement: "last" as const, index: -1, expected: ["a", "b", "a", "b", "missing"] },
  ])(
    "enqueues $placement preserving raw selection $index",
    async ({ placement, index, expected }) => {
      const { playback, cache } = await setup();
      const position = index < 0 ? 0 : 12;
      playback.setQueue({ tracks: ["a", "b", "a"], index, position });
      const incoming = ["b", "missing"];
      playback.enqueue(incoming, placement);
      incoming.length = 0;
      expect(cache.queue).toEqual({ tracks: expected, index, position });
      await playback.flushQueue();
      expect(await json()).toEqual(cache.queue);
    },
  );

  it("replaces and clears membership without selecting or playing a track", async () => {
    const { playback, cache } = await setup();
    playback.setQueue(local());
    const incoming = ["missing", "b", "b"];
    playback.setQueue({ tracks: incoming, position: 0 });
    incoming.length = 0;
    expect(cache.queue).toEqual({ tracks: ["missing", "b", "b"], index: -1, position: 0 });
    playback.setQueue({ tracks: [], position: 0 });
    expect(cache.queue).toEqual({ tracks: [], index: -1, position: 0 });
    await playback.flushQueue();
    expect(await json()).toEqual(cache.queue);
  });

  it("does not publish or grant upload permission for an empty enqueue", async () => {
    const { playback, cache } = await setup();
    playback.setQueue({ tracks: ["a"], position: 0 });
    const connection = client();
    playback.setConnection(connection);
    const revision = cache.queueRevision;
    playback.enqueue([], "next");
    playback.enqueue([], "last");
    expect(cache.queueRevision).toBe(revision);
    await playback.flushQueue();
    expect(connection.write).not.toHaveBeenCalled();
    playback.enqueue(["b"], "next");
    await playback.flushQueue();
    expect(connection.write).toHaveBeenCalledWith({
      trackIds: ["b", "a"],
      currentTrackId: undefined,
      position: 0,
    });
    playback.setQueue({ tracks: [], position: 0 });
    await playback.flushQueue();
    expect(connection.write).toHaveBeenLastCalledWith({
      trackIds: [],
      currentTrackId: undefined,
      position: 0,
    });
  });

  it.each([
    { ids: ["a", "b", "a"], selected: "a", index: 2, position: 9 },
    { ids: ["a", "a"], selected: "a", index: 0, position: 9 },
    { ids: ["a", "b", "a"], selected: "b", index: 1, position: 9 },
    { ids: ["a", "b", "a"], selected: "missing", index: -1, position: 0 },
    { ids: [], selected: undefined, index: -1, position: 0 },
  ])("maps remote selection to occurrence $index", async ({ ids, selected, index, position }) => {
    await seed();
    const { playback, cache } = await setup();
    const connection = client();
    connection.read.mockResolvedValue({ trackIds: ids, currentTrackId: selected, position: 9 });
    playback.setConnection(connection);
    await playback.refreshQueue();
    expect(cache.queue).toEqual({ tracks: ids, index, position });
    await cache.flush();
    expect(await json()).toEqual(cache.queue);
  });

  it.each([2, -1])("maps local occurrence %s to server selection", async (index) => {
    const { playback } = await setup();
    const connection = client();
    playback.setConnection(connection);
    playback.setQueue({ tracks: ["a", "b", "a"], index, position: index >= 0 ? 4 : 0 });
    await playback.flushQueue();
    expect(connection.write).toHaveBeenCalledWith({
      trackIds: ["a", "b", "a"],
      currentTrackId: index >= 0 ? "a" : undefined,
      position: index >= 0 ? 4 : 0,
    });
  });

  it("serializes uploads and acknowledges only the sent revision", async () => {
    const { playback, cache } = await setup();
    const connection = client();
    const response = deferred();
    connection.write.mockReturnValueOnce(response.promise);
    playback.setConnection(connection);
    playback.setQueue({ tracks: ["first"], index: 0, position: 0 });
    const first = playback.flushQueue();
    await vi.waitFor(() => expect(connection.write).toHaveBeenCalledOnce());
    playback.setQueue({ tracks: ["second"], index: 0, position: 0 });
    const second = playback.flushQueue();
    await Promise.resolve();
    expect(connection.write).toHaveBeenCalledOnce();
    response.resolve();
    await Promise.all([first, second]);
    expect(connection.write).toHaveBeenCalledTimes(2);
    expect(cache.queue.tracks).toEqual(["second"]);
  });

  it("never uploads a revision newer than the completed checkpoint", async () => {
    const { playback, cache } = await setup();
    const connection = client();
    playback.setConnection(connection);
    playback.setQueue(local());
    let changes = 0;
    disk.state.afterClose = () => {
      if (changes++ < 2) playback.setPosition(20 + changes);
    };
    await playback.flushQueue();
    expect(connection.write).not.toHaveBeenCalled();
    expect(cache.queueDirty).toBe(true);
    disk.state.afterClose = () => {};
    await playback.flushQueue();
    expect(connection.write).toHaveBeenCalledWith(expect.objectContaining({ position: 22 }));
    expect(cache.queueDirty).toBe(false);
  });

  it("does not write another checkpoint after an upload acknowledgement", async () => {
    const { playback } = await setup();
    const connection = client();
    playback.setConnection(connection);
    playback.setQueue(local());
    await playback.flushQueue();
    await playback.flushQueue();
    expect(disk.state.writes).toBe(1);
    expect(connection.write).toHaveBeenCalledOnce();
  });

  it("retains local state and retries a rejected upload explicitly", async () => {
    const { playback, cache } = await setup();
    const connection = client();
    const error = new Error("Upload failed");
    connection.write.mockRejectedValueOnce(error);
    playback.setConnection(connection);
    playback.setQueue(local());
    await playback.flushQueue();
    expect(playback.queueError).toBe(error);
    expect(cache.queue).toEqual(local());
    await playback.flushQueue();
    expect(playback.queueError).toBeUndefined();
    expect(connection.write).toHaveBeenCalledTimes(2);
  });

  it("discards queued uploads and late acknowledgements on connection replacement", async () => {
    const { playback, cache } = await setup();
    const old = client();
    const response = deferred();
    old.write.mockReturnValueOnce(response.promise);
    playback.setConnection(old);
    playback.setQueue(local());
    const first = playback.flushQueue();
    await vi.waitFor(() => expect(old.write).toHaveBeenCalledOnce());
    const queued = playback.flushQueue();
    const next = client();
    playback.setConnection(next);
    response.resolve();
    await Promise.all([first, queued]);
    await playback.playIndex(0);
    await playback.flushQueue();
    expect(old.write).toHaveBeenCalledOnce();
    expect(next.write).not.toHaveBeenCalled();
    expect(cache.queue.index).toBe(0);
    playback.setQueue(local());
    await playback.flushQueue();
    expect(next.write).toHaveBeenCalledOnce();
  });

  it.each([false, true])("ignores detached reads, including failures (%s)", async (failure) => {
    await seed();
    const { playback, cache } = await setup();
    const connection = client();
    const response = deferred<RemoteQueue>();
    connection.read.mockReturnValueOnce(response.promise);
    playback.setConnection(connection);
    const pending = playback.refreshQueue();
    await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
    playback.setConnection(undefined);
    connection.abort();
    if (failure) response.reject(new Error("Old read failed"));
    else response.resolve(remote());
    await pending;
    expect(playback.queueError).toBeUndefined();
    expect(cache.queue).toEqual(local());
    expect(disk.state.writes).toBe(0);
  });

  it.each(["local edit", "playback", "playback then stopped", "detach"])(
    "does not adopt a fetched queue after %s",
    async (action) => {
      await seed();
      const { playback, cache } = await setup();
      const connection = client();
      const response = deferred<RemoteQueue>();
      connection.read.mockReturnValueOnce(response.promise);
      playback.setConnection(connection);
      const pending = playback.refreshQueue();
      await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
      if (action === "local edit") await playback.playIndex(0);
      if (action === "playback" || action === "playback then stopped") await playback.play();
      if (action === "playback then stopped") playback.suspend();
      if (action === "detach") playback.setConnection(undefined);
      response.resolve(remote());
      await pending;
      expect(cache.queue.tracks).toEqual(local().tracks);
      expect(cache.queue.index).toBe(action === "local edit" ? 0 : 2);
    },
  );

  it("reconciles playback synchronously before checkpointing a fetched queue", async () => {
    await seed();
    const { playback, cache, component } = await setup();
    playback.setConnection(client());
    const unload = component.unload;
    const reconcile = vi.spyOn(component, "unload").mockImplementation(() => {
      expect(cache.queue.tracks).toEqual(["remote"]);
      expect(playback.track?.id).toBe("remote");
      unload();
    });
    const pending = playback.refreshQueue();
    expect(playback.refreshQueue()).toBe(pending);
    await pending;
    expect(reconcile).toHaveBeenCalledOnce();
    expect(cache.queueDirty).toBe(true);
    expect(disk.state.writes).toBe(0);
    expect(await json()).toEqual(local());
    await cache.flush();
    expect(await json()).toEqual(cache.queue);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("does not fetch over unsaved local edits after a checkpoint failure, and permits retry", async () => {
    await seed();
    const { playback, cache } = await setup();
    const connection = client();
    playback.setConnection(connection);
    playback.setQueue({ tracks: ["new-local"], index: 0, position: 0 });
    disk.state.failClose = true;
    await playback.refreshQueue();
    expect(connection.write).not.toHaveBeenCalled();
    expect(connection.read).not.toHaveBeenCalled();
    expect(cache.queue.tracks).toEqual(["new-local"]);
    expect(cache.queueDirty).toBe(true);
    expect(cache.error).toBeDefined();
    disk.state.failClose = false;
    connection.read.mockResolvedValue({
      trackIds: ["new-local"],
      currentTrackId: "new-local",
      position: 0,
    });
    await playback.refreshQueue();
    expect(connection.write).toHaveBeenCalledOnce();
    expect(connection.read).toHaveBeenCalledOnce();
    expect(cache.queue.tracks).toEqual(["new-local"]);
    expect(cache.error).toBeUndefined();
  });

  it("preserves the last disk snapshot when a fetched queue cannot be written", async () => {
    await seed();
    const original = await json();
    const { playback, cache } = await setup();
    playback.setConnection(client());
    disk.state.failClose = true;
    await playback.refreshQueue();
    await expect(cache.flush()).rejects.toThrow();
    expect(cache.error).toBeInstanceOf(Error);
    expect(cache.queue.tracks).toEqual(["remote"]);
    expect(await json()).toEqual(original);
  });

  it("keeps offline playback checkpoints local after reconnecting", async () => {
    const { playback, cache } = await setup();
    playback.setQueue(local());
    await playback.play();
    await playback.flushQueue();
    const connection = client();
    playback.setConnection(connection);
    playback.setPosition(20);
    await playback.flushQueue();
    await playback.refreshQueue();
    expect(connection.read).toHaveBeenCalledOnce();
    expect(connection.write).not.toHaveBeenCalled();
    expect(cache.queue.tracks).toEqual(local().tracks);
    await playback.playIndex(0);
    playback.setPosition(30);
    await playback.flushQueue();
    expect(connection.write).not.toHaveBeenCalled();
    playback.setQueue({ tracks: ["online"], index: 0, position: 0 });
    await playback.flushQueue();
    expect(connection.write).toHaveBeenCalledOnce();
  });

  it("checkpoints position changes every five seconds without continuous server saves", async () => {
    vi.useFakeTimers();
    await seed();
    const { playback, cache } = await setup();
    const connection = client();
    playback.setConnection(connection);
    for (let i = 1; i <= 21; i++) {
      playback.setPosition(i);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(disk.state.writes).toBe(1);
    expect((await json()).position).toBe(20);
    expect(cache.queue.position).toBe(21);
    expect(connection.write).not.toHaveBeenCalled();
    expect(connection.read).not.toHaveBeenCalled();
  });

  it("owns progress upload timing and idempotent pause/end transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { playback } = await setup();
    const connection = client();
    playback.setConnection(connection);
    playback.setQueue(local());
    await playback.play();
    await vi.advanceTimersByTimeAsync(300);
    expect(connection.write).toHaveBeenCalledOnce();
    connection.write.mockClear();
    for (let position = 1; position <= 9; position++) {
      await vi.advanceTimersByTimeAsync(1000);
      playback.setPosition(position);
    }
    expect(connection.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    playback.setPosition(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.write).toHaveBeenCalledOnce();
    playback.setPosition(11);
    playback.pause();
    playback.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.write).toHaveBeenCalledTimes(2);
    expect(connection.write).toHaveBeenLastCalledWith(expect.objectContaining({ position: 11 }));
    await playback.seek(35);
    await vi.advanceTimersByTimeAsync(300);
    expect(connection.write).toHaveBeenCalledTimes(3);
    await playback.play();
    playback.setPosition(36);
    playback.suspend();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.write).toHaveBeenLastCalledWith(expect.objectContaining({ position: 36 }));
  });

  it("does not promote an offline queue through lifecycle or progress updates", async () => {
    vi.useFakeTimers();
    const { playback, cache } = await setup();
    playback.setQueue(local());
    const connection = client();
    playback.setConnection(connection);
    await playback.play();
    playback.setPosition(50);
    await vi.advanceTimersByTimeAsync(10_000);
    playback.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.queue.position).toBe(50);
    expect(connection.write).not.toHaveBeenCalled();
  });

  it("exposes local write errors separately and preserves optimistic edits", async () => {
    await seed();
    const original = await json();
    const { playback, cache } = await setup();
    const connection = client();
    playback.setConnection(connection);
    disk.state.failClose = true;
    playback.setQueue({ tracks: ["new"], index: 0, position: 2 });
    await playback.flushQueue();
    expect(cache.error).toBeInstanceOf(Error);
    expect(playback.queueError).toBeUndefined();
    expect(cache.queue.tracks).toEqual(["new"]);
    expect(await json()).toEqual(original);
    expect(connection.write).not.toHaveBeenCalled();
  });

  it("keeps local state after failed reads and retries only on explicit refresh", async () => {
    await seed();
    const { playback, cache } = await setup();
    const connection = client();
    const error = new Error("Offline");
    connection.read.mockRejectedValueOnce(error);
    playback.setConnection(connection);
    await playback.refreshQueue();
    expect(playback.queueError).toBe(error);
    expect(cache.queue).toEqual(local());
    await playback.refreshQueue();
    expect(playback.queueError).toBeUndefined();
    expect(cache.queue.tracks).toEqual(["remote"]);
  });

  it("isolates accounts and ignores a late response after Session selects a different cache", async () => {
    const { playback, selection } = await setup();
    const connection = client();
    const response = deferred<RemoteQueue>();
    connection.read.mockReturnValueOnce(response.promise);
    playback.setConnection(connection);
    const pending = playback.refreshQueue();
    await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
    const other = { ...account, username: "other" };
    await seed({ tracks: ["other"], index: 0, position: 4 }, other);
    const next = new Cache(getAccountKey(other));
    caches.push(next);
    await next.load();
    playback.setConnection(undefined);
    selection.cache = next;
    playback.activate();
    response.resolve(remote());
    await pending;
    expect(selection.cache!.queue.tracks).toEqual(["other"]);
    expect((await json(other)).tracks).toEqual(["other"]);
  });

  it.each([false, true])(
    "ignores a late queue read after destruction (failure: %s)",
    async (failure) => {
      await seed();
      const { playback, cache } = await setup();
      const connection = client();
      const response = deferred<RemoteQueue>();
      connection.read.mockReturnValueOnce(response.promise);
      playback.setConnection(connection);
      const pending = playback.refreshQueue();
      await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
      await playback.destroy();
      if (failure) response.reject(new Error("Old read failed"));
      else response.resolve(remote());
      await pending;
      expect(cache.queue).toEqual(local());
      expect(playback.queueError).toBeUndefined();
      expect(connection.signal.aborted).toBe(false);
      expect(disk.state.writes).toBe(0);
    },
  );

  it("destruction checkpoints locally and cancels upload timers and later commands", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { playback, cache, component } = await setup();
    const connection = client();
    playback.setConnection(connection);
    playback.setQueue(local());
    await playback.play();
    playback.setPosition(14);
    await playback.destroy();
    const saved = cache.queue;
    expect(component.status).toBe("idle");
    playback.setQueue({ tracks: ["remote"], index: 0, position: 0 });
    playback.setPosition(30);
    await playback.playIndex(0);
    await playback.seek(50);
    playback.attach(component);
    await playback.play();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(component.status).toBe("idle");
    expect(cache.queue).toBe(saved);
    expect(await json()).toEqual(saved);
    expect(connection.write).not.toHaveBeenCalled();
  });

  it("preserves edits made during cache loading and activates without reloading", async () => {
    await seed();
    const cache = new Cache(getAccountKey(account));
    caches.push(cache);
    const selection = new TestSelection();
    selection.cache = cache;
    const { playback } = createPlayback(selection);
    const loaded = cache.load();
    playback.setQueue({ tracks: ["local"], index: 0, position: 3 });
    playback.setConnection(undefined);
    await loaded;
    playback.activate();
    expect(cache.queue.tracks).toEqual(["local"]);
    await playback.flushQueue();
    expect((await json()).tracks).toEqual(["local"]);
  });

  it("uses configured network normalization without retaining server replicas or upload markers", async () => {
    await seed();
    const network = new Network();
    const connection = network.accept(
      network.prepare({ ...account, token: "token", salt: "salt" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              "subsonic-response": {
                status: "ok",
                playQueue: {
                  current: "a",
                  position: 12500,
                  entry: [{ id: "a" }, { id: "b" }, { id: "a" }],
                },
              },
            }),
          ),
      ),
    );
    const { playback, cache } = await setup();
    playback.setConnection(connection.queue);
    await playback.refreshQueue();
    expect(cache.queue).toEqual(local());
    expect(await json()).not.toHaveProperty("pendingSync");
    expect(await json()).not.toHaveProperty("server");
    network.setMode("offline");
  });
});

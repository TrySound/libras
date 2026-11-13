// @vitest-environment happy-dom
import { getAccountKey } from "../src/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Playback } from "../src/playback.svelte";
import { TrackEngine } from "../src/track.svelte";
import { Covers } from "../src/covers.svelte";
import { AudioTransport } from "../src/audio-transport.svelte";
import { AudioStub } from "./audio-test-helpers";
import { Cache } from "../src/cache.svelte";
import { TestSelection, playbackLibrary } from "./cache-selection-test-helpers.svelte";
import type { RemoteQueue } from "../src/network.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const local = () => ({ tracks: ["a", "missing", "a"], index: 2, position: 12.5 });
const remote = (): RemoteQueue => ({
  trackIds: ["b", "missing", "b"],
  currentTrackId: "b",
  position: 9,
});
let disk: ReturnType<typeof installDisk>;
const cleanups: (() => Promise<void>)[] = [];
function client() {
  const controller = new AbortController();
  return {
    account,
    signal: controller.signal,
    read: vi.fn(async (): Promise<RemoteQueue> => remote()),
    write: vi.fn(async (_value: RemoteQueue) => {}),
    abort: () => controller.abort(),
  };
}
async function setup() {
  const cache = new Cache(getAccountKey(account));
  await cache.load();
  const selection = new TestSelection();
  selection.cache = cache;
  playbackLibrary(cache).tracks = new Map(
    ["a", "b"].map((id) => [id, { id, title: id, artistIds: [], albumId: "album", genres: [] }]),
  );
  const tracks = new TrackEngine({ selection });
  vi.spyOn(tracks, "getSource").mockImplementation(async (track) => ({
    cached: true,
    url: `blob:${track.id}`,
    release() {},
  }));
  const covers = new Covers(selection);
  const playback = new Playback({ selection, tracks, covers });
  const audio = new AudioStub();
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const transport = new AudioTransport({
    onposition: (p) => playback.setPosition(p),
    onstatechange: (s) => playback.updatePlayerState(s),
    onended: () => playback.ended(),
  });
  playback.attach(transport);
  playback.activate();
  playback.setQueue(local());
  const connection = client();
  playback.setConnection(connection);
  cleanups.push(async () => {
    await playback.destroy();
    transport.dispose();
    tracks.destroy();
    covers.destroy();
    await cache.flush().catch(() => {});
  });
  return { cache, selection, playback, audio, connection, transport };
}
beforeEach(() => {
  disk = installDisk();
});
afterEach(async () => {
  disk.state.failClose = false;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local authoritative queue", () => {
  it("never exchanges automatically on activation, reconnect, edits, progress, pause, visibility or flush", async () => {
    const { playback, connection, cache } = await setup();
    playback.activate();
    playback.setConnection(undefined);
    playback.setConnection(connection);
    playback.setQueue(local());
    await playback.play();
    playback.setPosition(24);
    playback.pause();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await playback.flushQueue();
    expect(connection.read).not.toHaveBeenCalled();
    expect(connection.write).not.toHaveBeenCalled();
    expect(cache.queue.tracks).toEqual(local().tracks);
    expect(cache.queueDirty).toBe(false);
  });
  it("debounces local commands and periodically flushes active progress without any exchange", async () => {
    const { playback, connection, cache } = await setup();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const flush = vi.spyOn(playback, "flushQueue");
    playback.setQueue(local());
    await vi.advanceTimersByTimeAsync(299);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledOnce();
    await playback.play();
    await vi.advanceTimersByTimeAsync(300);
    flush.mockClear();
    playback.setPosition(15);
    expect(flush).not.toHaveBeenCalled();
    vi.setSystemTime(10_001);
    playback.setPosition(20);
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledOnce();
    expect(cache.queueDirty).toBe(false);
    expect(connection.read).not.toHaveBeenCalled();
    expect(connection.write).not.toHaveBeenCalled();
  });
  it("destruction persists locally, cancels timers and ignores later commands without server requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { playback, cache, transport, audio, connection } = await setup();
    await playback.play();
    playback.setPosition(14);
    await playback.destroy();
    const saved = cache.queue;
    expect(saved).toEqual({ ...local(), position: 14 });
    expect(cache.queueDirty).toBe(false);
    expect(transport.status).toBe("idle");
    expect(audio.src).toBe("");

    // Read through a fresh cache to verify the final checkpoint reached disk.
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(restored.queue).toEqual(saved);
    const writes = disk.state.writes;
    const flush = vi.spyOn(playback, "flushQueue");

    playback.setQueue({ tracks: ["b"], index: 0, position: 0 });
    playback.setPosition(30);
    await playback.playIndex(0);
    await playback.seek(50);
    playback.attach(transport);
    await playback.play();
    await playback.loadServerQueue();
    await playback.saveServerQueue();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(flush).not.toHaveBeenCalled();
    expect(transport.status).toBe("idle");
    expect(audio.src).toBe("");
    expect(cache.queue).toBe(saved);
    expect(disk.state.writes).toBe(writes);
    expect(connection.read).not.toHaveBeenCalled();
    expect(connection.write).not.toHaveBeenCalled();
  });
  it("loads duplicates and unknown IDs, stops active playback, persists and never autoplays", async () => {
    const { playback, cache, audio } = await setup();
    await playback.play();
    audio.play.mockClear();
    await playback.loadServerQueue();
    expect(cache.queue).toEqual({ tracks: remote().trackIds, index: 0, position: 9 });
    expect(audio.src).toBe("");
    expect(audio.play).not.toHaveBeenCalled();
    await playback.flushQueue();
    expect(cache.queueDirty).toBe(false);
    expect(playback.exchangeMessage).toContain("Playback is stopped");
  });
  it("preserves the local duplicate occurrence when server selection is ambiguous but membership matches", async () => {
    const { playback, cache, connection } = await setup();
    connection.read.mockResolvedValue({
      trackIds: local().tracks,
      currentTrackId: "a",
      position: 7,
    });
    await playback.loadServerQueue();
    expect(cache.queue.index).toBe(2);
  });
  it.each(["edit", "play", "play then stop", "disconnect", "abort", "account", "dispose"])(
    "rejects stale loads after %s",
    async (reason) => {
      const { playback, cache, selection, connection } = await setup();
      const result = deferred<RemoteQueue>();
      connection.read.mockReturnValue(result.promise);
      const pending = playback.loadServerQueue();
      if (reason === "edit") playback.setQueue({ tracks: ["b"], position: 0 });
      if (reason.startsWith("play")) await playback.play();
      if (reason === "play then stop") playback.stop();
      if (reason === "disconnect") playback.setConnection(undefined);
      if (reason === "abort") connection.abort();
      if (reason === "account") selection.cache = new Cache(undefined);
      if (reason === "dispose") await playback.destroy();
      const before = cache.queue;
      result.resolve(remote());
      await pending;
      expect(cache.queue).toEqual(before);
      expect(playback.exchangeBusy).toBeUndefined();
    },
  );
  it("saves a stable snapshot while local progress/edits remain local and guards overlap", async () => {
    const { playback, cache, connection } = await setup();
    const result = deferred<void>();
    connection.write.mockReturnValue(result.promise);
    const pending = playback.saveServerQueue();
    await playback.loadServerQueue();
    await playback.saveServerQueue();
    await playback.play();
    playback.setPosition(30);
    playback.clearQueue();
    expect(connection.write).toHaveBeenCalledExactlyOnceWith({
      trackIds: local().tracks,
      currentTrackId: "a",
      position: 12.5,
    });
    expect(connection.read).not.toHaveBeenCalled();
    result.resolve();
    await pending;
    expect(cache.queue.tracks).toEqual([]);
    expect(playback.exchangeMessage).toBe("Queue saved to server.");
  });
  it("explicitly saves an empty queue", async () => {
    const { playback, connection } = await setup();
    playback.clearQueue();
    await playback.saveServerQueue();
    expect(connection.write).toHaveBeenCalledWith({
      trackIds: [],
      currentTrackId: undefined,
      position: 0,
    });
  });
  it.each(["load", "save"] as const)(
    "preserves local state and sanitizes failed %s, retry is explicit",
    async (action) => {
      const { playback, cache, connection } = await setup();
      const error = new Error("https://secret.example/?password=secret");
      if (action === "load") connection.read.mockRejectedValueOnce(error);
      else connection.write.mockRejectedValueOnce(error);
      const run = () =>
        action === "load" ? playback.loadServerQueue() : playback.saveServerQueue();
      await run();
      expect(cache.queue).toEqual(local());
      expect(playback.exchangeMessage).toContain("Could not");
      expect(playback.exchangeMessage).not.toContain("secret");
      await playback.flushQueue();
      expect(connection[action === "load" ? "read" : "write"]).toHaveBeenCalledOnce();
      await run();
      expect(playback.queueError).toBeUndefined();
    },
  );
  it("keeps optimistic local edits when persistence fails without server access", async () => {
    const { playback, cache, connection } = await setup();
    disk.state.failClose = true;
    playback.setQueue({ tracks: ["missing", "a", "a"], index: 2, position: 8 });
    await playback.flushQueue();
    expect(cache.queueDirty).toBe(true);
    expect(cache.queue.tracks).toEqual(["missing", "a", "a"]);
    expect(connection.read).not.toHaveBeenCalled();
    expect(connection.write).not.toHaveBeenCalled();
    disk.state.failClose = false;
    await playback.flushQueue();
    expect(cache.queueDirty).toBe(false);
  });
});

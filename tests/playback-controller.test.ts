// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackController } from "../src/playback-controller.svelte";
import { flushSync, mount as mountComponent, unmount } from "svelte";
import Player from "../src/player.svelte";
import { observePlayback } from "./playback-reactivity.test.svelte";
import { QueueEngine } from "../src/queue.svelte";
import { Cache } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import type { Track } from "../src/schema";
import { TrackEngine, type TrackSource } from "../src/track.svelte";
import { Network } from "../src/network.svelte";
import { TestSelection, playbackLibrary } from "./cache-selection-test-helpers.svelte";

class AudioStub extends EventTarget {
  preload = "";
  src = "";
  get currentSrc() {
    return this.src;
  }
  paused = true;
  currentTime = 0;
  duration = 120;
  playbackRate = 1;
  readyState = 1;
  error: { code: number; message: string } | null = null;
  buffered = { length: 0, start: () => 0, end: () => 120 };
  seekable = { length: 0, start: (_i: number) => 0, end: (_i: number) => 120 };
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  load = vi.fn(() => {
    this.currentTime = 0;
  });
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}
const song = (id: string): Track => ({
  id,
  title: id,
  artistId: "artist",
  albumId: "album",
  artworkId: id,
  genres: [],
});
const cleanups: (() => void | Promise<void>)[] = [];
function setup(mount = true, isAvailable: (id: string) => boolean = () => true) {
  vi.useFakeTimers();
  const doc = document as Document & { visibilityState: string };
  Object.defineProperty(doc, "visibilityState", {
    value: "visible",
    writable: true,
    configurable: true,
  });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(data: MediaMetadataInit) {
        Object.assign(this, data);
      }
    },
  );
  installDisk();
  const selection = new TestSelection();
  selection.cache = new Cache({ host: "https://music.example.com", username: "listener" });
  const library = playbackLibrary(selection.cache);
  library.tracks = new Map(["a", "b", "c"].map((id) => [id, song(id)]));
  library.artists = new Map([["artist", { id: "artist", name: "Artist", genres: [] }]]);
  library.albums = new Map([
    ["album", { id: "album", title: "Album", artistId: "artist", genres: [] }],
  ]);
  const updateTrack = (id: string, patch: Partial<Track>) => {
    library.tracks = new Map(library.tracks).set(id, {
      ...song(id),
      ...library.tracks.get(id),
      ...patch,
    });
  };
  const queue = new QueueEngine(selection);
  const audio = new AudioStub();
  const tracks = {
    getSource: vi.fn(
      async (
        track: { id: string },
        _options?: { forceTranscode?: boolean; position?: number },
      ): Promise<TrackSource> => ({ cached: true, release: vi.fn(), url: `blob:${track.id}` }),
    ),
    cache: vi.fn(async () => new File([], "track")),
  };
  let artwork = "data:image/jpeg;base64,aW1hZ2U=";
  const covers = {
    ensureTrackCover: vi.fn((id: string) => ({
      source: artwork,
      artworkId: id,
      cached: true,
      release: vi.fn(),
      cache: () => {},
    })),
  };
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const session = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn(
      (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        handlers.set(action, handler);
      },
    ),
    setPositionState: vi.fn(),
  };
  vi.stubGlobal("navigator", { ...navigator, mediaSession: session });
  const createAudio = vi.fn(function () {
    return audio as unknown as HTMLAudioElement;
  });
  vi.stubGlobal("Audio", createAudio);
  const player = new PlaybackController({
    isAvailable,
    queue,
    selection,
    tracks,
    covers,
  });
  queue.update({ tracks: ["a", "b"], index: 0, position: 0 });
  let mountedPlayer: ReturnType<typeof Player>;
  const getPlayer = () => mountedPlayer;
  const queuePosition = () => selection.cache?.queue.position ?? 0;
  let detachMounted: (() => void) | undefined;
  const mountPlayer = () => {
    detachMounted?.();
    const component = mountComponent(Player, {
      target: document.createElement("div"),
      props: {
        get hasNext() {
          const queue = selection.cache?.queue;
          return !!queue && queue.index >= 0 && queue.index < queue.tracks.length - 1;
        },
        get hasPrevious() {
          const queue = selection.cache?.queue;
          return !!queue && (queue.index > 0 || (queue.index >= 0 && queue.position > 0));
        },
        onnext: () => {
          void player.next();
        },
        onprevious: () => {
          void player.previous();
        },
        onposition: (position) => player.setPosition(position),
        onended: () => player.ended(),
      },
    });
    mountedPlayer = component;
    flushSync();
    const detachEngine = player.attach(component);
    flushSync();
    let disposed = false;
    const detach = () => {
      if (disposed) return;
      disposed = true;
      detachEngine();
      void unmount(component);
    };
    detachMounted = detach;
    return detach;
  };
  const detach = mount ? mountPlayer() : () => {};
  cleanups.push(async () => {
    detachMounted?.();
    player.destroy();
    await queue.destroy();
  });
  return {
    selection,
    library,
    updateTrack,
    removeTrack(id: string) {
      const tracks = new Map(library.tracks);
      tracks.delete(id);
      library.tracks = tracks;
    },
    restoreTrack(id: string) {
      library.tracks = new Map(library.tracks).set(id, song(id));
    },
    renameTrack(id: string, title: string) {
      updateTrack(id, { title });
    },
    player,
    getPlayer,
    queuePosition,
    mountPlayer,
    createAudio,
    queue,
    audio,
    tracks,
    covers,
    session,
    handlers,
    doc,
    detach,
    artwork(value: string) {
      artwork = value;
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("playback engine", () => {
  it("reads a new cache atomically and ignores a suspended account's late source", async () => {
    const { selection, queue, player, getPlayer, queuePosition, tracks, audio } = setup();
    const old = selection.cache!;
    const late = Promise.withResolvers<TrackSource>();
    tracks.getSource.mockReturnValueOnce(late.promise);
    const pending = player.play();
    await Promise.resolve();
    player.suspend();
    const next = new Cache({ ...old.account!, username: "other" });
    const library = playbackLibrary(next);
    library.tracks = new Map([["a", { ...song("a"), title: "Other account" }]]);
    next.setQueue({ tracks: ["a"], index: 0, position: 37 });
    selection.cache = next;
    queue.activate();
    expect(player.track?.title).toBe("Other account");
    expect(queuePosition()).toBe(37);
    await player.play();
    late.resolve({ cached: true, release: vi.fn(), url: "blob:old-account" });
    await pending;
    expect(audio.src).toBe("blob:a");
    expect(getPlayer().playing).toBe(true);
    expect(old.queue.tracks).toEqual(["a", "b"]);
    player.suspend();
    selection.cache = undefined;
    queue.activate();
    expect(player.track).toBeUndefined();
    expect(queuePosition()).toBe(0);
  });
  it("keeps cached playback running when network sources are suspended", async () => {
    const { player, getPlayer, audio, tracks } = setup();
    await player.play();
    const source = audio.src;
    player.suspendNetwork();
    expect(getPlayer().playing).toBe(true);
    expect(audio.src).toBe(source);
    tracks.getSource.mockResolvedValue({
      cached: false,
      release: vi.fn(),
      url: "https://music.example/stream",
    });
    await player.next();
    player.suspendNetwork();
    expect(getPlayer().playing).toBe(false);
    expect(audio.src).toBe("");
  });

  it("suspends playback for account changes without losing queue selection or position", async () => {
    const { player, getPlayer, audio, selection, tracks } = setup();
    await player.play();
    audio.currentTime = 23;
    audio.dispatchEvent(new Event("timeupdate"));
    const queued = selection.cache!.queue.tracks;
    player.suspend();
    expect(audio.src).toBe("");
    expect(getPlayer().playing).toBe(false);
    expect(selection.cache!.queue.tracks).toBe(queued);
    expect(selection.cache!.queue.index).toBe(0);
    expect(selection.cache!.queue.position).toBe(23);
    await player.play();
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: false,
      position: 23,
      signal: expect.any(AbortSignal),
    });
  });

  it("stops playback and clears selection and position without deleting the queue", async () => {
    const { player, getPlayer, selection, audio, session } = setup();
    await player.play();
    audio.currentTime = 8;
    audio.dispatchEvent(new Event("timeupdate"));
    player.stop();
    expect(selection.cache!.queue.tracks).toEqual(["a", "b"]);
    expect(selection.cache!.queue.index).toBe(-1);
    expect(selection.cache!.queue.position).toBe(0);
    expect(getPlayer().playing).toBe(false);
    expect(audio.src).toBe("");
    expect(session.metadata).toBeNull();
  });

  it.each([false, true])(
    "keeps a playback session when refreshing the server queue (paused: %s)",
    async (paused) => {
      const { player, queue, audio, selection } = setup();
      const account = { host: "https://music.example.com", username: "listener" };
      const local = { tracks: ["a", "b"], index: 0, position: 0 };
      await selection.cache!.flush();
      const save = vi.spyOn(selection.cache!, "replaceQueue");
      const connection = {
        account,
        signal: new AbortController().signal,
        read: async () => ({ trackIds: ["c"], currentTrackId: "c", position: 25 }),
        write: async () => {},
      };
      queue.setConnection(connection);
      await player.play();
      if (paused) player.pause();
      const source = audio.src;
      const loads = audio.load.mock.calls.length;
      await queue.refresh();
      expect(selection.cache!.queue.tracks).toEqual(local.tracks);
      expect(player.track?.id).toBe("a");
      expect(audio.src).toBe(source);
      expect(audio.load).toHaveBeenCalledTimes(loads);
      expect(save).not.toHaveBeenCalled();
      player.suspend();
      await queue.refresh();
      expect(player.track?.id).toBe("c");
      expect(selection.cache!.queue.position).toBe(25);
    },
  );

  it("does not upload deletions when a server queue arrives before fresh metadata", async () => {
    const { player, getPlayer, queue, audio, restoreTrack, selection } = setup();
    const { Network } = await import("../src/network.svelte");
    const network = new Network();
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              playQueue: {
                current: "fresh",
                position: 12000,
                entry: [{ id: "a" }, { id: "fresh" }],
              },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = network.prepare({
      host: "https://music.example.com",
      username: "listener",
      token: "token",
      salt: "salt",
    });
    const active = network.accept(client);
    await selection.cache!.flush();
    queue.activate();
    queue.setConnection(active.queue);
    await queue.refresh();
    await queue.flush();
    expect(selection.cache!.queue.tracks).toEqual(["a", "fresh"]);
    expect(selection.cache!.queue.index).toBe(1);
    expect(selection.cache!.queue.position).toBe(12);
    expect(player.track).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    restoreTrack("fresh");
    expect(player.track?.id).toBe("fresh");
    expect(fetcher).toHaveBeenCalledOnce();
    await player.play();
    audio.currentTime = 13;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(getPlayer().playing).toBe(true);
    expect(selection.cache!.queue.tracks).toEqual(["a", "fresh"]);
  });

  it("navigates adjacent raw indexes without skipping missing metadata or duplicates", async () => {
    const { player, queue, tracks, restoreTrack, selection, getPlayer } = setup();
    queue.update({ tracks: ["missing", "a", "missing", "a"], index: 1, position: 0 });
    await player.play();
    await player.next();
    expect(selection.cache!.queue.index).toBe(2);
    expect(player.track).toBeUndefined();
    expect(getPlayer().status).toBe("idle");
    expect(tracks.getSource).toHaveBeenCalledOnce();
    await player.next();
    expect(selection.cache!.queue.index).toBe(3);
    await player.previous();
    expect(selection.cache!.queue.index).toBe(2);
    expect(getPlayer().status).toBe("idle");
    restoreTrack("missing");
    await player.play();
    expect(selection.cache!.queue.index).toBe(2);
    expect(player.track?.id).toBe("missing");
    expect(selection.cache!.queue.tracks).toEqual(["missing", "a", "missing", "a"]);
  });

  it("applies availability restrictions without changing queue membership", async () => {
    const available = new Set(["b"]);
    const { player, tracks, selection } = setup(true, (id) => available.has(id));
    await player.playIndex(0);
    await player.seek(50);
    expect(tracks.getSource).not.toHaveBeenCalled();
    expect(selection.cache!.queue.index).toBe(0);
    expect(selection.cache!.queue.position).toBe(0);
    await player.play();
    expect(selection.cache!.queue.index).toBe(0);
    expect(tracks.getSource).not.toHaveBeenCalled();
    await player.next();
    expect(selection.cache!.queue.index).toBe(1);
    expect(selection.cache!.queue.tracks).toEqual(["a", "b"]);
    await player.previous();
    expect(selection.cache!.queue.index).toBe(0);
    expect(tracks.getSource).toHaveBeenCalledOnce();
    available.add("a");
    await player.previous();
    expect(selection.cache!.queue.index).toBe(0);
    expect(selection.cache!.queue.tracks).toEqual(["a", "b"]);
  });

  it.each(["next", "last"] as const)(
    "enqueues %s without interrupting playback",
    async (placement) => {
      const { player, queue, selection, audio, getPlayer } = setup();
      await player.play();
      queue.setPosition(12);
      await player.enqueue(["c", "a"], placement);
      expect(selection.cache!.queue).toEqual({
        tracks: placement === "next" ? ["a", "c", "a", "b"] : ["a", "b", "c", "a"],
        index: 0,
        position: 12,
      });
      expect(getPlayer().playing).toBe(true);
      expect(audio.play).toHaveBeenCalledOnce();
      player.pause();
      await player.enqueue(["b"], placement);
      expect(getPlayer().playing).toBe(false);
      expect(audio.play).toHaveBeenCalledOnce();
    },
  );

  it.each(["next", "last"] as const)(
    "starts playback when enqueuing %s into an empty queue",
    async (placement) => {
      const { player, queue, selection, audio } = setup();
      queue.replace([]);
      await player.enqueue([], placement);
      expect(audio.play).not.toHaveBeenCalled();
      await player.enqueue(["b", "a"], placement);
      expect(selection.cache!.queue).toEqual({ tracks: ["b", "a"], index: 0, position: 0 });
      expect(audio.src).toBe("blob:b");
      expect(audio.play).toHaveBeenCalledOnce();
    },
  );

  it("does not autoplay when inserting into an unselected nonempty queue", async () => {
    const { player, queue, selection, audio } = setup();
    queue.replace(["missing"]);
    await player.enqueue(["a"], "next");
    expect(selection.cache!.queue).toEqual({ tracks: ["a", "missing"], index: -1, position: 0 });
    expect(audio.play).not.toHaveBeenCalled();
  });

  it.each([-10, 0, 2, 10])(
    "replaces and plays a clamped start index %s, restarting duplicate tracks",
    async (startIndex) => {
      const { player, queue, selection, audio } = setup();
      await player.play();
      queue.setPosition(12);
      await player.replaceQueueAndPlay(["a", "b", "a"], startIndex);
      expect(selection.cache!.queue).toEqual({
        tracks: ["a", "b", "a"],
        index: Math.max(0, Math.min(startIndex, 2)),
        position: 0,
      });
      expect(audio.src).toBe("blob:a");
      expect(audio.play).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["clear", "replace"])("unloads playback when clearing via %s", async (command) => {
    const { player, getPlayer, selection, audio } = setup();
    await player.play();
    if (command === "clear") player.clearQueue();
    else await player.replaceQueueAndPlay([]);
    expect(selection.cache!.queue).toEqual({ tracks: [], index: -1, position: 0 });
    expect(getPlayer().status).toBe("idle");
    expect(audio.src).toBe("");
  });

  it("starts at raw index zero and leaves out-of-range navigation unchanged", async () => {
    const { player, queue, tracks, selection } = setup();
    queue.update({ tracks: ["missing", "a"], position: 0 });
    await player.play();
    expect(selection.cache!.queue.index).toBe(0);
    expect(tracks.getSource).not.toHaveBeenCalled();
    await player.previous();
    expect(selection.cache!.queue.index).toBe(0);
    await player.next();
    expect(selection.cache!.queue.index).toBe(1);
    expect(tracks.getSource).toHaveBeenCalledOnce();
    await player.next();
    for (const index of [-1, 2, 0.5, NaN]) await player.playIndex(index);
    expect(selection.cache!.queue.index).toBe(1);
    expect(tracks.getSource).toHaveBeenCalledOnce();
  });

  it("resumes a restored MP3 queue using the audio clock, not an assumed server offset", async () => {
    const { player, getPlayer, queue, selection, audio, tracks } = setup();
    const cache = selection.cache!;
    await cache.replaceLibrary({
      artists: [],
      albums: [],
      tracks: [{ ...song("a"), duration: 120, mimeType: "audio/mpeg" }],
      lastModified: 1,
      savedAt: 1,
    });
    queue.update({ tracks: ["a"], index: 0, position: 45.5 });
    await queue.flush();
    const restored = new Cache(cache.account!);
    await restored.load();
    selection.cache = restored;
    queue.activate();
    const network = new Network();
    const engine = new TrackEngine({
      selection,
      connection: network.accept(
        network.prepare({ ...cache.account!, token: "token", salt: "salt" }),
      ).audio,
    });
    cleanups.push(() => {
      engine.destroy();
      network.setMode("offline");
    });
    tracks.getSource.mockImplementation((track, options) => engine.getSource(track, options));
    expect(restored.queue.position).toBe(45.5);
    expect(audio.play).not.toHaveBeenCalled();
    await player.play();
    // Navidrome may return an original MP3, ignoring timeOffset when no
    // transcoding is needed. This source's audio clock starts at zero.
    expect(new URL(audio.src).searchParams.has("timeOffset")).toBe(false);
    expect(audio.currentTime).toBe(45.5);
    audio.currentTime = 119;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(getPlayer().position).toBe(119);
    expect(restored.queue.position).toBe(119);
    audio.currentTime = 120;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("ended"));
    expect(restored.queue.position).toBe(120);
    expect(getPlayer().status).toBe("ended");
  });

  it("preserves a restored duplicate index and position without autoplay", async () => {
    const {
      player,
      getPlayer,
      queuePosition,
      mountPlayer,
      queue,
      audio,
      updateTrack,
      session,
      selection,
    } = setup(false);
    updateTrack("a", { duration: 200 });
    queue.update({ tracks: ["a", "b", "a"], index: 2, position: 38 });
    mountPlayer();
    expect(selection.cache!.queue.index).toBe(2);
    expect(queuePosition()).toBe(38);
    expect(getPlayer().duration).toBe(0);
    expect(player.track?.duration).toBe(200);
    // The component has no loaded item until an explicit play command.
    expect(session.metadata).toBeNull();
    expect(session.setPositionState).toHaveBeenLastCalledWith(undefined);
    expect(getPlayer().playing).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(getPlayer().duration).toBe(0);
    await player.play();
    expect(audio.currentTime).toBe(38);
  });

  it("navigates duplicate occurrences by index instead of finding the first matching ID", async () => {
    const { player, queue, selection } = setup();
    queue.update({ tracks: ["a", "b", "a"], index: 0, position: 0 });
    await player.next();
    expect(selection.cache!.queue.index).toBe(1);
    await player.next();
    expect(selection.cache!.queue.index).toBe(2);
    expect(player.track?.id).toBe("a");
  });

  it.each([false, true])(
    "preserves unknown IDs and selection before or after mounting (mounted: %s)",
    (mounted) => {
      const { player, getPlayer, queuePosition, mountPlayer, queue, audio, selection } =
        setup(mounted);
      queue.update({ tracks: ["missing", "a", "b"], index: 1, position: 12 });
      if (!mounted) {
        expect(selection.cache!.queue.tracks).toEqual(["missing", "a", "b"]);
        mountPlayer();
      }
      expect(selection.cache!.queue.tracks).toEqual(["missing", "a", "b"]);
      expect(selection.cache!.queue.index).toBe(1);
      expect(player.track?.id).toBe("a");
      expect(queuePosition()).toBe(12);
      queue.update({ tracks: ["missing", "b"], index: 0, position: 30 });
      expect(selection.cache!.queue.tracks).toEqual(["missing", "b"]);
      expect(player.track).toBeUndefined();
      expect(selection.cache!.queue.index).toBe(0);
      expect(queuePosition()).toBe(30);
      expect(getPlayer().error).toBeUndefined();
      expect(audio.play).not.toHaveBeenCalled();
    },
  );

  it("refreshes app metadata but keeps Media Session metadata fixed until the next play", async () => {
    const { player, getPlayer, selection, renameTrack, audio, session, queue } = setup();
    expect(player.track).toBe(selection.cache!.tracks.get("a"));
    await player.play();
    renameTrack("a", "Updated title");
    expect(player.track).toBe(selection.cache!.tracks.get("a"));
    expect(player.track?.title).toBe("Updated title");
    expect(session.metadata).toMatchObject({ title: "a" });
    queue.setPosition(1);
    expect(session.metadata).toMatchObject({
      title: "a",
      artist: "Artist",
      album: "Album",
    });
    expect(getPlayer().playing).toBe(true);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("stops unavailable playback without deleting its saved selection or position", async () => {
    const { player, getPlayer, queuePosition, queue, removeTrack, audio, selection } = setup();
    await player.play();
    queue.setPosition(20);
    removeTrack("a");
    expect(player.track).toBeUndefined();
    expect(selection.cache!.queue.index).toBe(0);
    queue.setPosition(21);
    expect(selection.cache!.queue.tracks).toEqual(["a", "b"]);
    expect(player.track).toBeUndefined();
    expect(selection.cache!.queue.index).toBe(0);
    expect(queuePosition()).toBe(21);
    expect(getPlayer().playing).toBe(false);
    expect(getPlayer().error).toBeUndefined();
    expect(audio.src).toBe("");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("keeps playing when metadata removes a different queued track", async () => {
    const { player, getPlayer, queuePosition, queue, removeTrack, audio, selection } = setup();
    await player.play();
    queue.setPosition(20);
    removeTrack("b");
    expect(selection.cache!.queue.tracks).toEqual(["a", "b"]);
    expect(player.track?.id).toBe("a");
    expect(queuePosition()).toBe(20);
    expect(getPlayer().playing).toBe(true);
    expect(audio.src).toBe("blob:a");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("keeps navigation enabled for queued IDs missing from metadata", async () => {
    const { player, queue, selection, handlers, audio } = setup();
    queue.update({ tracks: ["missing", "a", "missing"], index: 1, position: 0 });
    flushSync();
    expect(handlers.get("previoustrack")).toEqual(expect.any(Function));
    expect(handlers.get("nexttrack")).toEqual(expect.any(Function));
    await player.next();
    expect(selection.cache!.queue.index).toBe(2);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("computes audio request and catalog fields from metadata at playback time", async () => {
    const { player, updateTrack, tracks, selection, session, library } = setup();
    library.artists = new Map([["artist", { id: "artist", name: "New artist", genres: [] }]]);
    library.albums = new Map([
      ["album", { id: "album", artistId: "artist", title: "New album", genres: [] }],
    ]);
    updateTrack("a", { mimeType: "audio/flac" });
    await player.play();
    expect(tracks.getSource).toHaveBeenCalledWith(
      {
        id: "a",
        title: "a",
        artist: "New artist",
        album: "New album",
        contentType: "audio/flac",
      },
      { forceTranscode: false, position: 0, signal: expect.any(AbortSignal) },
    );
    expect(session.metadata).toMatchObject({ artist: "New artist", album: "New album" });
  });

  it("keeps raw navigation when metadata changes without a queue event", async () => {
    const { player, queue, removeTrack, selection } = setup();
    queue.update({ tracks: ["a", "b", "c"], index: 0, position: 0 });
    await player.play();
    removeTrack("b");
    await player.next();
    expect(selection.cache!.queue.tracks).toEqual(["a", "b", "c"]);
    expect(player.track).toBeUndefined();
    expect(selection.cache!.queue.index).toBe(1);
    await player.next();
    expect(player.track?.id).toBe("c");
    expect(selection.cache!.queue.index).toBe(2);
  });

  it("creates audio only when mounted and configures metadata preloading", () => {
    const { mountPlayer, createAudio, audio } = setup(false);
    expect(createAudio).not.toHaveBeenCalled();
    mountPlayer();
    expect(createAudio).toHaveBeenCalledOnce();
    expect(audio.preload).toBe("metadata");
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("unloads playback and ignores stale audio progress when detached", async () => {
    const { player, audio, selection } = setup();
    await player.play();
    player.destroy();
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    audio.currentTime = 40;
    audio.src = "blob:stale";
    audio.dispatchEvent(new Event("timeupdate"));
    expect(selection.cache!.queue.position).toBe(0);
  });

  it("updates UI observers without recreating the mounted audio", async () => {
    const { player, getPlayer, queuePosition, audio, queue, createAudio } = setup();
    const observe = vi.fn(() => {
      void queuePosition();
      void getPlayer().playing;
    });
    const destroy = observePlayback(observe);
    try {
      flushSync();
      await player.play();
      audio.currentTime = 12;
      audio.dispatchEvent(new Event("timeupdate"));
      flushSync();
      queue.update({ tracks: ["a", "b", "c"], index: 0, position: 12 });
      flushSync();
      expect(createAudio).toHaveBeenCalledOnce();
      expect(observe.mock.calls.length).toBeGreaterThan(1);
      expect(queuePosition()).toBe(12);
    } finally {
      destroy();
    }
  });
  it("restores selection without autoplay and disables navigation at queue boundaries", async () => {
    const { player, audio, handlers } = setup();
    expect(audio.play).not.toHaveBeenCalled();
    expect(player.track?.id).toBe("a");
    expect(handlers.get("previoustrack")).toBeNull();
    await player.next();
    expect(player.track?.id).toBe("b");
    expect(handlers.get("nexttrack")).toBeNull();
    const count = audio.play.mock.calls.length;
    await player.next();
    expect(audio.play).toHaveBeenCalledTimes(count);
  });

  it("updates queue position and media session from audio events", async () => {
    const { player, getPlayer, queuePosition, audio, queue, session, tracks, selection } = setup();
    await player.play();
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.currentTime = 32;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(selection.cache!.queue.position).toBe(32);
    expect(queuePosition()).toBe(32);
    expect(getPlayer().duration).toBe(120);
    expect(getPlayer().playing).toBe(true);
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 32,
      playbackRate: 1,
    });
    queue.setPosition(33);
    expect(tracks.getSource).toHaveBeenCalledTimes(1);
  });

  it("supplies cached artwork at play time without subscribing to later changes", async () => {
    const { player, artwork, session, covers } = setup();
    artwork("data:image/jpeg;base64,bmV3");
    await player.play();
    artwork("data:image/jpeg;base64,bGF0ZXI=");
    expect(session.metadata).toMatchObject({
      title: "a",
      artwork: [{ src: "data:image/jpeg;base64,bmV3" }],
    });
    expect(covers.ensureTrackCover).toHaveBeenLastCalledWith("a", { allowNetwork: false });
  });

  it("advances at end but retains the final queue entry", async () => {
    const { player, getPlayer, audio, selection } = setup();
    await player.play();
    audio.dispatchEvent(new Event("ended"));
    await Promise.resolve();
    await Promise.resolve();
    expect(selection.cache!.queue.tracks[selection.cache!.queue.index]).toBe("b");
    await vi.waitFor(() => expect(getPlayer().playing).toBe(true));
    audio.dispatchEvent(new Event("ended"));
    expect(getPlayer().status).toBe("ended");
    expect(getPlayer().playing).toBe(false);
    expect(selection.cache!.queue.tracks).toHaveLength(2);
  });

  it("restarts after three seconds, otherwise plays the previous entry", async () => {
    const { player, audio, queue, selection } = setup();
    await player.playIndex(1);
    queue.setPosition(5);
    await player.previous();
    expect(selection.cache!.queue.tracks[selection.cache!.queue.index]).toBe("b");
    expect(audio.currentTime).toBe(0);
    await player.previous();
    expect(selection.cache!.queue.tracks[selection.cache!.queue.index]).toBe("a");
  });

  it("seeks within advertised original-file ranges without restarting the stream", async () => {
    const { player, queuePosition, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/raw",
      nativeSeeking: true,
    });
    await player.play();
    audio.seekable = {
      length: 2,
      start: (i) => (i === 0 ? 0 : 60),
      end: (i) => (i === 0 ? 20 : 120),
    };
    await player.seek(90);
    expect(audio.currentTime).toBe(90);
    expect(queuePosition()).toBe(90);
    expect(tracks.getSource).toHaveBeenCalledTimes(1);
    expect(tracks.cache).not.toHaveBeenCalled();
    player.pause();
    await player.seek(10);
    expect(audio.paused).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/offset",
      offset: 40,
    });
    await player.seek(40);
    expect(tracks.getSource).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe("https://server/offset");
    expect(audio.currentTime).toBe(0);
  });

  it("does not trust seekable ranges on transcoded streams", async () => {
    const { player, queuePosition, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/mp3",
    });
    await player.play();
    audio.seekable.length = 1;
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/offset",
      offset: 60,
    });
    await player.seek(60);
    expect(audio.src).toBe("https://server/offset");
    expect(audio.currentTime).toBe(0);
    expect(queuePosition()).toBe(60);
  });

  it("falls back to an offset stream if setting native seek time throws", async () => {
    const { player, getPlayer, queuePosition, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/raw",
      nativeSeeking: true,
    });
    await player.play();
    audio.seekable.length = 1;
    let currentTime = 0;
    Object.defineProperty(audio, "currentTime", {
      get: () => currentTime,
      set: (value: number) => {
        if (value === 60) throw new Error("Seek rejected");
        currentTime = value;
      },
    });
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/offset",
      offset: 60,
    });
    await player.seek(60);
    expect(audio.src).toBe("https://server/offset");
    expect(queuePosition()).toBe(60);
    expect(getPlayer().playing).toBe(true);
    expect(getPlayer().error).toBeUndefined();
  });

  it("streams from the beginning without starting an offline download", async () => {
    const { player, getPlayer, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/stream",
    });
    await player.play();
    expect(audio.src).toBe("https://server/stream");
    expect(getPlayer().playing).toBe(true);
    expect(tracks.cache).not.toHaveBeenCalled();
  });

  it("uses MP3 fallback for unsupported formats", async () => {
    const { player, getPlayer, audio, tracks } = setup();
    audio.play.mockRejectedValueOnce(new DOMException("unsupported", "NotSupportedError"));
    await player.play();
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: true,
      position: 0,
      signal: expect.any(AbortSignal),
    });
    expect(getPlayer().error).toBeUndefined();
    expect(getPlayer().playing).toBe(true);
  });

  it("preserves pause when seeking to an offset stream without downloading", async () => {
    const { player, queuePosition, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/stream",
    });
    await player.play();
    player.pause();
    tracks.cache.mockClear();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/offset",
      offset: 45,
    });
    await player.seek(45);
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: false,
      position: 45,
      signal: expect.any(AbortSignal),
    });
    expect(tracks.cache).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(0);
    expect(queuePosition()).toBe(45);
    expect(audio.paused).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("resumes an offset stream and translates time, duration, and buffered seeks", async () => {
    const { player, getPlayer, audio, tracks, queue, updateTrack, selection } = setup();
    updateTrack("a", { duration: 240 });
    queue.setPosition(120.5);
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/offset",
      offset: 120,
    });
    await player.play();
    expect(audio.currentTime).toBe(0.5);
    expect(getPlayer().playing).toBe(true);
    expect(tracks.cache).not.toHaveBeenCalled();
    audio.duration = 120;
    audio.dispatchEvent(new Event("durationchange"));
    expect(getPlayer().duration).toBe(240);
    audio.currentTime = 5;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(selection.cache!.queue.position).toBe(125);
    audio.buffered = { length: 1, start: () => 0, end: () => 20 };
    await player.seek(130);
    expect(audio.currentTime).toBe(10);
    expect(selection.cache!.queue.position).toBe(130);
    expect(tracks.getSource).toHaveBeenCalledTimes(1);
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/earlier",
      offset: 30,
    });
    await player.seek(30);
    expect(audio.currentTime).toBe(0);
    expect(selection.cache!.queue.position).toBe(30);
    expect(tracks.cache).not.toHaveBeenCalled();
    await player.next();
    audio.currentTime = 2;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(selection.cache!.queue.position).toBe(2);
  });

  it("cancels stale loading on pause", async () => {
    const { player, tracks, audio } = setup();
    let resolve!: (source: TrackSource) => void;
    tracks.getSource.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const play = player.play();
    player.pause();
    resolve({ cached: true, release: vi.fn(), url: "blob:late" });
    await play;
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe("");
  });

  it("cleans up metadata waits and ignores old mount cleanup", async () => {
    const { player, mountPlayer, audio, queue, detach, createAudio } = setup();
    queue.setPosition(20);
    audio.readyState = 0;
    const pending = player.play();
    await Promise.resolve();
    const replacement = new AudioStub();
    createAudio.mockImplementationOnce(function () {
      return replacement as unknown as HTMLAudioElement;
    });
    mountPlayer();
    detach();
    await pending;
    await player.play();
    expect(replacement.play).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("ignores a stale source after switching tracks", async () => {
    const { player, audio, tracks } = setup();
    let resolve!: (source: TrackSource) => void;
    tracks.getSource.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = player.play();
    await player.playIndex(1);
    resolve({ cached: true, release: vi.fn(), url: "blob:old" });
    await first;
    expect(audio.src).toBe("blob:b");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("resumes after an unbuffered seek only if playback was active", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      release: vi.fn(),
      url: "https://server/stream",
    });
    await player.play();
    await player.seek(50);
    expect(audio.currentTime).toBe(50);
    expect(audio.paused).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("contains source failures and permits retry", async () => {
    const { player, getPlayer, tracks } = setup();
    tracks.getSource.mockRejectedValueOnce(new Error("Network failed"));
    await expect(player.play()).resolves.toBeUndefined();
    expect(getPlayer().status).toBe("error");
    expect(getPlayer().error).toMatchObject({ message: "Network failed" });
    await player.play();
    expect(getPlayer().status).toBe("ready");
    expect(getPlayer().error).toBeUndefined();
  });

  it("flushes the queue when the page becomes hidden", () => {
    const { queue, doc } = setup();
    const flush = vi.spyOn(queue, "flush");
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledOnce();
  });

  it("clears playback and metadata if the selected track disappears", async () => {
    const { player, getPlayer, queue, audio, session } = setup();
    await player.play();
    queue.update({ tracks: [], position: 0 });
    expect(audio.src).toBe("");
    expect(getPlayer().status).toBe("idle");
    expect(session.metadata).toBeNull();
  });
});

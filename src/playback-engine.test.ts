import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackEngine } from "./playback-engine";
import { flushSync } from "svelte";
import { observePlayback } from "./playback-reactivity.test.svelte";
import { QueueEngine } from "./queue-engine";
import { Storage } from "./storage";
import type { Track } from "./schema";
import type { TrackSource } from "./track-engine";
import { Memory } from "./memory.svelte";

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
const cleanups: (() => void)[] = [];
function setup(mount = true, isAvailable: (id: string) => boolean = () => true) {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", doc);
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(data: MediaMetadataInit) {
        Object.assign(this, data);
      }
    },
  );
  const memory = new Memory();
  memory.tracks = new Map(["a", "b", "c"].map((id) => [id, song(id)]));
  memory.trackArtwork = new Map(["a", "b", "c"].map((id) => [id, [id]]));
  memory.artists = new Map([["artist", { id: "artist", name: "Artist", genres: [] }]]);
  memory.albums = new Map([
    ["album", { id: "album", title: "Album", artistId: "artist", genres: [] }],
  ]);
  const updateTrack = (id: string, patch: Partial<Track>) => {
    memory.tracks = new Map(memory.tracks).set(id, {
      ...song(id),
      ...memory.tracks.get(id),
      ...patch,
    });
  };
  const queue = new QueueEngine(memory);
  const audio = new AudioStub();
  const tracks = {
    getSource: vi.fn(
      async (
        track: { id: string },
        _options?: { forceTranscode?: boolean; position?: number },
      ): Promise<TrackSource> => ({ cached: true, url: `blob:${track.id}` }),
    ),
    cache: vi.fn(async () => new File([], "track")),
    releaseSource: vi.fn(),
  };
  const coverListeners = new Set<() => void>();
  let artwork = "data:image/jpeg;base64,aW1hZ2U=";
  const covers = {
    ensureTrackCover: vi.fn((id: string) => ({
      source: artwork,
      artworkId: id,
      cached: true,
      cache: () => {},
    })),
    subscribe: (listener: () => void) => {
      coverListeners.add(listener);
      return () => {
        coverListeners.delete(listener);
      };
    },
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
  const createAudio = vi.fn(() => audio as unknown as HTMLAudioElement);
  const player = new PlaybackEngine({
    createAudio,
    isAvailable,
    queue,
    memory,
    tracks,
    covers,
    mediaSession: session as unknown as MediaSession,
  });
  queue.update({ tracks: ["a", "b"], index: 0, position: 0 });
  const detach = mount ? player.mount() : () => {};
  cleanups.push(() => {
    player.destroy();
    queue.destroy();
  });
  return {
    memory,
    updateTrack,
    removeTrack(id: string) {
      const tracks = new Map(memory.tracks);
      tracks.delete(id);
      memory.tracks = tracks;
    },
    restoreTrack(id: string) {
      memory.tracks = new Map(memory.tracks).set(id, song(id));
      memory.trackArtwork = new Map(memory.trackArtwork).set(id, [id]);
    },
    renameTrack(id: string, title: string) {
      updateTrack(id, { title });
    },
    player,
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
      for (const listener of coverListeners) listener();
    },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class TestElement {
  constructor(readonly control?: string) {}
  closest(selector: string) {
    return this.control && selector.split(", ").includes(this.control) ? this : null;
  }
}

function setupShortcuts() {
  const { player, doc, detach } = setup();
  vi.stubGlobal("Element", TestElement);
  const toggle = vi.spyOn(player, "toggle").mockResolvedValue(undefined);
  const dispatch = (
    { handled = false, ...options }: Partial<KeyboardEvent> & { handled?: boolean } = {},
    target = new TestElement(),
  ) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: " ", composedPath: () => [target, doc] }, options);
    if (handled) event.preventDefault();
    doc.dispatchEvent(event);
    return event;
  };
  return { toggle, dispatch, cleanup: detach };
}

describe("playback engine", () => {
  it("keeps cached playback running when network sources are suspended", async () => {
    const { player, audio, tracks } = setup();
    await player.play();
    const source = audio.src;
    player.suspendNetwork();
    expect(player.playing).toBe(true);
    expect(audio.src).toBe(source);
    tracks.getSource.mockResolvedValue({ cached: false, url: "https://music.example/stream" });
    await player.next();
    player.suspendNetwork();
    expect(player.playing).toBe(false);
    expect(audio.src).toBe("");
  });

  it("suspends playback for account changes without losing queue selection or position", async () => {
    const { player, audio, memory, tracks } = setup();
    await player.play();
    audio.currentTime = 23;
    audio.dispatchEvent(new Event("timeupdate"));
    const queued = memory.queueTracks;
    player.suspend();
    expect(audio.src).toBe("");
    expect(player.playing).toBe(false);
    expect(memory.queueTracks).toBe(queued);
    expect(memory.queueIndex).toBe(0);
    expect(memory.queuePosition).toBe(23);
    await player.play();
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: false,
      position: 23,
    });
  });

  it("stops playback and clears selection and position without deleting the queue", async () => {
    const { player, memory, audio, session } = setup();
    await player.play();
    audio.currentTime = 8;
    audio.dispatchEvent(new Event("timeupdate"));
    player.stop();
    expect(memory.queueTracks).toEqual(["a", "b"]);
    expect(memory.queueIndex).toBe(-1);
    expect(memory.queuePosition).toBe(0);
    expect(player.playing).toBe(false);
    expect(audio.src).toBe("");
    expect(session.metadata).toBeNull();
  });

  it("does not upload deletions when a server queue arrives before fresh metadata", async () => {
    const { player, queue, audio, restoreTrack, memory } = setup();
    const { Network } = await import("./network.svelte");
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
    network.accept(client);
    await queue.restore(new Storage(client.account));
    queue.setConnection(network.queue(client));
    await queue.synchronize();
    await queue.flush();
    expect(memory.queueTracks).toEqual(["a", "fresh"]);
    expect(memory.queueIndex).toBe(1);
    expect(memory.queuePosition).toBe(12);
    expect(player.track).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    restoreTrack("fresh");
    expect(player.track?.id).toBe("fresh");
    expect(fetcher).toHaveBeenCalledOnce();
    await player.play();
    audio.currentTime = 13;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(player.playing).toBe(true);
    expect(memory.queueTracks).toEqual(["a", "fresh"]);
  });

  it("uses original indexes for duplicate selection and skips unavailable occurrences", async () => {
    const { player, queue, restoreTrack, memory } = setup();
    queue.update({ tracks: ["missing", "a", "missing", "a"], index: 1, position: 0 });
    await player.next();
    expect(memory.queueIndex).toBe(3);
    expect(player.hasNext).toBe(false);
    await player.previous();
    expect(memory.queueIndex).toBe(1);
    restoreTrack("missing");
    await player.next();
    expect(memory.queueIndex).toBe(2);
    expect(player.track?.id).toBe("missing");
    expect(memory.queueTracks).toEqual(["missing", "a", "missing", "a"]);
  });

  it("applies availability restrictions without changing queue membership", async () => {
    const available = new Set(["b"]);
    const { player, tracks, memory } = setup(true, (id) => available.has(id));
    await player.playIndex(0);
    await player.seek(50);
    expect(tracks.getSource).not.toHaveBeenCalled();
    expect(memory.queueIndex).toBe(0);
    expect(memory.queuePosition).toBe(0);
    await player.play();
    expect(memory.queueIndex).toBe(1);
    expect(memory.queueTracks).toEqual(["a", "b"]);
    available.add("a");
    await player.previous();
    expect(memory.queueIndex).toBe(0);
    expect(memory.queueTracks).toEqual(["a", "b"]);
  });

  it("preserves a restored duplicate index and position without autoplay", async () => {
    const { player, queue, audio, updateTrack, session, memory } = setup(false);
    updateTrack("a", { duration: 200 });
    queue.update({ tracks: ["a", "b", "a"], index: 2, position: 38 });
    player.mount();
    expect(memory.queueIndex).toBe(2);
    expect(player.position).toBe(38);
    expect(player.duration).toBe(200);
    expect(player.position / player.duration).toBe(0.19);
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 200,
      position: 38,
      playbackRate: 1,
    });
    expect(player.playing).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(player.duration).toBe(120);
    await player.play();
    expect(audio.currentTime).toBe(38);
  });

  it("navigates duplicate occurrences by index instead of finding the first matching ID", async () => {
    const { player, queue, memory } = setup();
    queue.update({ tracks: ["a", "b", "a"], index: 0, position: 0 });
    await player.next();
    expect(memory.queueIndex).toBe(1);
    await player.next();
    expect(memory.queueIndex).toBe(2);
    expect(player.track?.id).toBe("a");
    expect(player.hasNext).toBe(false);
  });

  it.each([false, true])(
    "preserves unknown IDs and selection before or after mounting (mounted: %s)",
    (mounted) => {
      const { player, queue, audio, memory } = setup(mounted);
      queue.update({ tracks: ["missing", "a", "b"], index: 1, position: 12 });
      if (!mounted) {
        expect(memory.queueTracks).toEqual(["missing", "a", "b"]);
        player.mount();
      }
      expect(memory.queueTracks).toEqual(["missing", "a", "b"]);
      expect(memory.queueIndex).toBe(1);
      expect(player.track?.id).toBe("a");
      expect(player.position).toBe(12);
      queue.update({ tracks: ["missing", "b"], index: 0, position: 30 });
      expect(memory.queueTracks).toEqual(["missing", "b"]);
      expect(player.track).toBeUndefined();
      expect(memory.queueIndex).toBe(0);
      expect(player.position).toBe(30);
      expect(player.error).toBeUndefined();
      expect(audio.play).not.toHaveBeenCalled();
    },
  );

  it("resolves the selected track directly from metadata and follows metadata refreshes", async () => {
    const { player, memory, renameTrack, audio, session, queue } = setup();
    expect(player.track).toBe(memory.tracks.get("a"));
    await player.play();
    renameTrack("a", "Updated title");
    expect(player.track).toBe(memory.tracks.get("a"));
    expect(player.track?.title).toBe("Updated title");
    expect(session.metadata).toMatchObject({ title: "a" });
    queue.setPosition(1);
    expect(session.metadata).toMatchObject({
      title: "Updated title",
      artist: "Artist",
      album: "Album",
    });
    expect(player.playing).toBe(true);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("stops unavailable playback without deleting its saved selection or position", async () => {
    const { player, queue, removeTrack, audio, memory } = setup();
    await player.play();
    queue.setPosition(20);
    removeTrack("a");
    expect(player.track).toBeUndefined();
    expect(memory.queueIndex).toBe(0);
    queue.setPosition(21);
    expect(memory.queueTracks).toEqual(["a", "b"]);
    expect(player.track).toBeUndefined();
    expect(memory.queueIndex).toBe(0);
    expect(player.position).toBe(21);
    expect(player.playing).toBe(false);
    expect(player.error).toBeUndefined();
    expect(audio.src).toBe("");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("keeps playing when metadata removes a different queued track", async () => {
    const { player, queue, removeTrack, audio, memory } = setup();
    await player.play();
    queue.setPosition(20);
    removeTrack("b");
    expect(memory.queueTracks).toEqual(["a", "b"]);
    expect(player.track?.id).toBe("a");
    expect(player.position).toBe(20);
    expect(player.playing).toBe(true);
    expect(player.hasNext).toBe(false);
    expect(audio.src).toBe("blob:a");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("computes audio request and catalog fields from metadata at playback time", async () => {
    const { player, updateTrack, tracks, memory, session } = setup();
    memory.artists = new Map([["artist", { id: "artist", name: "New artist", genres: [] }]]);
    memory.albums = new Map([
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
        coverArt: "a",
      },
      { forceTranscode: false, position: 0 },
    );
    expect(session.metadata).toMatchObject({ artist: "New artist", album: "New album" });
  });

  it("resolves navigation against current metadata without waiting for queue events", async () => {
    const { player, queue, removeTrack, memory } = setup();
    queue.update({ tracks: ["a", "b", "c"], index: 0, position: 0 });
    await player.play();
    removeTrack("b");
    expect(player.hasNext).toBe(true);
    await player.next();
    expect(memory.queueTracks).toEqual(["a", "b", "c"]);
    expect(player.track?.id).toBe("c");
    expect(memory.queueIndex).toBe(2);
  });

  describe("keyboard shortcuts", () => {
    it("toggles playback with Space and prevents scrolling", () => {
      const { toggle, dispatch } = setupShortcuts();
      expect(dispatch().defaultPrevented).toBe(true);
      expect(toggle).toHaveBeenCalledOnce();
    });

    it("suppresses scrolling without toggling again on key repeat", () => {
      const { toggle, dispatch } = setupShortcuts();
      dispatch();
      expect(dispatch({ repeat: true }).defaultPrevented).toBe(true);
      expect(toggle).toHaveBeenCalledOnce();
    });

    it.each(["button", "a[href]", '[role="button"]'])(
      "uses Space for playback on %s but leaves Enter alone",
      (control) => {
        const { toggle, dispatch } = setupShortcuts();
        const target = new TestElement(control);
        expect(dispatch({}, target).defaultPrevented).toBe(true);
        expect(toggle).toHaveBeenCalledOnce();
        expect(dispatch({ key: "Enter" }, target).defaultPrevented).toBe(false);
        expect(toggle).toHaveBeenCalledOnce();
      },
    );

    it.each([
      "input",
      "textarea",
      "select",
      "summary",
      "audio",
      "video",
      '[contenteditable]:not([contenteditable="false"])',
      '[role="slider"]',
      '[role="textbox"]',
    ])("preserves keyboard interaction on %s", (control) => {
      const { toggle, dispatch } = setupShortcuts();
      expect(dispatch({}, new TestElement(control)).defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    });

    it.each([
      { key: "Enter" },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { shiftKey: true },
      { isComposing: true },
    ])("ignores other keys, modified shortcuts, and composition: %j", (options) => {
      const { toggle, dispatch } = setupShortcuts();
      expect(dispatch(options).defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    });

    it("respects already handled events and removes its listener on cleanup", () => {
      const { toggle, dispatch, cleanup } = setupShortcuts();
      dispatch({ handled: true });
      expect(toggle).not.toHaveBeenCalled();
      cleanup();
      expect(dispatch().defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    });
  });

  it("creates audio only when mounted and configures metadata preloading", () => {
    const { player, createAudio, audio } = setup(false);
    expect(createAudio).not.toHaveBeenCalled();
    player.mount();
    expect(createAudio).toHaveBeenCalledOnce();
    expect(audio.preload).toBe("metadata");
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("owns the Space shortcut and removes it along with audio listeners", async () => {
    const { player, audio, doc, memory } = setup();
    const toggle = vi.spyOn(player, "toggle");
    const space = () => {
      const event = new Event("keydown", { cancelable: true });
      Object.assign(event, { key: " ", composedPath: () => [] });
      doc.dispatchEvent(event);
      return event;
    };
    expect(space().defaultPrevented).toBe(true);
    expect(toggle).toHaveBeenCalledOnce();
    await toggle.mock.results[0].value;
    expect(audio.paused).toBe(false);
    player.destroy();
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    expect(space().defaultPrevented).toBe(false);
    expect(toggle).toHaveBeenCalledOnce();
    audio.currentTime = 40;
    audio.src = "blob:stale";
    audio.dispatchEvent(new Event("timeupdate"));
    expect(memory.queuePosition).toBe(0);
  });

  it("updates UI observers without recreating the mounted audio", async () => {
    const { player, audio, queue, createAudio } = setup();
    const observe = vi.fn(() => {
      void player.position;
      void player.playing;
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
      expect(player.position).toBe(12);
    } finally {
      destroy();
    }
  });
  it("restores selection without autoplay and disables unavailable next/previous actions", async () => {
    const { player, audio, handlers } = setup();
    expect(audio.play).not.toHaveBeenCalled();
    expect(player.track?.id).toBe("a");
    expect(player.hasPrevious).toBe(false);
    expect(handlers.get("previoustrack")).toBeNull();
    await player.next();
    expect(player.track?.id).toBe("b");
    expect(player.hasNext).toBe(false);
    expect(handlers.get("nexttrack")).toBeNull();
    const count = audio.play.mock.calls.length;
    await player.next();
    expect(audio.play).toHaveBeenCalledTimes(count);
  });

  it("updates queue position and media session from audio events", async () => {
    const { player, audio, queue, session, tracks, memory } = setup();
    await player.play();
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.currentTime = 32;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(memory.queuePosition).toBe(32);
    expect(player.position).toBe(32);
    expect(player.duration).toBe(120);
    expect(player.playing).toBe(true);
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 120,
      position: 32,
      playbackRate: 1,
    });
    queue.setPosition(33);
    expect(tracks.getSource).toHaveBeenCalledTimes(1);
  });

  it("uses cached artwork and updates without a UI subscription", () => {
    const { artwork, session, covers } = setup();
    artwork("data:image/jpeg;base64,bmV3");
    expect(session.metadata).toMatchObject({
      title: "a",
      artwork: [{ src: "data:image/jpeg;base64,bmV3" }],
    });
    expect(covers.ensureTrackCover).toHaveBeenLastCalledWith("a", { allowNetwork: false });
  });

  it("advances at end but retains the final queue entry", async () => {
    const { player, audio, memory } = setup();
    await player.play();
    audio.dispatchEvent(new Event("ended"));
    await Promise.resolve();
    await Promise.resolve();
    expect(memory.queueTracks[memory.queueIndex]).toBe("b");
    audio.dispatchEvent(new Event("ended"));
    expect(player.status).toBe("ended");
    expect(player.playing).toBe(false);
    expect(memory.queueTracks).toHaveLength(2);
  });

  it("restarts after three seconds, otherwise plays the previous entry", async () => {
    const { player, audio, queue, memory } = setup();
    await player.playIndex(1);
    queue.setPosition(5);
    await player.previous();
    expect(memory.queueTracks[memory.queueIndex]).toBe("b");
    expect(audio.currentTime).toBe(0);
    await player.previous();
    expect(memory.queueTracks[memory.queueIndex]).toBe("a");
  });

  it("seeks within advertised original-file ranges without restarting the stream", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
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
    expect(player.position).toBe(90);
    expect(tracks.getSource).toHaveBeenCalledTimes(1);
    expect(tracks.cache).not.toHaveBeenCalled();
    player.pause();
    await player.seek(10);
    expect(audio.paused).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      url: "https://server/offset",
      offset: 40,
    });
    await player.seek(40);
    expect(tracks.getSource).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe("https://server/offset");
    expect(audio.currentTime).toBe(0);
  });

  it("does not trust seekable ranges on transcoded streams", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({ cached: false, url: "https://server/mp3" });
    await player.play();
    audio.seekable.length = 1;
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      url: "https://server/offset",
      offset: 60,
    });
    await player.seek(60);
    expect(audio.src).toBe("https://server/offset");
    expect(audio.currentTime).toBe(0);
    expect(player.position).toBe(60);
  });

  it("falls back to an offset stream if setting native seek time throws", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
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
      url: "https://server/offset",
      offset: 60,
    });
    await player.seek(60);
    expect(audio.src).toBe("https://server/offset");
    expect(player.position).toBe(60);
    expect(player.playing).toBe(true);
    expect(player.error).toBeUndefined();
  });

  it("streams from the beginning without starting an offline download", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({ cached: false, url: "https://server/stream" });
    await player.play();
    expect(audio.src).toBe("https://server/stream");
    expect(player.playing).toBe(true);
    expect(tracks.cache).not.toHaveBeenCalled();
  });

  it("uses MP3 fallback for unsupported formats", async () => {
    const { player, audio, tracks } = setup();
    audio.play.mockRejectedValueOnce(new DOMException("unsupported", "NotSupportedError"));
    await player.play();
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: true,
      position: 0,
    });
    expect(player.error).toBeUndefined();
    expect(player.playing).toBe(true);
  });

  it("preserves pause when seeking to an offset stream without downloading", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({ cached: false, url: "https://server/stream" });
    await player.play();
    player.pause();
    tracks.cache.mockClear();
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      url: "https://server/offset",
      offset: 45,
    });
    await player.seek(45);
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: false,
      position: 45,
    });
    expect(tracks.cache).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(0);
    expect(player.position).toBe(45);
    expect(audio.paused).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("resumes an offset stream and translates time, duration, and buffered seeks", async () => {
    const { player, audio, tracks, queue, updateTrack, memory } = setup();
    updateTrack("a", { duration: 240 });
    queue.setPosition(120.5);
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      url: "https://server/offset",
      offset: 120,
    });
    await player.play();
    expect(audio.currentTime).toBe(0.5);
    expect(player.playing).toBe(true);
    expect(tracks.cache).not.toHaveBeenCalled();
    audio.duration = 120;
    audio.dispatchEvent(new Event("durationchange"));
    expect(player.duration).toBe(240);
    audio.currentTime = 5;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(memory.queuePosition).toBe(125);
    audio.buffered = { length: 1, start: () => 0, end: () => 20 };
    await player.seek(130);
    expect(audio.currentTime).toBe(10);
    expect(memory.queuePosition).toBe(130);
    expect(tracks.getSource).toHaveBeenCalledTimes(1);
    tracks.getSource.mockResolvedValueOnce({
      cached: false,
      url: "https://server/earlier",
      offset: 30,
    });
    await player.seek(30);
    expect(audio.currentTime).toBe(0);
    expect(memory.queuePosition).toBe(30);
    expect(tracks.cache).not.toHaveBeenCalled();
    await player.next();
    audio.currentTime = 2;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(memory.queuePosition).toBe(2);
  });

  it("cancels stale loading on pause", async () => {
    const { player, tracks, audio } = setup();
    let resolve!: (source: { cached: boolean; url: string }) => void;
    tracks.getSource.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const play = player.play();
    player.pause();
    resolve({ cached: true, url: "blob:late" });
    await play;
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe("");
  });

  it("cleans up metadata waits and ignores old mount cleanup", async () => {
    const { player, audio, queue, detach, createAudio } = setup();
    queue.setPosition(20);
    audio.readyState = 0;
    const pending = player.play();
    await Promise.resolve();
    const replacement = new AudioStub();
    createAudio.mockReturnValueOnce(replacement as unknown as HTMLAudioElement);
    player.mount();
    detach();
    await pending;
    await player.play();
    expect(replacement.play).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("ignores a stale source after switching tracks", async () => {
    const { player, audio, tracks } = setup();
    let resolve!: (source: { cached: boolean; url: string }) => void;
    tracks.getSource.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = player.play();
    await player.playIndex(1);
    resolve({ cached: true, url: "blob:old" });
    await first;
    expect(audio.src).toBe("blob:b");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("resumes after an unbuffered seek only if playback was active", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({ cached: false, url: "https://server/stream" });
    await player.play();
    await player.seek(50);
    expect(audio.currentTime).toBe(50);
    expect(audio.paused).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("contains source failures and permits retry", async () => {
    const { player, tracks } = setup();
    tracks.getSource.mockRejectedValueOnce(new Error("Network failed"));
    await expect(player.play()).resolves.toBeUndefined();
    expect(player.status).toBe("error");
    expect(player.error).toMatchObject({ message: "Network failed" });
    await player.play();
    expect(player.status).toBe("ready");
    expect(player.error).toBeUndefined();
  });

  it("flushes the queue when the page becomes hidden", () => {
    const { queue, doc } = setup();
    const flush = vi.spyOn(queue, "flush");
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalledOnce();
  });

  it("clears playback and metadata if the selected track disappears", async () => {
    const { player, queue, audio, session } = setup();
    await player.play();
    queue.update({ tracks: [], position: 0 });
    expect(audio.src).toBe("");
    expect(player.status).toBe("idle");
    expect(session.metadata).toBeNull();
  });
});

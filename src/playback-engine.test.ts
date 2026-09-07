import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackEngine } from "./playback-engine";
import { flushSync } from "svelte";
import { observePlayback } from "./playback-reactivity.test.svelte";
import { QueueEngine } from "./queue-engine";
import type { Track } from "./metadata-engine";

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
function setup(mount = true) {
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
  const libraryTracks = new Map(["a", "b", "c"].map((id) => [id, song(id)]));
  const metadata = {
    getTrack: (id: string) => libraryTracks.get(id),
    getArtist: (id: string) => ({ id, name: "Artist", genres: [] }),
    getAlbum: (id: string) => ({ id, title: "Album", artistId: "artist", genres: [] }),
  };
  const queue = new QueueEngine();
  const audio = new AudioStub();
  const tracks = {
    getSource: vi.fn(async (track: { id: string }, _options?: { forceTranscode?: boolean }) => ({
      cached: true,
      url: `blob:${track.id}`,
    })),
    cache: vi.fn(async () => new File([], "track")),
    releaseSource: vi.fn(),
  };
  const coverListeners = new Set<() => void>();
  let artwork = "data:image/jpeg;base64,aW1hZ2U=";
  const covers = {
    getTrackCover: vi.fn((id: string) => ({
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
    queue,
    metadata,
    tracks,
    covers,
    mediaSession: session as unknown as MediaSession,
  });
  queue.update({ tracks: ["a", "b"], current: "a", position: 0 });
  const detach = mount ? player.mount() : () => {};
  cleanups.push(() => {
    player.destroy();
    queue.destroy();
  });
  return {
    metadata,
    removeTrack(id: string) {
      libraryTracks.delete(id);
    },
    renameTrack(id: string, title: string) {
      libraryTracks.set(id, { ...libraryTracks.get(id)!, title });
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
  it.each([false, true])(
    "drops unknown IDs for queues received before or after mounting (mounted: %s)",
    (mounted) => {
      const { player, queue, audio } = setup(mounted);
      queue.update({ tracks: ["missing", "a", "b"], current: "a", position: 12 });
      if (!mounted) {
        expect(queue.tracks).toEqual(["missing", "a", "b"]);
        player.mount();
      }
      expect(queue.tracks).toEqual(["a", "b"]);
      expect(player.track?.id).toBe("a");
      expect(player.position).toBe(12);
      queue.update({ tracks: ["missing", "b"], current: "missing", position: 30 });
      expect(queue.tracks).toEqual(["b"]);
      expect(player.track).toBeUndefined();
      expect(player.position).toBe(0);
      expect(player.error).toBeUndefined();
      expect(audio.play).not.toHaveBeenCalled();
    },
  );

  it("resolves the selected track directly from metadata and follows metadata refreshes", async () => {
    const { player, metadata, renameTrack, audio, session, queue } = setup();
    expect(player.track).toBe(metadata.getTrack("a"));
    await player.play();
    renameTrack("a", "Updated title");
    expect(player.track).toBe(metadata.getTrack("a"));
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

  it("cleans up a missing selected track on the next queue event without autoplaying", async () => {
    const { player, queue, removeTrack, audio } = setup();
    await player.play();
    queue.setPosition(20);
    removeTrack("a");
    expect(player.track).toBeUndefined();
    expect(player.currentIndex).toBe(-1);
    queue.setPosition(21);
    expect(queue.tracks).toEqual(["b"]);
    expect(player.track).toBeUndefined();
    expect(player.currentIndex).toBe(-1);
    expect(player.position).toBe(0);
    expect(player.playing).toBe(false);
    expect(player.error).toBeUndefined();
    expect(audio.src).toBe("");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("keeps playing when metadata removes a different queued track", async () => {
    const { player, queue, removeTrack, audio } = setup();
    await player.play();
    queue.setPosition(20);
    removeTrack("b");
    expect(queue.tracks).toEqual(["a", "b"]);
    expect(player.track?.id).toBe("a");
    expect(player.position).toBe(20);
    expect(player.playing).toBe(true);
    expect(player.hasNext).toBe(false);
    expect(audio.src).toBe("blob:a");
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("computes audio request and catalog fields from metadata at playback time", async () => {
    const { player, metadata, tracks } = setup();
    metadata.getTrack("a")!.mimeType = "audio/flac";
    await player.play();
    expect(tracks.getSource).toHaveBeenCalledWith(
      {
        id: "a",
        title: "a",
        artist: "Artist",
        album: "Album",
        contentType: "audio/flac",
        coverArt: "a",
      },
      { forceTranscode: false },
    );
  });

  it("resolves navigation against current metadata without waiting for queue events", async () => {
    const { player, queue, removeTrack } = setup();
    queue.update({ tracks: ["a", "b", "c"], current: "a", position: 0 });
    await player.play();
    removeTrack("b");
    expect(player.hasNext).toBe(true);
    await player.next();
    expect(queue.tracks).toEqual(["a", "c"]);
    expect(player.track?.id).toBe("c");
    expect(player.currentIndex).toBe(1);
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
    const { player, audio, doc, queue } = setup();
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
    expect(queue.position).toBe(0);
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
      queue.update({ tracks: ["a", "b", "c"], current: "a", position: 12 });
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
    const { player, audio, queue, session, tracks } = setup();
    await player.play();
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.currentTime = 32;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(queue.position).toBe(32);
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
    expect(covers.getTrackCover).toHaveBeenLastCalledWith("a", { allowNetwork: false });
  });

  it("advances at end but retains the final queue entry", async () => {
    const { player, audio, queue } = setup();
    await player.play();
    audio.dispatchEvent(new Event("ended"));
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.current).toBe("b");
    audio.dispatchEvent(new Event("ended"));
    expect(player.status).toBe("ended");
    expect(player.playing).toBe(false);
    expect(queue.tracks).toHaveLength(2);
  });

  it("restarts after three seconds, otherwise plays the previous entry", async () => {
    const { player, audio, queue } = setup();
    await player.playIndex(1);
    queue.setPosition(5);
    await player.previous();
    expect(queue.current).toBe("b");
    expect(audio.currentTime).toBe(0);
    await player.previous();
    expect(queue.current).toBe("a");
  });

  it("uses MP3 fallback for unsupported formats", async () => {
    const { player, audio, tracks } = setup();
    audio.play.mockRejectedValueOnce(new DOMException("unsupported", "NotSupportedError"));
    await player.play();
    expect(tracks.getSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: true,
    });
    expect(player.error).toBeUndefined();
    expect(player.playing).toBe(true);
  });

  it("preserves pause when seeking through a transcoded cache", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({ cached: false, url: "https://server/stream" });
    await player.play();
    player.pause();
    await player.seek(45);
    expect(tracks.cache).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), {
      forceTranscode: true,
      priority: "playback",
    });
    expect(audio.currentTime).toBe(45);
    expect(audio.paused).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
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

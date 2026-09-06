import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackEngine } from "./playback-engine";
import { flushSync, untrack } from "svelte";
import { observePlayback } from "./playback-reactivity.test.svelte";
import { QueueEngine, type QueueTrack } from "./queue-engine";

class AudioStub extends EventTarget {
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
const song = (id: string): QueueTrack => ({
  id,
  title: id,
  artist: "Artist",
  album: "Album",
  coverArt: id,
});
const cleanups: (() => void)[] = [];
function setup() {
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
    getCover: vi.fn(() => ({ source: artwork, cache: () => {} })),
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
  const player = new PlaybackEngine({
    queue,
    tracks,
    covers,
    mediaSession: session as unknown as MediaSession,
  });
  queue.update({ tracks: [song("a"), song("b")], current: "a", position: 0 });
  const detach = player.bind(audio as unknown as HTMLAudioElement);
  cleanups.push(() => {
    player.destroy();
    queue.destroy();
  });
  return {
    player,
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

describe("playback engine", () => {
  it("supports untracked attachment setup while UI observers receive updates", async () => {
    const { player, audio, queue, detach } = setup();
    detach();
    const bind = vi.fn(() => untrack(() => player.bind(audio as unknown as HTMLAudioElement)));
    const observe = vi.fn(() => {
      void player.position;
      void player.playing;
    });
    const destroy = observePlayback(bind, observe);
    try {
      flushSync();
      await player.play();
      audio.currentTime = 12;
      audio.dispatchEvent(new Event("timeupdate"));
      flushSync();
      queue.update({ tracks: [song("a"), song("b"), song("c")], current: "a", position: 12 });
      flushSync();
      expect(bind).toHaveBeenCalledOnce();
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
    expect(covers.getCover).toHaveBeenLastCalledWith({ candidates: ["a"], allowNetwork: false });
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
    expect(tracks.getSource).toHaveBeenLastCalledWith(song("a"), { forceTranscode: true });
    expect(player.error).toBeUndefined();
    expect(player.playing).toBe(true);
  });

  it("preserves pause when seeking through a transcoded cache", async () => {
    const { player, audio, tracks } = setup();
    tracks.getSource.mockResolvedValueOnce({ cached: false, url: "https://server/stream" });
    await player.play();
    player.pause();
    await player.seek(45);
    expect(tracks.cache).toHaveBeenCalledWith(song("a"), { forceTranscode: true });
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

  it("cleans up metadata waits and ignores old attachment cleanup", async () => {
    const { player, audio, queue, detach } = setup();
    queue.setPosition(20);
    audio.readyState = 0;
    const pending = player.play();
    await Promise.resolve();
    const replacement = new AudioStub();
    player.bind(replacement as unknown as HTMLAudioElement);
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

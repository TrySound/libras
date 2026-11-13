// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";
import Player, { type PlayerTrack } from "../src/audio-player.svelte";

const cleanups: (() => Promise<void>)[] = [];
function setup(unsupported = false, available = true) {
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(value: MediaMetadataInit) {
        Object.assign(this, value);
      }
    },
  );
  const handlers = new Map<string, MediaSessionActionHandler | null>();
  let playbackState = "none";
  const session = {
    metadata: null,
    get playbackState() {
      return playbackState;
    },
    set playbackState(value: string) {
      playbackState = value;
    },
    setPositionState: vi.fn(),
    setActionHandler: vi.fn((action: string, handler: MediaSessionActionHandler | null) => {
      if (unsupported && action === "seekto") throw new Error("Unsupported action");
      handlers.set(action, handler);
    }),
  };
  vi.stubGlobal("navigator", available ? { mediaSession: session } : {});
  const audio = Object.assign(new EventTarget(), {
    preload: "",
    src: "",
    currentTime: 0,
    duration: 100,
    playbackRate: 1,
    readyState: 1,
    paused: true,
    buffered: { length: 0, start: () => 0, end: () => 100 },
    seekable: { length: 0, start: () => 0, end: () => 100 },
    play: vi.fn(async () => {
      audio.paused = false;
      audio.dispatchEvent(new Event("playing"));
    }),
    pause: () => {
      audio.paused = true;
      audio.dispatchEvent(new Event("pause"));
    },
    load: () => {
      audio.currentTime = 0;
    },
    removeAttribute: () => {
      audio.src = "";
    },
  });
  Object.defineProperty(audio, "currentSrc", { configurable: true, get: () => audio.src });
  vi.stubGlobal(
    "Audio",
    vi.fn(function () {
      return audio;
    }),
  );
  const onnext = vi.fn();
  const onprevious = vi.fn();
  const onposition = vi.fn();
  const onstatechange = vi.fn();
  const playbackWrites = vi.spyOn(session, "playbackState", "set");
  const player = mount(Player, {
    target: document.createElement("div"),
    props: {
      hasNext: true,
      hasPrevious: true,
      onnext,
      onprevious,
      onposition,
      onstatechange,
    },
  });
  flushSync();
  const destroy = () => unmount(player);
  cleanups.push(destroy);
  const play = (metadata: PlayerTrack["metadata"], position = 0) =>
    player.play({
      metadata,
      position,
      getSource: async () => ({ url: "blob:audio", seekMode: "full", release() {} }),
    });
  return {
    player,
    session,
    handlers,
    audio,
    onnext,
    onprevious,
    onposition,
    onstatechange,
    playbackWrites,
    play,
    destroy,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

describe("Player Media Session integration", () => {
  it("publishes track metadata and converts late artwork to self-contained bytes", async () => {
    const { play, session } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("image", {
            headers: { "Content-Type": "image/jpeg" },
          }),
      ),
    );
    const artwork = new SvelteMap<string, string>();
    await play({
      title: "Song",
      artist: "Artist",
      album: "Album",
      get artwork() {
        return artwork.get("source");
      },
    });
    expect(session.metadata).toMatchObject({ title: "Song", artwork: [] });
    artwork.set("source", "blob:cover");
    await vi.waitFor(() =>
      expect(session.metadata).toMatchObject({
        title: "Song",
        artist: "Artist",
        album: "Album",
        artwork: [{ src: "data:image/jpeg;base64,aW1hZ2U=" }],
      }),
    );
    await play({ title: "Next song" });
    expect(session.metadata).toMatchObject({ title: "Next song", artwork: [] });
    expect(session.playbackState).toBe("playing");
  });

  it("observes only the current artwork getter while keeping text metadata snapshotted", async () => {
    const { play, session, destroy } = setup();
    const artwork = new SvelteMap<string, string>();
    const metadata = {
      title: "Original",
      get artwork() {
        return artwork.get("source");
      },
    };
    await play(metadata);
    metadata.title = "Changed";
    artwork.set("source", "data:image/png;base64,aW1hZ2U=");
    flushSync();
    expect(session.metadata).toMatchObject({
      title: "Original",
      artwork: [{ src: "data:image/png;base64,aW1hZ2U=" }],
    });
    await play({ title: "Next" });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    artwork.set("source", "blob:obsolete");
    flushSync();
    expect(session.metadata).toMatchObject({ title: "Next", artwork: [] });
    expect(fetcher).not.toHaveBeenCalled();
    await destroy();
    artwork.set("source", "blob:destroyed");
    flushSync();
    expect(session.metadata).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not publish stale artwork after a track change or destruction", async () => {
    const { play, session, destroy } = setup();
    let resolve!: (response: Response) => void;
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode("image").buffer);
    const response = () =>
      ({
        ok: true,
        blob: async () => ({ size: 5, type: "image/jpeg", arrayBuffer }),
      }) as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    await play({ title: "Old", artwork: "blob:old" });
    await play({ title: "New" });
    resolve(response());
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());
    expect(session.metadata).toMatchObject({ title: "New", artwork: [] });
    await play({ title: "Late", artwork: "blob:late" });
    await destroy();
    resolve(response());
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledTimes(2));
    expect(session.metadata).toBeNull();
  });

  it("keeps text metadata when artwork cannot be read", async () => {
    const { play, session } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Revoked blob");
      }),
    );
    await play({ title: "Song", artwork: "blob:missing" });
    expect(session.metadata).toMatchObject({ title: "Song", artwork: [] });
  });

  it("routes transport controls and clamps seeking", async () => {
    const { play, player, handlers, audio, onnext, onprevious } = setup();
    await play({ title: "Song", duration: 100 }, 95);
    handlers.get("pause")!({ action: "pause" });
    expect(player.playing).toBe(false);
    handlers.get("play")!({ action: "play" });
    expect(audio.play).toHaveBeenCalledTimes(2);
    handlers.get("nexttrack")!({ action: "nexttrack" });
    handlers.get("previoustrack")!({ action: "previoustrack" });
    expect(onnext).toHaveBeenCalledOnce();
    expect(onprevious).toHaveBeenCalledOnce();
    handlers.get("seekforward")!({ action: "seekforward" });
    expect(player.position).toBe(100);
    handlers.get("seekbackward")!({ action: "seekbackward", seekOffset: 20 });
    expect(player.position).toBe(80);
    handlers.get("seekto")!({ action: "seekto", seekTime: -5 });
    expect(player.position).toBe(0);
  });

  it("updates progress callbacks without any Media Session writes", async () => {
    const { play, player, audio, session, playbackWrites, onposition } = setup();
    await play({ title: "Song", duration: 100 });
    session.setPositionState.mockClear();
    playbackWrites.mockClear();
    onposition.mockClear();
    for (const seconds of [10, 20, 30]) {
      audio.currentTime = seconds;
      audio.dispatchEvent(new Event("timeupdate"));
    }
    expect(player.position).toBe(30);
    expect(onposition.mock.calls).toEqual([[10], [20], [30]]);
    expect(session.setPositionState).not.toHaveBeenCalled();
    expect(playbackWrites).not.toHaveBeenCalled();
  });

  it("freezes buffering through canplay and rate changes until actual playing", async () => {
    const { play, player, audio, session, onstatechange } = setup();
    await play({ title: "Song", duration: 100 });
    onstatechange.mockClear();
    audio.currentTime = 12;
    audio.dispatchEvent(new Event("waiting"));
    audio.dispatchEvent(new Event("waiting"));
    expect(player.playing).toBe(true);
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 12,
      playbackRate: 1,
    });
    audio.playbackRate = 2;
    audio.dispatchEvent(new Event("ratechange"));
    audio.dispatchEvent(new Event("canplay"));
    expect(session.playbackState).toBe("paused");
    audio.currentTime = 13;
    audio.dispatchEvent(new Event("playing"));
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 13,
      playbackRate: 2,
    });
    expect(onstatechange.mock.calls.map(([state]) => state)).toEqual([
      { status: "buffering", playing: true },
      { status: "ready", playing: true },
    ]);
    audio.dispatchEvent(new Event("waiting"));
    player.pause();
    audio.dispatchEvent(new Event("canplay"));
    expect(session.playbackState).toBe("paused");
    expect(player.playing).toBe(false);
  });

  it("distinguishes stalled downloads from an insufficient-data stall", async () => {
    const { play, audio, session } = setup();
    await play({ title: "Song", duration: 100 });
    audio.readyState = 3;
    session.setPositionState.mockClear();
    audio.dispatchEvent(new Event("stalled"));
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).not.toHaveBeenCalled();
    audio.readyState = 2;
    audio.currentTime = 17;
    audio.dispatchEvent(new Event("stalled"));
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 17,
      playbackRate: 1,
    });
    audio.dispatchEvent(new Event("canplay"));
    expect(session.playbackState).toBe("paused");
  });

  it("anchors explicit and native seeks, pause, metadata, and end without progress events", async () => {
    const { play, player, audio, session, onposition } = setup();
    await play({ title: "Song", duration: 100 });
    await player.seek(25);
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 25,
      playbackRate: 1,
    });
    onposition.mockClear();
    audio.currentTime = 40;
    audio.dispatchEvent(new Event("seeking"));
    expect(session.playbackState).toBe("paused");
    audio.dispatchEvent(new Event("seeked"));
    expect(session.playbackState).toBe("playing");
    expect(onposition).not.toHaveBeenCalled();
    audio.currentTime = 41;
    audio.paused = true;
    audio.dispatchEvent(new Event("pause"));
    expect(session.playbackState).toBe("paused");
    audio.duration = 90;
    audio.dispatchEvent(new Event("durationchange"));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 90,
      position: 41,
      playbackRate: 1,
    });
    await player.seek(45);
    expect(session.playbackState).toBe("paused");
    await player.resume();
    audio.currentTime = 90;
    audio.dispatchEvent(new Event("ended"));
    expect(session.playbackState).toBe("paused");
    expect(session.metadata).toMatchObject({ title: "Song" });
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 90,
      position: 90,
      playbackRate: 1,
    });
  });

  it("uses requested replacement anchors, ignores retired media, and cancels late sources", async () => {
    const { play, player, audio, session } = setup();
    await play({ title: "Old", duration: 100 });
    audio.currentTime = 80;
    audio.duration = 150;
    audio.dispatchEvent(new Event("durationchange"));
    audio.dispatchEvent(new Event("waiting"));
    let resolve!: (source: {
      url: string;
      offset: number;
      seekMode: "full";
      release: () => void;
    }) => void;
    // Some browsers retain currentSrc after clearing src.
    Object.defineProperty(audio, "currentSrc", { configurable: true, get: () => "blob:retired" });
    const pending = player.play({
      metadata: { title: "New", duration: 300 },
      position: 200,
      getSource: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 300,
      position: 200,
      playbackRate: 1,
    });
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 300,
      position: 200,
      playbackRate: 1,
    });
    const release = vi.fn();
    player.unload();
    session.setPositionState.mockClear();
    resolve({ url: "blob:late", offset: 190, seekMode: "full", release });
    await pending;
    expect(release).toHaveBeenCalledOnce();
    expect(session.setPositionState).not.toHaveBeenCalled();
    expect(session.playbackState).toBe("none");
  });

  it("publishes offset-adjusted reacquisition completion and paused seeks", async () => {
    const { player, audio, session } = setup();
    await player.play({
      metadata: { title: "Stream", duration: 300 },
      position: 200,
      getSource: async ({ position }) => ({
        url: "blob:stream",
        offset: position - 10,
        seekMode: "buffered",
        release() {},
      }),
    });
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 300,
      position: 200,
      playbackRate: 1,
    });
    player.pause();
    audio.duration = 5;
    await player.seek(250);
    expect(audio.currentTime).toBe(5);
    expect(player.position).toBe(245);
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 300,
      position: 245,
      playbackRate: 1,
    });
  });

  it("isolates missing or throwing optional position and playback APIs", async () => {
    const { play, player, session } = setup();
    session.setPositionState.mockImplementation(() => {
      throw new Error("Unsupported");
    });
    await play({ title: "Song", duration: 100 });
    expect(session.playbackState).toBe("playing");
    player.pause();
    expect(session.playbackState).toBe("paused");
    Object.defineProperty(session, "setPositionState", { value: undefined });
    Object.defineProperty(session, "playbackState", {
      set() {
        throw new Error("Unsupported");
      },
    });
    await play({ title: "Next" });
    expect(player.playing).toBe(true);
    expect(session.metadata).toMatchObject({ title: "Next" });
    player.unload();
    expect(session.metadata).toBeNull();
  });

  it("clears unavailable position and sanitizes invalid values", async () => {
    const { play, session, audio } = setup();
    await play({ title: "Song", duration: Infinity });
    expect(session.setPositionState).toHaveBeenLastCalledWith(undefined);
    audio.duration = 100;
    audio.currentTime = 200;
    audio.playbackRate = 0;
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 100,
      playbackRate: 1,
    });
  });

  it("freezes errors at actual time and ignores events after destruction", async () => {
    const { play, audio, session, destroy } = setup();
    await play({ title: "Song", duration: 100 });
    audio.currentTime = 29;
    audio.dispatchEvent(new Event("error"));
    expect(session.playbackState).toBe("paused");
    expect(session.metadata).toMatchObject({ title: "Song" });
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 29,
      playbackRate: 1,
    });
    await destroy();
    expect(session.setPositionState).toHaveBeenLastCalledWith(undefined);
    session.setPositionState.mockClear();
    for (const event of [
      "timeupdate",
      "playing",
      "waiting",
      "stalled",
      "seeking",
      "seeked",
      "ratechange",
      "loadedmetadata",
    ]) {
      audio.dispatchEvent(new Event(event));
    }
    expect(session.setPositionState).not.toHaveBeenCalled();
    expect(session.playbackState).toBe("none");
  });

  it("does not restore a timeline when a synchronous state callback unloads", async () => {
    const { play, player, audio, session, onstatechange } = setup();
    await play({ title: "Song", duration: 100 });
    onstatechange.mockImplementation(({ status }) => {
      if (status === "buffering") player.unload();
    });
    audio.currentTime = 50;
    audio.dispatchEvent(new Event("waiting"));
    expect(session.playbackState).toBe("none");
    expect(session.metadata).toBeNull();
    expect(session.setPositionState).toHaveBeenLastCalledWith(undefined);
  });

  it.each([NaN, Infinity, -1, 0])(
    "sanitizes playback rate %s at a fresh boundary",
    async (rate) => {
      const { play, audio, session } = setup();
      await play({ title: "Song", duration: 100 });
      audio.playbackRate = rate;
      audio.currentTime = -5;
      audio.dispatchEvent(new Event("ratechange"));
      expect(session.setPositionState).toHaveBeenLastCalledWith({
        duration: 100,
        position: 0,
        playbackRate: 1,
      });
    },
  );

  it("tolerates unsupported actions and cleans up", async () => {
    const { play, destroy, session, handlers } = setup(true);
    await play({ title: "Song" });
    expect(handlers.has("play")).toBe(true);
    await destroy();
    expect([...handlers.values()].every((handler) => handler === null)).toBe(true);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });

  it("plays normally without Media Session support", async () => {
    const { player, play } = setup(false, false);
    await play({ title: "Song" });
    expect(player.playing).toBe(true);
  });
});

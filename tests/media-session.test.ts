// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Player, { type PlayerTrack } from "../src/player.svelte";

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
  const session = {
    metadata: null,
    playbackState: "none",
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
  Object.defineProperty(audio, "currentSrc", { get: () => audio.src });
  vi.stubGlobal(
    "Audio",
    vi.fn(function () {
      return audio;
    }),
  );
  const onnext = vi.fn();
  const onprevious = vi.fn();
  const player = mount(Player, {
    target: document.createElement("div"),
    props: {
      hasNext: true,
      hasPrevious: true,
      onnext,
      onprevious,
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
  return { player, session, handlers, audio, onnext, onprevious, play, destroy };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

describe("Player Media Session integration", () => {
  it("publishes track metadata and converts local artwork to self-contained bytes", async () => {
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
    await play({ title: "Song", artist: "Artist", album: "Album", artwork: "blob:cover" });
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

  it("clears unavailable position and sanitizes invalid values", async () => {
    const { play, session, audio } = setup();
    await play({ title: "Song", duration: Infinity });
    expect(session.setPositionState).toHaveBeenLastCalledWith(undefined);
    audio.duration = 100;
    audio.currentTime = 200;
    audio.playbackRate = 0;
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("timeupdate"));
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 100,
      playbackRate: 1,
    });
  });

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

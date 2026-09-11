import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerMediaSession } from "../src/media-session";

function setup(unsupported = false) {
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
  const controls = {
    play: vi.fn(),
    pause: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    seek: vi.fn(),
  };
  const player = new PlayerMediaSession(controls, session as unknown as MediaSession);
  return { player, session, handlers, controls };
}

afterEach(() => vi.unstubAllGlobals());

describe("player media session", () => {
  it("publishes track metadata and replaces artwork", async () => {
    const { player, session } = setup();
    const track = { title: "Song", artist: "Artist", album: "Album" };
    const url = URL.createObjectURL(new Blob(["image"], { type: "image/jpeg" }));
    try {
      await player.setMetadata(track, url);
      expect(session.metadata).toMatchObject({
        ...track,
        artwork: [{ src: "data:image/jpeg;base64,aW1hZ2U=" }],
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    player.setMetadata({ ...track, title: "Next song" });
    expect(session.metadata).toMatchObject({ title: "Next song", artwork: [] });
    player.setPlaybackState("playing");
    expect(session.playbackState).toBe("playing");
  });

  it("does not publish stale artwork after a track change or destruction", async () => {
    const { player, session } = setup();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const pending = player.setMetadata(
      { title: "Old", artist: "Artist", album: "Album" },
      "blob:old",
    );
    player.setMetadata({ title: "New", artist: "Artist", album: "Album" });
    resolve(new Response("image", { headers: { "Content-Type": "image/jpeg" } }));
    await pending;
    expect(session.metadata).toMatchObject({ title: "New", artwork: [] });
    const late = player.setMetadata(
      { title: "Late", artist: "Artist", album: "Album" },
      "blob:late",
    );
    player.destroy();
    resolve(new Response("image", { headers: { "Content-Type": "image/jpeg" } }));
    await late;
    expect(session.metadata).toBeNull();
  });

  it("keeps text metadata when artwork cannot be read", async () => {
    const { player, session } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Revoked blob");
      }),
    );
    await expect(
      player.setMetadata({ title: "Song", artist: "Artist", album: "Album" }, "blob:missing"),
    ).resolves.toBeUndefined();
    expect(session.metadata).toMatchObject({ title: "Song", artwork: [] });
  });

  it("routes transport controls and clamps seeking", () => {
    const { player, handlers, controls } = setup();
    for (const [action, name] of [
      ["play", "play"],
      ["pause", "pause"],
      ["nexttrack", "next"],
      ["previoustrack", "previous"],
    ] as const) {
      handlers.get(action)!({ action });
      expect(controls[name]).toHaveBeenCalledOnce();
    }
    player.setPosition(100, 95);
    handlers.get("seekforward")!({ action: "seekforward" });
    expect(controls.seek).toHaveBeenLastCalledWith(100);
    handlers.get("seekbackward")!({ action: "seekbackward", seekOffset: 20 });
    expect(controls.seek).toHaveBeenLastCalledWith(75);
    handlers.get("seekto")!({ action: "seekto", seekTime: -5 });
    expect(controls.seek).toHaveBeenLastCalledWith(0);
  });

  it("clears unavailable position and sanitizes invalid values", () => {
    const { player, session } = setup();
    player.setPosition(Infinity, NaN);
    expect(session.setPositionState).toHaveBeenLastCalledWith(undefined);
    player.setPosition(100, 200, 0);
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      position: 100,
      playbackRate: 1,
    });
  });

  it("tolerates unsupported actions and cleans up", () => {
    const { player, session, handlers } = setup(true);
    expect(handlers.has("play")).toBe(true);
    player.destroy();
    expect([...handlers.values()].every((handler) => handler === null)).toBe(true);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });
});

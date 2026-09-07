import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueEngine } from "./queue-engine";
import { SubsonicClient } from "./subsonic-client";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

function response(data: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("queue engine", () => {
  it("restores ordered track IDs without consulting metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          playQueue: {
            current: "track-1",
            position: 2500,
            entry: [
              { id: "missing", title: "Missing" },
              { id: "local", title: "Old title" },
              { id: "track-1", title: "Track" },
            ],
          },
        }),
      ),
    );
    const engine = new QueueEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(engine.tracks).toEqual(["missing", "local", "track-1"]);
    expect(engine.current).toBe("track-1");
    expect(engine.position).toBe(2.5);
    expect(engine.error).toBeUndefined();
    engine.destroy();
  });

  it.each([{ entries: [] }, { entries: [{ id: "local", title: "Local" }] }])(
    "clears a missing remote selection and its position",
    async ({ entries }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          response({
            playQueue: {
              current: "missing",
              position: 9000,
              entry: entries,
            },
          }),
        ),
      );
      const engine = new QueueEngine();
      engine.setClient(new SubsonicClient(auth));
      await vi.waitFor(() => expect(engine.status).toBe("ready"));
      expect(engine.tracks).toEqual(entries.map((track) => track.id));
      expect(engine.current).toBeUndefined();
      expect(engine.position).toBe(0);
      expect(engine.error).toBeUndefined();
      engine.destroy();
    },
  );

  it("stores opaque track IDs independently of the library", () => {
    const engine = new QueueEngine();
    engine.update({ tracks: ["missing", "local", "track-1"], current: "local", position: 5 });
    expect(engine.tracks).toEqual(["missing", "local", "track-1"]);
    expect(engine.current).toBe("local");
    expect(engine.position).toBe(5);
    engine.destroy();
  });

  it("notifies explicit subscribers without UI subscriptions and supports cleanup", () => {
    const engine = new QueueEngine();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    engine.update({ tracks: [], position: 1 });
    expect(listener).toHaveBeenCalledOnce();
    engine.setPosition(2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    engine.setPosition(3);
    expect(listener).toHaveBeenCalledTimes(2);
    engine.destroy();
  });

  it("does not overwrite local playback selection with a late queue restore", async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const engine = new QueueEngine();
    engine.setClient(new SubsonicClient(auth));
    engine.update({
      tracks: ["local"],
      current: "local",
      position: 0,
    });
    resolve(
      response({ playQueue: { current: "remote", entry: [{ id: "remote", title: "Remote" }] } }),
    );
    await new Promise((done) => setTimeout(done, 10));
    expect(engine.current).toBe("local");
    engine.destroy();
  });
  it("publishes the remote queue as reactive engine state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          playQueue: {
            current: "track-1",
            position: 1200,
            entry: [{ id: "track-1", title: "Track", album: "Album", artist: "Artist" }],
          },
        }),
      ),
    );
    const engine = new QueueEngine();

    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));

    expect(engine.current).toBe("track-1");
    expect(engine.position).toBe(1.2);
    expect(engine.tracks).toEqual(["track-1"]);
    engine.destroy();
  });

  it("debounces queue and player-state synchronization", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ playQueue: {} }))
      .mockResolvedValue(response());
    vi.stubGlobal("fetch", fetcher);
    const engine = new QueueEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.runAllTimersAsync();

    engine.update({
      current: "track-1",
      position: 2.5,
      tracks: ["track-1"],
    });
    engine.update({
      current: "track-1",
      position: 3,
      tracks: ["track-1"],
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const options = fetcher.mock.calls[1][1] as RequestInit;
    expect(String(options.body)).toContain("id=track-1");
    expect(String(options.body)).toContain("current=track-1");
    expect(String(options.body)).toContain("position=3000");
  });

  it("does not load or save while offline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new QueueEngine();

    engine.setNetwork("offline");
    engine.setClient(new SubsonicClient(auth));
    engine.update({ tracks: [], position: 0 });
    engine.flush();
    await vi.runAllTimersAsync();

    expect(fetcher).not.toHaveBeenCalled();
    expect(engine.status).toBe("idle");
  });
});

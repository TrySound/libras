import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("subsonic client", () => {
  it("adds authentication and validates metadata responses", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
      response({ artists: { index: [{ artist: [{ id: "artist-1", name: "Artist" }] }] } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new SubsonicClient(auth);

    await expect(client.getArtists()).resolves.toEqual([{ id: "artist-1", name: "Artist" }]);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/rest/getArtists.view");
    expect(url.searchParams.get("u")).toBe(auth.username);
    expect(url.searchParams.get("c")).toBe("music-web");
  });

  it("rejects malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ artists: { index: "invalid" } })),
    );
    const client = new SubsonicClient(auth);

    await expect(client.getArtists()).rejects.toThrow("invalid Subsonic response");
  });

  it("builds authenticated media URLs", () => {
    const client = new SubsonicClient(auth);

    const cover = new URL(client.getCoverArtUrl("cover-1", 500));
    const stream = new URL(
      client.getStreamUrl("track-1", { format: "mp3", estimateContentLength: true }),
    );

    expect(cover.pathname).toBe("/rest/getCoverArt.view");
    expect(cover.searchParams.get("size")).toBe("500");
    expect(stream.searchParams.get("format")).toBe("mp3");
    expect(stream.searchParams.get("estimateContentLength")).toBe("true");
  });

  it("normalizes and saves play queues", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          playQueue: {
            current: "track-1",
            position: 1500,
            entry: [{ id: "track-1", title: "Track" }],
          },
        }),
      )
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const client = new SubsonicClient(auth);

    await expect(client.getPlayQueue()).resolves.toEqual({
      current: "track-1",
      position: 1.5,
      tracks: ["track-1"],
    });
    await client.savePlayQueue({
      current: "track-1",
      position: 2,
      tracks: ["track-1"],
    });

    const options = fetcher.mock.calls[1][1] as RequestInit;
    expect(String(options.body)).toContain("id=track-1");
    expect(String(options.body)).toContain("position=2000");
  });
});

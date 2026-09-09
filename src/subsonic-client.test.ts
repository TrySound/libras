import { afterEach, describe, expect, it, vi } from "vitest";
import { SubsonicClient, createSubsonicAuth } from "./subsonic-client";
import { md5 } from "js-md5";

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
  it("creates salted token credentials without retaining or altering the password", () => {
    const input = { host: auth.host, username: auth.username, password: " secret 音 " };
    const first = createSubsonicAuth(input);
    const second = createSubsonicAuth(input);
    expect(first).toEqual({
      host: input.host,
      username: input.username,
      salt: expect.stringMatching(/^[a-f0-9]{24}$/),
      token: md5(input.password + first.salt),
    });
    expect(second.salt).not.toBe(first.salt);
    expect(second.token).toBe(md5(input.password + second.salt));
    expect(input.password).toBe(" secret 音 ");
  });

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
    expect(url.searchParams.get("c")).toBe("libras");
  });

  it("aborts pending requests and refuses late responses or further requests", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new SubsonicClient(auth);
    const pending = client.getArtists();
    client.abort();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    resolve(response({ artists: { index: [] } }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.getArtists()).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.savePlayQueue({ tracks: [], position: 0 })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).toHaveBeenCalledOnce();
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
      client.getStreamUrl("track-1", {
        format: "mp3",
        estimateContentLength: true,
        timeOffset: 120,
      }),
    );

    expect(cover.pathname).toBe("/rest/getCoverArt.view");
    expect(cover.searchParams.get("size")).toBe("500");
    expect(stream.searchParams.get("format")).toBe("mp3");
    expect(stream.searchParams.get("estimateContentLength")).toBe("true");
    expect(stream.searchParams.get("timeOffset")).toBe("120");
    expect(new URL(client.getStreamUrl("track-1")).searchParams.has("timeOffset")).toBe(false);
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

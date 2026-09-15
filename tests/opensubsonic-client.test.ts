import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSubsonicClient, createOpenSubsonicAuth } from "../src/opensubsonic-client";
import { md5 } from "js-md5";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

const page = {
  artistCount: 500,
  artistOffset: 0,
  albumCount: 500,
  albumOffset: 0,
  songCount: 500,
  songOffset: 0,
};

function response(data: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        type: "TestServer",
        serverVersion: "1.0.0",
        openSubsonic: true,
        ...data,
      },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenSubsonic client", () => {
  it("discovers OpenSubsonic server identity without changing the wire protocol", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => response());
    const client = new OpenSubsonicClient(auth, { fetch: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.ping()).resolves.toEqual({
      version: "1.16.1",
      type: "TestServer",
      serverVersion: "1.0.0",
      openSubsonic: true,
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/rest/ping.view");
    expect(url.searchParams.get("v")).toBe("1.16.1");
    expect(url.searchParams.get("t")).toBe(auth.token);
  });

  it.each([
    { openSubsonic: false },
    { openSubsonic: undefined },
    { type: undefined },
    { serverVersion: undefined },
  ])("rejects incomplete or non-OpenSubsonic identity: %j", async (data) => {
    const client = new OpenSubsonicClient(auth, { fetch: async () => response(data) });
    await expect(client.ping()).rejects.toThrow("valid OpenSubsonic identity");
  });

  it.each([
    { extensions: [] },
    {
      extensions: [
        { name: "indexBasedQueue", versions: [1] },
        { name: "futureExtension", versions: [1, 2] },
      ],
    },
  ])("retains advertised extension names and versions: %j", async ({ extensions }) => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
      response({ openSubsonicExtensions: extensions }),
    );
    const client = new OpenSubsonicClient(auth, { fetch: fetcher });
    await expect(client.getOpenSubsonicExtensions()).resolves.toEqual(extensions);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(
      "/rest/getOpenSubsonicExtensions.view",
    );
  });

  it.each([
    { extensions: undefined },
    { extensions: {} },
    { extensions: [{ name: "formPost", versions: "1" }] },
    { extensions: [{ name: "formPost", versions: [0] }] },
  ])("rejects malformed extension discovery: %j", async ({ extensions }) => {
    const client = new OpenSubsonicClient(auth, {
      fetch: async () => response({ openSubsonicExtensions: extensions }),
    });
    await expect(client.getOpenSubsonicExtensions()).rejects.toThrow("invalid OpenSubsonic");
  });

  it("preserves server errors rather than treating failed discovery as no extensions", async () => {
    const client = new OpenSubsonicClient(auth, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "failed",
              error: { code: 40, message: "Wrong credentials" },
            },
          }),
        ),
    });
    await expect(client.ping()).rejects.toThrow("Wrong credentials");
    await expect(client.getOpenSubsonicExtensions()).rejects.toThrow("Wrong credentials");
  });

  it("rejects discovery after cancellation", async () => {
    const fetcher = vi.fn();
    const client = new OpenSubsonicClient(auth, { fetch: fetcher });
    client.abort();
    await expect(client.ping()).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.getOpenSubsonicExtensions()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates salted token credentials without retaining or altering the password", () => {
    const input = { host: auth.host, username: auth.username, password: " secret 音 " };
    const first = createOpenSubsonicAuth(input);
    const second = createOpenSubsonicAuth(input);
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
      response({ searchResult3: { artist: [{ id: "artist-1", name: "Artist" }] } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new OpenSubsonicClient(auth);

    await expect(client.search3(page)).resolves.toEqual({
      artists: [{ id: "artist-1", name: "Artist" }],
      albums: [],
      tracks: [],
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/rest/search3.view");
    expect(url.searchParams.get("query")).toBe("");
    for (const [key, value] of Object.entries(page))
      expect(url.searchParams.get(key)).toBe(String(value));
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
    const client = new OpenSubsonicClient(auth);
    const pending = client.search3(page);
    client.abort();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    resolve(response({ searchResult3: {} }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.search3(page)).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.savePlayQueue({ tracks: [], position: 0 })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ searchResult3: { artist: "invalid" } })),
    );
    const client = new OpenSubsonicClient(auth);

    await expect(client.search3(page)).rejects.toThrow("invalid OpenSubsonic response");
  });

  it("builds authenticated media URLs", () => {
    const client = new OpenSubsonicClient(auth);

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
    const client = new OpenSubsonicClient(auth);

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

import { describe, expect, it, vi } from "vitest";
import { Network, NetworkTransportError } from "./network.svelte";

const auth = {
  host: "https://music.example",
  username: "listener",
  token: "token",
  salt: "salt",
};

describe("Network connection lifecycle", () => {
  it.each(["modified", "library", "queueRead", "queueWrite", "artwork", "audio"] as const)(
    "classifies rejected %s fetches at the transport boundary",
    async (operation) => {
      const network = new Network();
      const connection = network.prepare(auth);
      network.accept(connection);
      const cause = new TypeError("Failed to fetch");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw cause;
        }),
      );
      const signal = new AbortController().signal;
      const operations = {
        modified: () => network.metadata(connection).getModifiedAt(),
        library: () => network.metadata(connection).readLibrary(signal),
        queueRead: () => network.queue(connection).read(),
        queueWrite: () => network.queue(connection).write({ trackIds: [], position: 0 }),
        artwork: () => network.artwork(connection).read("cover", { size: 500 }),
        audio: () => network.audio(connection).read("track", { format: "raw", signal }),
      };
      try {
        const result = operations[operation]();
        await expect(result).rejects.toBeInstanceOf(NetworkTransportError);
        await expect(result).rejects.toMatchObject({ cause });
        expect(network.mode).toBe("online");
        expect(connection.signal.aborted).toBe(false);
      } finally {
        network.setMode("offline");
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["http", "protocol", "json", "body"])(
    "does not misclassify %s errors as failed fetches",
    async (kind) => {
      const network = new Network();
      const connection = network.prepare(auth);
      let response: Response;
      if (kind === "http") response = new Response(null, { status: 503 });
      else if (kind === "protocol")
        response = new Response(
          JSON.stringify({
            "subsonic-response": { status: "failed", error: { message: "Denied" } },
          }),
        );
      else response = new Response("not JSON");
      const bodyError = new TypeError("Body already consumed");
      if (kind === "body") vi.spyOn(response, "json").mockRejectedValue(bodyError);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      try {
        const result = network.metadata(connection).getModifiedAt();
        await expect(result).rejects.not.toBeInstanceOf(NetworkTransportError);
        if (kind === "http") await expect(result).rejects.toThrow("HTTP 503");
        if (kind === "protocol") await expect(result).rejects.toThrow("Denied");
        if (kind === "json") await expect(result).rejects.toBeInstanceOf(SyntaxError);
        if (kind === "body") await expect(result).rejects.toBe(bodyError);
      } finally {
        network.setMode("offline");
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    },
  );

  it.each(["signal", "exception"])(
    "preserves cancellation reported by %s rather than wrapping it",
    async (kind) => {
      const network = new Network();
      const connection = network.prepare(auth);
      const cancelled = new DOMException("Cancelled", "AbortError");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (kind === "signal") {
            network.setMode("offline");
            throw new TypeError("Fetch failed after abort");
          }
          throw cancelled;
        }),
      );
      try {
        const result = network.metadata(connection).getModifiedAt();
        await expect(result).rejects.toBe(
          kind === "exception" ? cancelled : connection.signal.reason,
        );
      } finally {
        network.setMode("offline");
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    [" music.example/ ", "https://music.example"],
    ["http://music.example:4533/music/", "http://music.example:4533/music"],
    ["https://music.example/music/", "https://music.example/music"],
  ])("prepares credentials for %s without enabling access or fetching", (host, normalized) => {
    const network = new Network();
    const candidate = network.prepare(auth);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const credentials = network.createAuth({ host, username: "listener", password: "secret" });
      expect(credentials).toEqual({
        host: normalized,
        username: "listener",
        salt: expect.stringMatching(/^[a-f0-9]{24}$/),
        token: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(network.mode).toBe("offline");
      expect(candidate.signal.aborted).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      network.accept(candidate);
      network.createAuth({ host, username: "other", password: "secret" });
      expect(candidate.signal.aborted).toBe(false);
      expect(network.mode).toBe("online");
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it("rejects invalid credential input before starting a connection", () => {
    const network = new Network();
    expect(() =>
      network.createAuth({ host: "https://", username: "listener", password: "secret" }),
    ).toThrow();
    expect(() =>
      network.createAuth({ host: auth.host, username: "", password: "secret" }),
    ).toThrow();
    expect(network.mode).toBe("offline");
  });

  it("starts offline and refuses normal access until explicitly enabled", () => {
    const network = new Network();
    expect(network.mode).toBe("offline");
    expect(() => network.open(auth)).toThrow("Network access is offline");
    network.setMode("online");
    const client = network.open(auth);
    expect(client.signal.aborted).toBe(false);
    network.setMode("offline");
    expect(client.signal.aborted).toBe(true);
    expect(() => network.audio(client)).toThrowError(/abort/i);
  });

  it("allows isolated login preparation while offline, enabling access only on acceptance", () => {
    const network = new Network();
    const candidate = network.prepare(auth);
    expect(network.mode).toBe("offline");
    expect(candidate.signal.aborted).toBe(false);
    expect(() => network.open(auth)).toThrow("Network access is offline");
    network.accept(candidate);
    expect(network.mode).toBe("online");
    network.setMode("offline");
    expect(candidate.signal.aborted).toBe(true);
  });

  it("replaces candidates without disturbing the active connection until acceptance", () => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(auth);
    const stale = network.prepare({ ...auth, username: "second" });
    const candidate = network.prepare({ ...auth, username: "third" });
    expect(stale.signal.aborted).toBe(true);
    expect(active.signal.aborted).toBe(false);
    expect(() => network.accept(stale)).toThrowError(/abort/i);
    network.accept(candidate);
    expect(active.signal.aborted).toBe(true);
    expect(candidate.signal.aborted).toBe(false);
    network.setMode("offline");
  });

  it("rejects a candidate owned by another Network", () => {
    const network = new Network();
    const other = new Network();
    const candidate = other.prepare(auth);
    expect(() => network.accept(candidate)).toThrow("Connection superseded");
    expect(network.mode).toBe("offline");
    expect(candidate.signal.aborted).toBe(false);
    other.setMode("offline");
  });

  it("exposes only frozen, credential-free connection identity", () => {
    const network = new Network();
    const connection = network.prepare(auth);
    expect(Object.keys(connection).sort()).toEqual(["account", "signal"]);
    expect(connection.account).toEqual({ host: auth.host, username: auth.username });
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(connection.account)).toBe(true);
    expect(network.metadata(connection).account).toBe(connection.account);
    network.accept(connection);
    for (const feature of ["queue", "artwork", "audio"] as const) {
      expect(network[feature](connection).account).toBe(connection.account);
      expect(network[feature](connection).signal).toBe(connection.signal);
    }
    network.setMode("offline");
  });

  it("rejects foreign and copied handles without disturbing its active connection or candidate", () => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(auth);
    const candidate = network.prepare(auth);
    const other = new Network();
    const foreign = other.prepare(auth);
    for (const connection of [foreign, { ...candidate }, network.metadata(candidate)]) {
      expect(() => network.accept(connection)).toThrow("Connection superseded");
      for (const feature of ["metadata", "queue", "artwork", "audio"] as const) {
        expect(() => network[feature](connection)).toThrow("Connection superseded");
      }
    }
    expect(active.signal.aborted).toBe(false);
    expect(candidate.signal.aborted).toBe(false);
    expect(foreign.signal.aborted).toBe(false);
    expect(() => network.accept(active)).toThrow("Connection superseded");
    network.accept(candidate);
    expect(active.signal.aborted).toBe(true);
    network.setMode("offline");
    other.setMode("offline");
  });

  it("aborts active and candidate work offline and never revives old connections", () => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(auth);
    const candidate = network.prepare(auth);
    network.setMode("offline");
    network.setMode("offline");
    expect(active.signal.aborted).toBe(true);
    expect(candidate.signal.aborted).toBe(true);
    expect(() => network.accept(candidate)).toThrowError(/abort/i);
    network.setMode("online");
    const resumed = network.open(auth);
    expect(resumed).not.toBe(active);
    expect(resumed).not.toBe(candidate);
    expect(resumed.signal.aborted).toBe(false);
    expect(active.signal.aborted).toBe(true);
    network.setMode("offline");
  });

  it("keeps metadata bound to its candidate through acceptance and rejects it after replacement", async () => {
    const network = new Network();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            "subsonic-response": { status: "ok", artists: { index: [] } },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const candidate = network.prepare(auth);
      const metadata = network.metadata(candidate);
      expect(metadata.account).toEqual({ host: auth.host, username: auth.username });
      expect(network.mode).toBe("offline");
      await expect(metadata.readLibrary(new AbortController().signal)).resolves.toEqual({
        artists: [],
        albums: [],
        tracksByAlbum: new Map(),
      });
      network.accept(candidate);
      await expect(metadata.readLibrary(new AbortController().signal)).resolves.toEqual({
        artists: [],
        albums: [],
        tracksByAlbum: new Map(),
      });
      const replacement = network.prepare({ ...auth, username: "other" });
      await expect(metadata.readLibrary(new AbortController().signal)).resolves.toEqual({
        artists: [],
        albums: [],
        tracksByAlbum: new Map(),
      });
      network.accept(replacement);
      const requests = fetch.mock.calls.length;
      await expect(metadata.readLibrary(new AbortController().signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(() => network.metadata(candidate)).toThrowError(/abort/i);
      expect(network.metadata(replacement).account.username).toBe("other");
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it("cancels sibling library requests on failure without closing the connection", async () => {
    const network = new Network();
    const candidate = network.prepare(auth);
    const metadata = network.metadata(candidate);
    const aborted = vi.fn();
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input));
      const reply = (data: object) =>
        new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
      if (url.pathname.endsWith("getArtists.view")) return reply({ artists: { index: [] } });
      if (url.pathname.endsWith("getAlbumList2.view"))
        return reply({
          albumList2: {
            album: Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: String(i) })),
          },
        });
      if (url.pathname.endsWith("getIndexes.view")) return reply({ indexes: { lastModified: 20 } });
      const id = url.searchParams.get("id")!;
      requested.push(id);
      if (id === "0") return new Response(null, { status: 500 });
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => {
            aborted();
            reject(options!.signal!.reason);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(metadata.readLibrary(new AbortController().signal)).rejects.toThrow("HTTP 500");
      expect(requested).toEqual(["0", "1", "2", "3", "4", "5"]);
      expect(aborted).toHaveBeenCalledTimes(5);
      expect(candidate.signal.aborted).toBe(false);
      await expect(metadata.getModifiedAt()).resolves.toBe(20);
      const cancelled = new AbortController();
      cancelled.abort();
      const calls = fetcher.mock.calls.length;
      await expect(metadata.readLibrary(cancelled.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetcher).toHaveBeenCalledTimes(calls);
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it("does not expose remote queue access for an unaccepted login candidate", () => {
    const network = new Network();
    const candidate = network.prepare(auth);
    expect(() => network.queue(candidate)).toThrow("Connection superseded");
    network.accept(candidate);
    expect(network.queue(candidate).account.username).toBe(auth.username);
    network.setMode("offline");
    expect(() => network.queue(candidate)).toThrowError(/abort/i);
  });

  it("maps queue IDs and seconds while preserving SDK POST and cancellation semantics", async () => {
    const network = new Network();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              playQueue: {
                current: "a",
                position: 3500,
                entry: [{ id: "a" }, { id: "b" }, { id: "a" }],
              },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const client = network.prepare(auth);
      network.accept(client);
      const queue = network.queue(client);
      const state = { trackIds: ["a", "b", "a"], currentTrackId: "a", position: 3.5 };
      await expect(queue.read()).resolves.toEqual(state);
      await queue.write(state);
      expect(fetch.mock.calls[1]).toEqual([
        expect.stringContaining("savePlayQueue"),
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: expect.any(URLSearchParams),
          keepalive: true,
          signal: client.signal,
        },
      ]);
      const [, options] = vi.mocked(globalThis.fetch).mock.calls[1];
      const body = options!.body as URLSearchParams;
      expect(body.getAll("id")).toEqual(["a", "b", "a"]);
      expect(body.get("current")).toBe("a");
      expect(body.get("position")).toBe("3500");
      const replacement = network.prepare({ ...auth, username: "other" });
      network.accept(replacement);
      await expect(queue.read()).rejects.toMatchObject({ name: "AbortError" });
      await expect(queue.write(state)).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it("binds artwork URLs to an accepted connection and revokes them on replacement", () => {
    const network = new Network();
    const client = network.prepare(auth);
    expect(() => network.artwork(client)).toThrow("Connection superseded");
    network.accept(client);
    const artwork = network.artwork(client);
    const url = new URL(artwork.url("cover", 500));
    expect(url.origin).toBe(auth.host);
    expect(url.pathname).toContain("getCoverArt");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      id: "cover",
      size: "500",
      u: auth.username,
      t: auth.token,
      s: auth.salt,
    });
    const replacement = network.prepare({ ...auth, host: "https://other.example" });
    expect(artwork.url("cover", 500)).toBe(url.href);
    network.accept(replacement);
    expect(() => artwork.url("cover", 500)).toThrowError(/abort/i);
    const next = network.artwork(replacement);
    expect(new URL(next.url("cover", 500)).origin).toBe("https://other.example");
    network.setMode("offline");
    expect(() => next.url("cover", 500)).toThrowError(/abort/i);
  });

  it("normalizes artwork replies and sends conditional validators", async () => {
    const network = new Network();
    const client = network.prepare(auth);
    network.accept(client);
    const fetcher = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response("image", {
          headers: {
            "Content-Type": "image/png; charset=binary",
            ETag: '"new"',
            "Last-Modified": "yesterday",
          },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const artwork = network.artwork(client);
      const options = { size: 500, etag: '"old"', lastModified: "earlier" };
      const result = await artwork.read("cover", options);
      expect(result).toMatchObject({ type: "image/png", etag: '"new"', lastModified: "yesterday" });
      expect(await result!.blob.text()).toBe("image");
      const init = fetcher.mock.calls[0][1]!;
      expect(init.signal).toBe(client.signal);
      expect(new Headers(init.headers).get("If-None-Match")).toBe('"old"');
      expect(new Headers(init.headers).get("If-Modified-Since")).toBe("earlier");
      fetcher.mockResolvedValue(new Response(null, { status: 304 }));
      await expect(artwork.read("cover", options)).resolves.toBeNull();
      await expect(artwork.read("cover", { size: 500 })).rejects.toThrow("HTTP 304");
      fetcher.mockResolvedValue(new Response(null, { status: 404 }));
      await expect(artwork.read("cover", options)).rejects.toThrow("HTTP 404");
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it("rejects image bytes arriving after disconnect and prevents stale artwork fetches", async () => {
    const network = new Network();
    const client = network.prepare(auth);
    network.accept(client);
    let resolve!: (blob: Blob) => void;
    const response = new Response("image");
    const body = vi.spyOn(response, "blob").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    try {
      const artwork = network.artwork(client);
      const pending = artwork.read("cover", { size: 500 });
      await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
      network.setMode("offline");
      resolve(new Blob(["late image"]));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(artwork.read("cover", { size: 500 })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("exposes accepted audio URLs and hands off an unbuffered download response", async () => {
    const network = new Network();
    const client = network.prepare(auth);
    expect(() => network.audio(client)).toThrow("Connection superseded");
    network.accept(client);
    const audio = network.audio(client);
    const url = new URL(audio.url("track", { format: "mp3", position: 42 }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      id: "track",
      format: "mp3",
      timeOffset: "42",
      estimateContentLength: "true",
      u: auth.username,
    });
    const response = new Response("audio");
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => response);
    vi.stubGlobal("fetch", fetcher);
    try {
      const controller = new AbortController();
      expect(await audio.read("track", { format: "raw", signal: controller.signal })).toBe(
        response,
      );
      expect(response.bodyUsed).toBe(false);
      const downloadUrl = new URL(String(fetcher.mock.calls[0][0]));
      expect(downloadUrl.searchParams.get("format")).toBe("raw");
      expect(downloadUrl.searchParams.has("timeOffset")).toBe(false);
      expect(await response.text()).toBe("audio");
      const next = network.prepare({ ...auth, username: "other" });
      network.accept(next);
      expect(() => audio.url("track", { format: "raw" })).toThrowError(/abort/i);
      await expect(
        audio.read("track", { format: "raw", signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it.each(["job", "connection", "http"])(
    "releases unused audio responses on %s failure",
    async (failure) => {
      const network = new Network();
      const client = network.prepare(auth);
      network.accept(client);
      const controller = new AbortController();
      let resolve!: (response: Response) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      try {
        const pending = network
          .audio(client)
          .read("track", { format: "mp3", signal: controller.signal });
        if (failure === "job") controller.abort();
        if (failure === "connection") network.setMode("offline");
        const response = new Response("unused", { status: failure === "http" ? 500 : 200 });
        const cancel = vi.spyOn(response.body!, "cancel");
        resolve(response);
        if (failure === "http") await expect(pending).rejects.toThrow("HTTP 500");
        else await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(cancel).toHaveBeenCalledOnce();
      } finally {
        network.setMode("offline");
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    },
  );

  it("rejects a late SDK response after network access is revoked", async () => {
    const network = new Network();
    let respond!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      network.setMode("online");
      const client = network.open(auth);
      const request = network.metadata(client).getModifiedAt();
      const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch.mock.calls[0]).toEqual([expect.any(String), { signal: client.signal }]);
      network.setMode("offline");
      respond(new Response(JSON.stringify({ "subsonic-response": { status: "ok" } })));
      await rejection;
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });
});

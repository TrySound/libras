import { deferred } from "./session-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataEngine } from "./metadata.svelte";
import { Storage, type MetadataSnapshot } from "./storage";
import type { Account } from "./schema";
import { Network } from "./network.svelte";
import { Memory } from "./memory.svelte";

const account = { host: "https://music.example.com", username: "listener" };
function snapshot(): MetadataSnapshot {
  return {
    account,
    lastModified: 10,
    savedAt: 100,
    artists: [{ id: "artist", name: "Artist", genres: [] }],
    albums: [{ id: "album", title: "Album", artistId: "artist", genres: [] }],
    tracks: [{ id: "song", title: "Song", albumId: "album", artistId: "artist", genres: [] }],
  };
}
async function snapshotPath(identity: Account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${identity.host}\n${identity.username}`),
  );
  return `metadata/${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
}
function installMetadataStorage() {
  const storage = {
    files: new Map<string, File>(),
    failWrites: false,
    beforeWrite: undefined as (() => void) | undefined,
    writes: 0,
    async seed(identity: Account, data: unknown) {
      const path = await snapshotPath(identity);
      storage.files.set(path, new File([JSON.stringify(data)], path));
    },
  };
  const getDirectory = vi.fn(async () => ({
    async getDirectoryHandle(directory: string) {
      return {
        async getFileHandle(name: string, options?: { create?: boolean }) {
          const path = `${directory}/${name}`;
          if (!storage.files.has(path) && !options?.create)
            throw new DOMException("Missing", "NotFoundError");
          if (!storage.files.has(path)) storage.files.set(path, new File([], path));
          return {
            async getFile() {
              return storage.files.get(path)!;
            },
            async createWritable() {
              let data = "";
              return {
                async write(value: string) {
                  storage.beforeWrite?.();
                  if (storage.failWrites) throw new Error("Storage full");
                  data = value;
                },
                async close() {
                  storage.writes++;
                  storage.files.set(path, new File([data], path));
                },
                async abort() {},
              };
            },
          };
        },
        async removeEntry(name: string) {
          storage.files.delete(`${directory}/${name}`);
        },
      };
    },
  }));
  vi.stubGlobal("navigator", { storage: { getDirectory } });
  return Object.assign(storage, { getDirectory });
}

const auth = { ...account, token: "token", salt: "salt" };
function createConnection(credentials = auth) {
  const network = new Network();
  const client = network.prepare(credentials);
  network.accept(client);
  const { metadata } = client;
  return {
    account: metadata.account,
    signal: metadata.signal,
    getModifiedAt: (since?: number) => metadata.getModifiedAt(since),
    readLibrary: (signal: AbortSignal) => metadata.readLibrary(signal),
    abort: () => network.setMode("offline"),
  };
}
function response(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}
function serveLibrary(data: { artists?: unknown[]; albums?: unknown[]; tracks?: unknown[] } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("getIndexes")) return response({ indexes: { lastModified: 20 } });
    if (url.includes("getArtists"))
      return response({
        artists: { index: [{ artist: data.artists ?? [{ id: "artist", name: "Artist" }] }] },
      });
    if (url.includes("getAlbumList2"))
      return response({
        albumList2: { album: data.albums ?? [{ id: "album", name: "Album", artistId: "artist" }] },
      });
    if (url.includes("getAlbum.view"))
      return response({
        album: {
          song: data.tracks ?? [
            {
              id: "song",
              title: "Song",
              artistId: "artist",
              albumId: "album",
              track: 1,
              contentType: "audio/flac",
            },
          ],
        },
      });
    throw new Error(`Unexpected request: ${url}`);
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadLibrary(engine: MetadataEngine, client: ReturnType<typeof createConnection>) {
  await engine.restore(new Storage(client.account));
  engine.setConnection(client);
  await engine.refresh(false);
}

describe("metadata engine", () => {
  it.each(["detach", "destroy"])(
    "cancels candidate traversal on %s without publishing",
    async (action) => {
      const memory = new Memory();
      const engine = new MetadataEngine(memory);
      const connection = createConnection(auth);
      vi.spyOn(connection, "getModifiedAt").mockResolvedValue(10);
      const response = deferred();
      const read = vi.spyOn(connection, "readLibrary").mockImplementation(async () => {
        await response.promise;
        return snapshot();
      });
      const pending = engine.prepareConnection(connection);
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      const signal = read.mock.calls[0][0];
      if (action === "detach") engine.setConnection(undefined);
      else engine.destroy();
      expect(signal.aborted).toBe(true);
      response.resolve();
      await rejected;
      expect(memory.tracks.size).toBe(0);
      expect(engine.savedAt).toBeUndefined();
      engine.destroy();
    },
  );

  it("supersedes a candidate before fetching its library", async () => {
    const engine = new MetadataEngine(new Memory());
    const connection = createConnection(auth);
    const timestamp = deferred<number>();
    vi.spyOn(connection, "getModifiedAt")
      .mockResolvedValue(10)
      .mockReturnValueOnce(timestamp.promise);
    const read = vi.spyOn(connection, "readLibrary").mockResolvedValue(snapshot());
    const first = engine.prepareConnection(connection);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const replacement = await engine.prepareConnection(connection);
    timestamp.resolve(10);
    await rejected;
    expect(replacement.account).toEqual(account);
    expect(read).toHaveBeenCalledOnce();
    engine.destroy();
  });

  it("revalidates or forces a refresh directly without a commit protocol", async () => {
    const disk = installMetadataStorage();
    await disk.seed(account, snapshot());
    const memory = new Memory();
    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    const connection = createConnection(auth);
    const modified = vi.spyOn(connection, "getModifiedAt").mockResolvedValue(10);
    const read = vi.spyOn(connection, "readLibrary").mockResolvedValue(snapshot());
    engine.setConnection(connection);
    await engine.refresh(false);
    expect(modified).toHaveBeenCalledWith(10);
    expect(read).not.toHaveBeenCalled();
    expect(disk.writes).toBe(0);
    await engine.refresh();
    expect(read).toHaveBeenCalledOnce();
    expect(disk.writes).toBe(1);

    engine.destroy();
  });

  it("keeps restored data and reports a direct refresh failure to its caller", async () => {
    const disk = installMetadataStorage();
    await disk.seed(account, snapshot());
    const memory = new Memory();
    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    const previous = memory.tracks;
    const connection = createConnection(auth);
    const error = new Error("Server unavailable");
    vi.spyOn(connection, "getModifiedAt").mockRejectedValue(error);
    engine.setConnection(connection);
    await expect(engine.refresh()).rejects.toBe(error);
    expect(memory.tracks).toBe(previous);

    expect(disk.writes).toBe(0);
    engine.destroy();
  });

  it("uses injected storage and publishes the snapshot returned by its write", async () => {
    const disk = installMetadataStorage();
    const stored = snapshot();
    const winner = {
      ...snapshot(),
      savedAt: 500,
      tracks: snapshot().tracks.map((track) => ({ ...track, title: "Stored winner" })),
    };
    const store = {
      account,
      read: vi.fn(async () => stored),
      save: vi.fn(async () => winner),
    };
    const memory = new Memory();
    const storage = { account, metadata: store };
    const engine = new MetadataEngine(memory);
    await engine.restore(storage);
    expect(store.read).toHaveBeenCalledOnce();
    expect(memory.tracks.get("song")?.title).toBe("Song");
    vi.stubGlobal("fetch", serveLibrary());
    engine.setConnection(createConnection(auth));
    await engine.refresh();
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastModified: 20 }),
      expect.any(Function),
    );
    expect(memory.tracks.get("song")?.title).toBe("Stored winner");
    expect(engine.savedAt).toBe(500);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("prepares a foreign connection without replacing offline metadata until acceptance", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const memory = new Memory();
    memory.account = account;
    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    const previous = memory.tracks;
    const network = new Network();
    const client = network.prepare({ ...auth, username: "other" });
    vi.stubGlobal("fetch", serveLibrary());
    const prepared = await engine.prepareConnection(client.metadata);
    expect(network.mode).toBe("offline");
    expect(memory.tracks).toBe(previous);
    expect(memory.account).toEqual(account);
    expect(storage.files.size).toBe(1);
    const nextStorage = new Storage(prepared.account);
    const saved = await engine.saveConnection(prepared, nextStorage, client.signal);
    expect(storage.files.size).toBe(2);
    expect(memory.tracks).toBe(previous);
    network.accept(client);
    memory.account = saved.account;
    engine.acceptConnection(saved, nextStorage);
    engine.setConnection(client.metadata);
    expect(network.mode).toBe("online");
    expect(memory.account).toEqual({ host: auth.host, username: "other" });
    expect(memory.tracks).not.toBe(previous);
    expect(memory.tracks.get("song")?.title).toBe("Song");
    engine.destroy();
  });

  it("does not commit a candidate snapshot after cancellation during its write", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const memory = new Memory();
    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    const client = createConnection(auth);
    storage.beforeWrite = () => client.abort();
    await expect(
      engine.saveConnection({ ...snapshot(), savedAt: 200 }, new Storage(account), client.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.writes).toBe(0);
    expect(JSON.parse(await [...storage.files.values()][0].text())).toEqual(snapshot());
    engine.destroy();
  });

  it.each([false, true])(
    "preserves offline metadata after failed or aborted connection preparation (abort: %s)",
    async (abort) => {
      const storage = installMetadataStorage();
      await storage.seed(account, snapshot());
      const memory = new Memory();
      memory.account = account;
      const engine = new MetadataEngine(memory);
      await engine.restore(new Storage(account));
      const previous = memory.tracks;
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
      const client = createConnection(auth);
      const preparing = engine.prepareConnection(client);
      if (abort) {
        client.abort();
        engine.setConnection(undefined);
      }
      resolve(
        abort
          ? response({ indexes: { lastModified: 20 } })
          : new Response("Unauthorized", { status: 401 }),
      );
      await expect(preparing).rejects.toThrow();
      expect(memory.tracks).toBe(previous);
      expect(memory.account).toEqual(account);
      expect(storage.writes).toBe(0);

      engine.destroy();
    },
  );

  it("configures captured connections without I/O, leaving restoration and refresh explicit", async () => {
    const storage = installMetadataStorage();
    const fetcher = serveLibrary();
    vi.stubGlobal("fetch", fetcher);
    const memory = new Memory();
    const engine = new MetadataEngine(memory);
    engine.setConnection(createConnection(auth));
    engine.setConnection(undefined);
    engine.setConnection(createConnection(auth));
    expect(storage.getDirectory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await engine.restore(new Storage(account));
    expect(fetcher).not.toHaveBeenCalled();
    await engine.refresh(false);

    expect(memory.tracks.get("song")).toBeDefined();
    await engine.refresh();

    fetcher.mockClear();
    engine.setConnection(undefined);
    engine.setConnection(createConnection(auth));
    expect(fetcher).not.toHaveBeenCalled();
    await engine.refresh(false);
    expect(fetcher).toHaveBeenCalled();
    engine.destroy();
  });

  it("cancels detached library traversal without revoking the shared connection", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const memory = new Memory();
    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    const previous = memory.tracks;
    const connection = createConnection(auth);
    engine.setConnection(connection);
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("getIndexes.view"))
        return response({ indexes: { lastModified: 20 } });
      if (url.pathname.endsWith("getArtists.view")) return response({ artists: { index: [] } });
      signal = options?.signal;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const refreshing = engine.refresh();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    engine.setConnection(undefined);
    expect(signal?.aborted).toBe(true);
    expect(connection.signal.aborted).toBe(false);
    resolve(
      response({
        albumList2: {
          album: Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: String(i) })),
        },
      }),
    );
    await refreshing;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(memory.tracks).toBe(previous);
    expect(storage.writes).toBe(0);

    vi.stubGlobal("fetch", serveLibrary());
    engine.setConnection(connection);
    await engine.refresh();
    expect(memory.tracks.get("song")?.title).toBe("Song");
    engine.destroy();
  });

  it("paginates albums through Network while retaining bounded track-fetch concurrency", async () => {
    installMetadataStorage();
    const albums = Array.from({ length: 501 }, (_, index) => ({
      id: `album-${index}`,
      name: `Album ${index}`,
      artistId: "artist",
    }));
    const offsets: number[] = [];
    let active = 0;
    let peak = 0;
    let trackRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("u")).toBe(auth.username);
        if (url.pathname.endsWith("getIndexes.view"))
          return response({ indexes: { lastModified: 20 } });
        if (url.pathname.endsWith("getArtists.view"))
          return response({ artists: { index: [{ artist: [{ id: "artist", name: "Artist" }] }] } });
        if (url.pathname.endsWith("getAlbumList2.view")) {
          expect(url.searchParams.get("type")).toBe("alphabeticalByArtist");
          expect(url.searchParams.get("size")).toBe("500");
          const offset = Number(url.searchParams.get("offset"));
          offsets.push(offset);
          return response({ albumList2: { album: albums.slice(offset, offset + 500) } });
        }
        if (url.pathname.endsWith("getAlbum.view")) {
          trackRequests++;
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active--;
          return response({ album: { song: [] } });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const memory = new Memory();
    const engine = new MetadataEngine(memory);
    await loadLibrary(engine, createConnection(auth));
    expect(offsets).toEqual([0, 500]);
    expect(trackRequests).toBe(501);
    expect(peak).toBe(6);
    expect(memory.albums.size).toBe(501);

    engine.destroy();
  });

  it("normalizes transport data and keeps album and track artists distinct", async () => {
    const storage = installMetadataStorage();
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [
          { id: "artist", name: "Artist", genre: " Rock | jazz ", genres: [{ name: "rock" }] },
          { id: "guest", name: "Guest" },
        ],
        albums: [{ id: "album", name: "Album", artistId: "artist", coverArt: "cover", year: 2024 }],
        tracks: [
          {
            id: "second",
            title: "Second",
            artistId: "guest",
            artist: "Guest",
            albumId: "album",
            track: 2,
            discNumber: 1,
            contentType: "audio/flac",
            duration: 120,
          },
          { id: "first", title: "First", track: 1 },
        ],
      }),
    );
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await loadLibrary(engine, createConnection(auth));
    expect(engineMemory.albums.get("album")).toEqual({
      id: "album",
      title: "Album",
      artistId: "artist",
      artworkId: "cover",
      year: 2024,
      genres: [],
    });
    expect(engineMemory.tracks.get("second")).toMatchObject({
      artistId: "guest",
      albumId: "album",
      number: 2,
      disc: 1,
      mimeType: "audio/flac",
      duration: 120,
    });
    expect(engineMemory.tracks.get("first")?.artistId).toBe("artist");
    expect(engineMemory.artists.get("artist")?.genres.map((genre) => genre.toLowerCase())).toEqual([
      "jazz",
      "rock",
    ]);
    expect((engineMemory.artistAlbums.get("artist") ?? []).map((album) => album.id)).toEqual([
      "album",
    ]);
    expect(engineMemory.artistAlbums.get("guest") ?? []).toEqual([]);
    expect((engineMemory.albumTracks.get("album") ?? []).map((track) => track.id)).toEqual([
      "first",
      "second",
    ]);
    expect(engineMemory.albumTracks.get("missing") ?? []).toEqual([]);
    const persisted = JSON.parse(await storage.files.get(await snapshotPath(account))!.text());
    expect(persisted.artists[0]).not.toHaveProperty("albums");
    expect(persisted.albums[0]).not.toHaveProperty("tracks");
    expect(JSON.stringify(persisted)).not.toMatch(/contentType|coverArt|discNumber/);
    engine.destroy();
  });

  it("restores sorted stable indexes without changing stored entity order", async () => {
    const storage = installMetadataStorage();
    const data = snapshot();
    data.artists = [
      { id: "b", name: "Beta", genres: [] },
      { id: "a", name: "Alpha", genres: [] },
    ];
    data.albums = [
      { id: "later", artistId: "a", title: "Later", year: 2020, genres: [] },
      { id: "earlier", artistId: "a", title: "Earlier", year: 2000, genres: [] },
    ];
    data.tracks = [
      { id: "second", albumId: "earlier", artistId: "a", title: "Second", number: 2, genres: [] },
      { id: "first", albumId: "earlier", artistId: "a", title: "First", number: 1, genres: [] },
    ];
    await storage.seed(account, data);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    expect([...engineMemory.artists.values()].map((item) => item.id)).toEqual(["a", "b"]);
    expect((engineMemory.artistAlbums.get("a") ?? []).map((item) => item.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect((engineMemory.albumTracks.get("earlier") ?? []).map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);

    expect(engineMemory.albumTracks.get("earlier") ?? []).toBe(
      engineMemory.albumTracks.get("earlier") ?? [],
    );
    expect(engineMemory.artistAlbums.get("missing")).toBeUndefined();
    expect(engineMemory.albumTracks.get("missing")).toBeUndefined();
    expect((engineMemory.albumTracks.get("earlier") ?? [])[0]).toBe(
      engineMemory.tracks.get("first"),
    );
    expect(JSON.parse(await storage.files.get(await snapshotPath(account))!.text())).toEqual(data);
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("creates stable IDs for artists missing server IDs", async () => {
    installMetadataStorage();
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [{ name: "Artist" }],
        albums: [{ id: "album", name: "Album", artist: "Artist" }],
        tracks: [{ id: "song", title: "Song", artist: "Guest" }],
      }),
    );
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await loadLibrary(engine, createConnection(auth));
    const ids = [...engineMemory.artists.values()].map((artist) => artist.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(engineMemory.albums.get("album")?.artistId);
    expect(ids).toContain(engineMemory.tracks.get("song")?.artistId);
    await engine.refresh();
    expect([...engineMemory.artists.values()].map((artist) => artist.id)).toEqual(ids);
    engine.destroy();
  });

  it.each(["artists", "albums", "tracks"] as const)(
    "rejects duplicate IDs in persisted %s",
    async (collection) => {
      const storage = installMetadataStorage();
      const data = snapshot();
      await storage.seed(account, {
        ...data,
        [collection]: [...data[collection], data[collection][0]],
      });
      const engineMemory = new Memory();
      const engine = new MetadataEngine(engineMemory);
      await expect(engine.restore(new Storage(account))).rejects.toBeInstanceOf(Error);
      expect([...engineMemory.artists.values()]).toEqual([]);
      engine.destroy();
    },
  );

  it("rejects a persisted snapshot belonging to another account", async () => {
    const storage = installMetadataStorage();
    const data = snapshot();
    data.account = { ...account, username: "other" };
    await storage.seed(account, data);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await expect(engine.restore(new Storage(account))).rejects.toBeInstanceOf(Error);
    engine.destroy();
  });

  it("aborts an in-progress snapshot write after destruction", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    vi.stubGlobal("fetch", serveLibrary());
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    const before = await storage.files.get(await snapshotPath(account))!.text();
    storage.beforeWrite = vi.fn(() => engine.destroy());
    loadLibrary(engine, createConnection(auth));
    await vi.waitFor(() => expect(storage.beforeWrite).toHaveBeenCalledOnce());
    expect(await storage.files.get(await snapshotPath(account))!.text()).toBe(before);
    expect(storage.writes).toBe(0);
  });

  it("coordinates writes across engine instances with Web Locks", async () => {
    const storage = installMetadataStorage();
    vi.stubGlobal("fetch", serveLibrary());
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => {
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    });
    Object.assign(navigator, { locks: { request } });
    const firstMemory = new Memory();
    const first = new MetadataEngine(firstMemory);
    const secondMemory = new Memory();
    const second = new MetadataEngine(secondMemory);
    await Promise.all([first.restore(new Storage(account)), second.restore(new Storage(account))]);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockClear();
    await Promise.all([
      loadLibrary(first, createConnection(auth)),
      loadLibrary(second, createConnection(auth)),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0]);
    expect(storage.files.size).toBe(1);
    first.destroy();
    second.destroy();
  });

  it("explicitly repairs an invalid metadata cache with a fresh server snapshot", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, { invalid: true });
    vi.stubGlobal("fetch", serveLibrary());
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await expect(engine.restore(new Storage(account))).rejects.toBeInstanceOf(Error);
    await loadLibrary(engine, createConnection(auth));

    expect(engineMemory.tracks.get("song")?.title).toBe("Song");
    expect(storage.writes).toBe(1);
    expect(JSON.parse(await storage.files.get(await snapshotPath(account))!.text())).toMatchObject({
      account,
      lastModified: 20,
      tracks: [{ id: "song" }],
    });
    engine.destroy();
  });

  it("does not overwrite a newer snapshot saved by another tab during refresh", async () => {
    const storage = installMetadataStorage();
    const serve = serveLibrary();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("getAlbum.view")) {
          const newer = snapshot();
          newer.lastModified = 30;
          newer.tracks[0].title = "Newer";
          await storage.seed(account, newer);
        }
        return serve(input);
      }),
    );
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await loadLibrary(engine, createConnection(auth));
    expect(engineMemory.tracks.get("song")?.title).toBe("Newer");
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("publishes restored and refreshed entities into injected memory without retaining old maps", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const memory = new Memory();
    memory.account = account;

    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    expect(memory.account).toBe(account);
    expect(memory.tracks.get("song")).toEqual(snapshot().tracks[0]);

    expect(memory.albumTracks.get("album")?.[0]).toBe(memory.tracks.get("song"));
    expect(memory.artistAlbums.get("artist")?.[0]).toBe(memory.albums.get("album"));
    const oldTracks = memory.tracks;
    vi.stubGlobal("fetch", serveLibrary());
    await loadLibrary(engine, createConnection(auth));
    expect(memory.tracks).not.toBe(oldTracks);
    expect(memory.tracks.get("song")?.title).toBe("Song");
    expect(oldTracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(memory.albumTracks.get("album")?.[0]).toBe(memory.tracks.get("song"));
    engine.destroy();
  });

  it("restores the whole snapshot at startup without a client or network requests", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));

    expect([...engineMemory.artists.values()]).toEqual(snapshot().artists);
    expect(engineMemory.albums.get("album")).toEqual(snapshot().albums[0]);
    expect(engineMemory.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(engineMemory.artistAlbums.get("artist") ?? []).toEqual(snapshot().albums);
    expect(engineMemory.albumTracks.get("album") ?? []).toEqual(snapshot().tracks);
    expect(fetcher).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("keeps restored metadata visible during revalidation without rereading storage", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    storage.getDirectory.mockClear();
    engine.setConnection(createConnection(auth));
    const refreshing = engine.refresh(false);

    expect(engineMemory.tracks.get("song")?.title).toBe("Song");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    resolve(response({ indexes: { lastModified: 10 } }));
    await refreshing;
    expect(storage.getDirectory).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    engine.destroy();
  });

  it("persists a complete normalized snapshot and restores it in a new engine", async () => {
    const storage = installMetadataStorage();
    vi.stubGlobal("fetch", serveLibrary());
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await loadLibrary(engine, createConnection(auth));
    expect(engineMemory.tracks.get("song")).toMatchObject({
      albumId: "album",
      artistId: "artist",
      mimeType: "audio/flac",
      number: 1,
    });
    expect(storage.files.size).toBe(1);
    const text = await [...storage.files.values()][0].text();
    expect(text).not.toContain(auth.token);
    expect(text).not.toContain(auth.salt);
    expect(text).not.toContain("contentType");
    engine.destroy();
    const restoredMemory = new Memory();
    const restored = new MetadataEngine(restoredMemory);
    await restored.restore(new Storage(account));
    expect(restoredMemory.tracks.get("song")?.mimeType).toBe("audio/flac");
    restored.destroy();
  });

  it("keeps cached data and reports warnings after refresh or persistence failure", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    vi.stubGlobal("fetch", serveLibrary());
    storage.failWrites = true;
    const memory = new Memory();

    const engine = new MetadataEngine(memory);
    await engine.restore(new Storage(account));
    const accepted = [
      memory.artists,
      memory.albums,
      memory.tracks,
      memory.artistAlbums,
      memory.albumTracks,
    ];
    await expect(loadLibrary(engine, createConnection(auth))).rejects.toBeInstanceOf(Error);
    [memory.artists, memory.albums, memory.tracks, memory.artistAlbums, memory.albumTracks].forEach(
      (map, i) => expect(map).toBe(accepted[i]),
    );
    expect(memory.tracks.get("song")).toEqual(snapshot().tracks[0]);

    engine.destroy();
    const restoredMemory = new Memory();
    const restored = new MetadataEngine(restoredMemory);
    await restored.restore(new Storage(account));
    expect(restoredMemory.tracks.get("song")).toEqual(snapshot().tracks[0]);
    restored.destroy();
  });

  it("does not read storage or fetch again when entering offline mode", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn(async () => response({ indexes: { lastModified: 10 } }));
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    await loadLibrary(engine, createConnection(auth));

    storage.getDirectory.mockClear();
    fetcher.mockClear();
    engine.setConnection(undefined);

    expect(engineMemory.tracks.get("song")).toBeDefined();
    expect(storage.getDirectory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("forces a whole replacement even when the server timestamp is unchanged", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const serve = serveLibrary();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("getIndexes"))
          return response({ indexes: { lastModified: 10 } });
        if (String(input).includes("getAlbum.view"))
          return response({ album: { song: [{ id: "new-song", title: "New song" }] } });
        return serve(input);
      }),
    );
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    await loadLibrary(engine, createConnection(auth));

    expect(storage.writes).toBe(0);
    const refreshing = engine.refresh();
    expect(engineMemory.tracks.get("song")).toBeDefined();
    await refreshing;
    expect(storage.writes).toBe(1);
    expect(engineMemory.tracks.get("song")).toBeUndefined();
    expect((engineMemory.albumTracks.get("album") ?? []).map((track) => track.id)).toEqual([
      "new-song",
    ]);
    engine.destroy();
  });

  it("ignores an in-flight online refresh when switching offline", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    loadLibrary(engine, createConnection(auth));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    engine.setConnection(undefined);
    resolve(response({ indexes: { lastModified: 20 } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(engineMemory.tracks.get("song")).toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("reports missing or invalid snapshots offline without touching IndexedDB", async () => {
    const storage = installMetadataStorage();
    const indexedDB = { open: vi.fn() };
    vi.stubGlobal("indexedDB", indexedDB);
    const engineMemory = new Memory();
    const engine = new MetadataEngine(engineMemory);
    await engine.restore(new Storage(account));
    await engine.refresh(false);

    expect([...engineMemory.artists.values()]).toEqual([]);
    expect(indexedDB.open).not.toHaveBeenCalled();
    engine.destroy();
    await storage.seed(account, { data: [] });
    const invalidMemory = new Memory();
    const invalid = new MetadataEngine(invalidMemory);
    await expect(invalid.restore(new Storage(account))).rejects.toBeInstanceOf(Error);
    expect([...invalidMemory.artists.values()]).toEqual([]);
    invalid.destroy();
  });

  it("does not publish or persist an obsolete refresh after switching accounts", async () => {
    const storage = installMetadataStorage();
    const other = { ...account, username: "other" };
    await storage.seed(other, {
      ...snapshot(),
      account: other,
      artists: [{ id: "artist", name: "Other", genres: [] }],
    });
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
    const memory = new Memory();
    memory.account = account;

    const engine = new MetadataEngine(memory);
    loadLibrary(engine, createConnection(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    memory.account = other;
    await engine.restore(new Storage(other));
    const accepted = memory.artists;
    expect(memory.account).toEqual(other);
    resolve(response({ indexes: { lastModified: 20 } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(memory.artists.get("artist")?.name).toBe("Other");
    expect(memory.artists).toBe(accepted);
    expect(memory.artists.get("artist")?.name).toBe("Other");
    expect(storage.files.size).toBe(1);
    expect(storage.writes).toBe(0);
    engine.destroy();
  });
});

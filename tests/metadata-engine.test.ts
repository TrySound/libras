import { deferred } from "./session-test-helpers";
import { clearTestTimers } from "./cache-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataEngine } from "../src/metadata.svelte";
import { Cache } from "../src/cache.svelte";
import type { MetadataSnapshot } from "../src/metadata.svelte";
import type { Account } from "../src/schema";
import { Network, type LibraryProgress } from "../src/network.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";

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
// Network snapshots include identity; persisted library documents do not.
function persisted(data: unknown) {
  if (!data || typeof data !== "object") return data;
  const { account: _account, ...record } = data as Record<string, unknown>;
  return record;
}
async function snapshotPath(identity: Account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([identity.host, identity.username])),
  );
  return `accounts/${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}/library.json`;
}
function installMetadataStorage() {
  clearTestTimers();
  const storage = {
    files: new Map<string, File>(),
    failWrites: false,
    beforeWrite: undefined as (() => void) | undefined,
    writes: 0,
    async seed(identity: Account, data: unknown) {
      const path = await snapshotPath(identity);
      storage.files.set(path, new File([JSON.stringify(persisted(data))], path));
    },
  };
  function directoryHandle(directory: string): unknown {
    return {
      async getDirectoryHandle(name: string) {
        return directoryHandle(directory ? `${directory}/${name}` : name);
      },
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
  }
  const getDirectory = vi.fn(async () => directoryHandle(""));
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
    readLibrary: (signal: AbortSignal, onProgress?: (progress: LibraryProgress) => void) =>
      metadata.readLibrary(signal, onProgress),
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
    if (url.includes("search3")) {
      const params = new URL(url).searchParams;
      const slice = (key: string, items: unknown[]) =>
        items.slice(
          Number(params.get(`${key}Offset`)),
          Number(params.get(`${key}Offset`)) + Number(params.get(`${key}Count`)),
        );
      return response({
        searchResult3: {
          artist: slice("artist", data.artists ?? [{ id: "artist", name: "Artist" }]),
          album: slice(
            "album",
            data.albums ?? [
              { id: "album", name: "Album", artists: [{ id: "artist", name: "Artist" }] },
            ],
          ),
          song: slice(
            "song",
            data.tracks ?? [
              {
                id: "song",
                title: "Song",
                artists: [{ id: "artist", name: "Artist" }],
                albumId: "album",
                track: 1,
                contentType: "audio/flac",
              },
            ],
          ),
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Session owns this setup in the application; engine tests select/load explicitly.
async function loadCache(selection: TestSelection, cache: Cache) {
  selection.cache = cache;
  await cache.load();
}

async function loadLibrary(
  engine: MetadataEngine,
  client: ReturnType<typeof createConnection>,
  selection: TestSelection,
) {
  if (!selection.cache) await loadCache(selection, new Cache(client.account));
  engine.setConnection(client);
  await engine.refresh(false);
  await selection.cache!.flush();
}

describe("metadata engine", () => {
  it.each(["detach", "destroy"])(
    "cancels candidate traversal on %s without publishing",
    async (action) => {
      const selection = new TestSelection();
      const engine = new MetadataEngine(selection);
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
      expect(selection.cache).toBeUndefined();
      expect(selection.cache?.savedAt).toBeUndefined();
      engine.destroy();
    },
  );

  it("supersedes a candidate before fetching its library", async () => {
    const engine = new MetadataEngine(new TestSelection());
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

  it("requires a matching selected cache without trying to load or select one", async () => {
    const disk = installMetadataStorage();
    const selection = new TestSelection();
    const engine = new MetadataEngine(selection);
    const connection = createConnection(auth);
    const modified = vi.spyOn(connection, "getModifiedAt");
    engine.setConnection(connection);
    await expect(engine.refresh()).rejects.toThrow("Select the account cache");
    const foreign = new Cache({ ...account, username: "other" });
    selection.cache = foreign;
    await expect(engine.refresh()).rejects.toThrow("Select the account cache");
    expect(selection.cache).toBe(foreign);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(modified).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("revalidates or forces a refresh directly without a commit protocol", async () => {
    const disk = installMetadataStorage();
    await disk.seed(account, snapshot());
    const selection = new TestSelection();
    const engine = new MetadataEngine(selection);
    await loadCache(selection, new Cache(account));
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
    expect(disk.writes).toBe(0);
    await selection.cache!.flush();
    expect(disk.writes).toBe(1);

    engine.destroy();
  });

  it("keeps restored data and reports a direct refresh failure to its caller", async () => {
    const disk = installMetadataStorage();
    await disk.seed(account, snapshot());
    const selection = new TestSelection();
    const engine = new MetadataEngine(selection);
    await loadCache(selection, new Cache(account));
    const previous = selection.cache!.tracks;
    const connection = createConnection(auth);
    const error = new Error("Server unavailable");
    vi.spyOn(connection, "getModifiedAt").mockRejectedValue(error);
    engine.setConnection(connection);
    await expect(engine.refresh()).rejects.toBe(error);
    expect(selection.cache!.tracks).toBe(previous);

    expect(disk.writes).toBe(0);
    engine.destroy();
  });

  it.each(["listener", "other"])(
    "fetches a candidate for %s without replacing or persisting offline metadata",
    async (username) => {
      const storage = installMetadataStorage();
      await storage.seed(account, snapshot());
      const selection = new TestSelection();
      const engine = new MetadataEngine(selection);
      await loadCache(selection, new Cache(account));
      const previous = selection.cache!.tracks;
      const network = new Network();
      const client = network.prepare({ ...auth, username });
      vi.stubGlobal("fetch", serveLibrary());
      const prepared = await engine.prepareConnection(client.metadata);
      expect(network.mode).toBe("offline");
      expect(selection.cache!.tracks).toBe(previous);
      expect(selection.cache!.account).toEqual(account);
      expect(storage.files.size).toBe(1);
      expect(prepared.account).toEqual({ host: auth.host, username });
      expect(prepared.tracks[0]?.title).toBe("Song");
      expect(storage.writes).toBe(0);
      engine.destroy();
    },
  );

  it.each([false, true])(
    "preserves offline metadata after failed or aborted connection preparation (abort: %s)",
    async (abort) => {
      const storage = installMetadataStorage();
      await storage.seed(account, snapshot());
      const selection = new TestSelection();
      const engine = new MetadataEngine(selection);
      await loadCache(selection, new Cache(account));
      const previous = selection.cache!.tracks;
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
      expect(selection.cache!.tracks).toBe(previous);
      expect(selection.cache!.account).toEqual(account);
      expect(storage.writes).toBe(0);

      engine.destroy();
    },
  );

  it("configures captured connections without I/O, leaving restoration and refresh explicit", async () => {
    const storage = installMetadataStorage();
    const fetcher = serveLibrary();
    vi.stubGlobal("fetch", fetcher);
    const selection = new TestSelection();
    const engine = new MetadataEngine(selection);
    engine.setConnection(createConnection(auth));
    engine.setConnection(undefined);
    engine.setConnection(createConnection(auth));
    expect(storage.getDirectory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await loadCache(selection, new Cache(account));
    expect(fetcher).not.toHaveBeenCalled();
    await engine.refresh(false);

    expect(selection.cache!.tracks.get("song")).toBeDefined();
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
    const selection = new TestSelection();
    const engine = new MetadataEngine(selection);
    await loadCache(selection, new Cache(account));
    const previous = selection.cache!.tracks;
    const connection = createConnection(auth);
    engine.setConnection(connection);
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("getIndexes.view"))
        return response({ indexes: { lastModified: 20 } });
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
        searchResult3: {
          album: Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: String(i) })),
        },
      }),
    );
    await refreshing;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(selection.cache!.tracks).toBe(previous);
    expect(storage.writes).toBe(0);

    vi.stubGlobal("fetch", serveLibrary());
    engine.setConnection(connection);
    await engine.refresh();
    expect(selection.cache!.tracks.get("song")?.title).toBe("Song");
    engine.destroy();
  });

  it("paginates all metadata independently through search3", async () => {
    installMetadataStorage();
    const albums = Array.from({ length: 501 }, (_, index) => ({
      id: `album-${index}`,
      name: `Album ${index}`,
      artistId: "artist",
    }));
    const offsets: number[] = [];
    const artistCounts: number[] = [];
    const songOffsets: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("u")).toBe(auth.username);
        if (url.pathname.endsWith("getIndexes.view"))
          return response({ indexes: { lastModified: 20 } });
        if (url.pathname.endsWith("search3.view")) {
          expect(url.searchParams.get("query")).toBe("");
          const offset = Number(url.searchParams.get("albumOffset"));
          offsets.push(offset);
          artistCounts.push(Number(url.searchParams.get("artistCount")));
          songOffsets.push(Number(url.searchParams.get("songOffset")));
          return response({
            searchResult3: {
              artist:
                Number(url.searchParams.get("artistOffset")) === 0
                  ? [{ id: "artist", name: "Artist" }]
                  : [],
              album: albums.slice(offset, offset + 500),
              song: [],
            },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const selection = new TestSelection();
    const engine = new MetadataEngine(selection);
    await loadLibrary(engine, createConnection(auth), selection);
    expect(offsets).toEqual([0, 500, 501]);
    expect(artistCounts).toEqual([500, 500, 0]);
    expect(songOffsets).toEqual([0, 0, 0]);
    expect(selection.cache!.albums.size).toBe(501);

    engine.destroy();
  });

  it.each(["connect", "refresh"])(
    "reports and clears %s counters and ignores cancelled updates",
    async (mode) => {
      installMetadataStorage();
      const selection = new TestSelection();
      await loadCache(selection, new Cache(account));
      const engine = new MetadataEngine(selection);
      const controller = new AbortController();
      const pending = deferred<{ artists: []; albums: []; tracks: [] }>();
      let report: ((progress: LibraryProgress) => void) | undefined;
      const connection = {
        account,
        signal: controller.signal,
        getModifiedAt: async () => 20,
        readLibrary: async (_signal: AbortSignal, onProgress?: typeof report) => {
          report = onProgress;
          return pending.promise;
        },
      };
      engine.setConnection(connection);
      const run = () =>
        mode === "connect" ? engine.prepareConnection(connection) : engine.refresh();
      const loading = run();
      const settled = loading.catch(() => undefined);
      await vi.waitFor(() => expect(report).toBeDefined());
      expect(engine.progress).toEqual({ albums: 0, tracks: 0 });
      report!({ albums: 500, tracks: 1000 });
      expect(engine.progress).toEqual({ albums: 500, tracks: 1000 });
      engine.setConnection(undefined);
      expect(engine.progress).toBeUndefined();
      report!({ albums: 999, tracks: 999 });
      expect(engine.progress).toBeUndefined();
      pending.resolve({ artists: [], albums: [], tracks: [] });
      await settled;
      engine.setConnection(connection);
      await run();
      expect(engine.progress).toBeUndefined();
      engine.destroy();
    },
  );

  it("normalizes only album artists while preserving track artist names", async () => {
    const storage = installMetadataStorage();
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [
          { id: "artist", name: "Artist" },
          { id: "guest", name: "Guest" },
          { id: "unused", name: "Unused contributor" },
        ],
        albums: [
          {
            id: "album",
            name: "Album",
            artists: [{ id: "artist", name: "Artist" }],
            coverArt: "cover",
            year: 2024,
          },
        ],
        tracks: [
          {
            id: "second",
            title: "Second",
            artists: [{ id: "guest", name: "Guest" }],
            albumId: "album",
            track: 2,
            discNumber: 1,
            contentType: "audio/flac",
            duration: 120,
          },
          { id: "first", title: "First", albumId: "album", track: 1 },
        ],
      }),
    );
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadLibrary(engine, createConnection(auth), engineSelection);
    expect(engineSelection.cache!.albums.get("album")).toEqual({
      id: "album",
      title: "Album",
      artistId: "artist",
      artworkId: "cover",
      year: 2024,
      genres: [],
    });
    expect(engineSelection.cache!.tracks.get("second")).toMatchObject({
      artistId: "guest",
      artistName: "Guest",
      albumId: "album",
      number: 2,
      disc: 1,
      mimeType: "audio/flac",
      duration: 120,
    });
    expect(engineSelection.cache!.tracks.get("first")?.artistId).toBe("artist");
    expect(
      engineSelection.cache!.artists.get("artist")?.genres.map((genre) => genre.toLowerCase()),
    ).toEqual([]);
    expect(
      (engineSelection.cache!.artistAlbums.get("artist") ?? []).map((album) => album.id),
    ).toEqual(["album"]);
    expect([...engineSelection.cache!.artists.keys()]).toEqual(["artist"]);
    expect(engineSelection.cache!.artistAlbums.get("guest") ?? []).toEqual([]);
    expect(
      (engineSelection.cache!.albumTracks.get("album") ?? []).map((track) => track.id),
    ).toEqual(["first", "second"]);
    expect(engineSelection.cache!.albumTracks.get("missing") ?? []).toEqual([]);
    const persisted = JSON.parse(await storage.files.get(await snapshotPath(account))!.text());
    expect(persisted.artists.map((artist: { id: string }) => artist.id)).toEqual(["artist"]);
    expect(persisted.tracks.find((track: { id: string }) => track.id === "second").artistName).toBe(
      "Guest",
    );
    expect(persisted.artists[0]).not.toHaveProperty("albums");
    expect(persisted.albums[0]).not.toHaveProperty("tracks");
    expect(JSON.stringify(persisted)).not.toMatch(/contentType|coverArt|discNumber/);
    engine.destroy();
  });

  it("uses structured genres and artist credits without consulting legacy fields", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [{ id: "owner", name: "Owner" }],
        albums: [
          {
            id: "album",
            name: "Album",
            artists: [{ id: "owner", name: "Owner" }],
            artistId: "legacy",
            artist: "Legacy",
            genre: "Ignored",
            genres: [{ name: " Rock " }, { name: "rock" }, { name: "Jazz|Fusion" }, { name: " " }],
          },
        ],
        tracks: [
          {
            id: "song",
            title: "Song",
            albumId: "album",
            artists: [
              { id: "lead", name: "Lead" },
              { id: "guest", name: "Guest" },
            ],
            displayArtist: "Lead feat. Guest",
            artistId: "legacy",
            artist: "Legacy",
            genre: "Ignored",
            genres: [{ name: "Soul" }],
          },
        ],
      }),
    );
    const connection = createConnection(auth);
    const library = await connection.readLibrary(new AbortController().signal);
    expect(library.albums[0]).toMatchObject({ artistId: "owner", genres: ["Jazz|Fusion", "rock"] });
    expect(library.tracks[0]).toMatchObject({
      artistId: "lead",
      artistName: "Lead feat. Guest",
      genres: ["Soul"],
    });
    expect(library.artists.map((artist) => artist.id)).toEqual(["owner"]);
    connection.abort();
  });

  it("does not recover genres or artists from legacy-only metadata", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [],
        albums: [
          { id: "album", name: "Album", artistId: "legacy", artist: "Legacy", genre: "Rock" },
        ],
        tracks: [
          {
            id: "song",
            title: "Song",
            albumId: "album",
            artistId: "legacy",
            artist: "Legacy",
            genre: "Rock",
          },
        ],
      }),
    );
    const connection = createConnection(auth);
    const library = await connection.readLibrary(new AbortController().signal);
    expect(library.artists[0].name).toBe("Unknown artist");
    expect(library.albums[0].genres).toEqual([]);
    expect(library.tracks[0]).toMatchObject({ artistName: "Unknown artist", genres: [] });
    connection.abort();
  });

  it("keeps artists who own later albums and removes unreferenced search artists", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [
          { id: "unused", name: "Unused" },
          { id: "guest", name: "Guest" },
        ],
        albums: [
          { id: "first", name: "First", artists: [{ id: "owner", name: "Owner" }] },
          { id: "second", name: "Second", artists: [{ id: "guest", name: "Guest" }] },
        ],
        tracks: [
          {
            id: "song",
            title: "Song",
            albumId: "first",
            artists: [{ id: "guest", name: "Guest" }],
          },
        ],
      }),
    );
    const connection = createConnection(auth);
    const library = await connection.readLibrary(new AbortController().signal);
    expect(library.artists.map((artist) => artist.id).sort()).toEqual(["guest", "owner"]);
    expect(library.tracks[0]).toMatchObject({ artistId: "guest", artistName: "Guest" });
    vi.stubGlobal(
      "fetch",
      serveLibrary({ artists: [{ id: "unused", name: "Unused" }], albums: [], tracks: [] }),
    );
    await expect(connection.readLibrary(new AbortController().signal)).resolves.toEqual({
      artists: [],
      albums: [],
      tracks: [],
    });
    connection.abort();
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
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    expect([...engineSelection.cache!.artists.values()].map((item) => item.id)).toEqual(["a", "b"]);
    expect((engineSelection.cache!.artistAlbums.get("a") ?? []).map((item) => item.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect(
      (engineSelection.cache!.albumTracks.get("earlier") ?? []).map((item) => item.id),
    ).toEqual(["first", "second"]);

    expect(engineSelection.cache!.albumTracks.get("earlier") ?? []).toBe(
      engineSelection.cache!.albumTracks.get("earlier") ?? [],
    );
    expect(engineSelection.cache!.artistAlbums.get("missing")).toBeUndefined();
    expect(engineSelection.cache!.albumTracks.get("missing")).toBeUndefined();
    expect((engineSelection.cache!.albumTracks.get("earlier") ?? [])[0]).toBe(
      engineSelection.cache!.tracks.get("first"),
    );
    expect(JSON.parse(await storage.files.get(await snapshotPath(account))!.text())).toEqual(
      persisted(data),
    );
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("creates stable IDs when only display artists are supplied", async () => {
    installMetadataStorage();
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [],
        albums: [{ id: "album", name: "Album", displayArtist: "Artist" }],
        tracks: [{ id: "song", title: "Song", albumId: "album", displayArtist: "Guest" }],
      }),
    );
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadLibrary(engine, createConnection(auth), engineSelection);
    const ids = [...engineSelection.cache!.artists.values()].map((artist) => artist.id);
    expect(ids).toHaveLength(1);
    expect(ids).toContain(engineSelection.cache!.albums.get("album")?.artistId);
    expect(ids).not.toContain(engineSelection.cache!.tracks.get("song")?.artistId);
    expect(engineSelection.cache!.tracks.get("song")?.artistName).toBe("Guest");
    await engine.refresh();
    expect([...engineSelection.cache!.artists.values()].map((artist) => artist.id)).toEqual(ids);
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
      const engineSelection = new TestSelection();
      const engine = new MetadataEngine(engineSelection);
      await expect(loadCache(engineSelection, new Cache(account))).rejects.toBeInstanceOf(Error);
      expect([...engineSelection.cache!.artists.values()]).toEqual([]);
      engine.destroy();
    },
  );

  it("restores library data only from the selected account's namespace", async () => {
    const storage = installMetadataStorage();
    const other = { ...account, username: "other" };
    await storage.seed(other, { ...snapshot(), account: other });
    const selection = new TestSelection();
    await loadCache(selection, new Cache(account));
    expect(selection.cache!.savedAt).toBeUndefined();
    expect(selection.cache!.tracks.size).toBe(0);
    await loadCache(selection, new Cache(other));
    expect(selection.cache!.savedAt).toBe(100);
    expect(selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
  });

  it("engine destruction does not cancel a checkpoint of already adopted data", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    vi.stubGlobal("fetch", serveLibrary());
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    storage.beforeWrite = vi.fn(() => engine.destroy());
    await loadLibrary(engine, createConnection(auth), engineSelection);
    expect(storage.beforeWrite).toHaveBeenCalledOnce();
    expect(
      JSON.parse(await storage.files.get(await snapshotPath(account))!.text()).lastModified,
    ).toBe(20);
    expect(storage.writes).toBe(1);
  });

  it("explicitly repairs an invalid metadata cache with a fresh server snapshot", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, { invalid: true });
    vi.stubGlobal("fetch", serveLibrary());
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await expect(loadCache(engineSelection, new Cache(account))).rejects.toBeInstanceOf(Error);
    engine.setConnection(createConnection(auth));
    await engine.refresh(false);

    expect(engineSelection.cache!.tracks.get("song")?.title).toBe("Song");
    await engineSelection.cache!.flush();
    expect(storage.writes).toBe(1);
    expect(JSON.parse(await storage.files.get(await snapshotPath(account))!.text())).toMatchObject({
      lastModified: 20,
      tracks: [{ id: "song" }],
    });
    engine.destroy();
  });

  it("reads restored and refreshed entities from the selected Cache without retaining old maps", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const selection = new TestSelection();

    const engine = new MetadataEngine(selection);
    await loadCache(selection, new Cache(account));
    expect(selection.cache!.account).toEqual(account);
    expect(selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);

    expect(selection.cache!.albumTracks.get("album")?.[0]).toBe(
      selection.cache!.tracks.get("song"),
    );
    expect(selection.cache!.artistAlbums.get("artist")?.[0]).toBe(
      selection.cache!.albums.get("album"),
    );
    const oldTracks = selection.cache!.tracks;
    vi.stubGlobal("fetch", serveLibrary());
    await loadLibrary(engine, createConnection(auth), selection);
    expect(selection.cache!.tracks).not.toBe(oldTracks);
    expect(selection.cache!.tracks.get("song")?.title).toBe("Song");
    expect(oldTracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(selection.cache!.albumTracks.get("album")?.[0]).toBe(
      selection.cache!.tracks.get("song"),
    );
    engine.destroy();
  });

  it("restores the whole snapshot at startup without a client or network requests", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));

    expect([...engineSelection.cache!.artists.values()]).toEqual(snapshot().artists);
    expect(engineSelection.cache!.albums.get("album")).toEqual(snapshot().albums[0]);
    expect(engineSelection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(engineSelection.cache!.artistAlbums.get("artist") ?? []).toEqual(snapshot().albums);
    expect(engineSelection.cache!.albumTracks.get("album") ?? []).toEqual(snapshot().tracks);
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
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    storage.getDirectory.mockClear();
    engine.setConnection(createConnection(auth));
    const refreshing = engine.refresh(false);

    expect(engineSelection.cache!.tracks.get("song")?.title).toBe("Song");
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
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadLibrary(engine, createConnection(auth), engineSelection);
    expect(engineSelection.cache!.tracks.get("song")).toMatchObject({
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
    const restoredSelection = new TestSelection();
    const restored = new MetadataEngine(restoredSelection);
    await loadCache(restoredSelection, new Cache(account));
    expect(restoredSelection.cache!.tracks.get("song")?.mimeType).toBe("audio/flac");
    restored.destroy();
  });

  it("keeps cached data and reports warnings after refresh or persistence failure", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    vi.stubGlobal("fetch", serveLibrary());
    storage.failWrites = true;
    const selection = new TestSelection();

    const engine = new MetadataEngine(selection);
    await loadCache(selection, new Cache(account));
    const accepted = [
      selection.cache!.artists,
      selection.cache!.albums,
      selection.cache!.tracks,
      selection.cache!.artistAlbums,
      selection.cache!.albumTracks,
    ];
    engine.setConnection(createConnection(auth));
    await engine.refresh(false);
    await expect(selection.cache!.flush()).rejects.toBeInstanceOf(Error);
    expect(selection.cache!.error).toBeDefined();
    [
      selection.cache!.artists,
      selection.cache!.albums,
      selection.cache!.tracks,
      selection.cache!.artistAlbums,
      selection.cache!.albumTracks,
    ].forEach((map, i) => expect(map).not.toBe(accepted[i]));
    expect(selection.cache!.tracks.get("song")?.mimeType).toBe("audio/flac");

    engine.destroy();
    const restoredSelection = new TestSelection();
    const restored = new MetadataEngine(restoredSelection);
    await loadCache(restoredSelection, new Cache(account));
    expect(restoredSelection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    restored.destroy();
  });

  it("does not read storage or fetch again when entering offline mode", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn(async () => response({ indexes: { lastModified: 10 } }));
    vi.stubGlobal("fetch", fetcher);
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    await loadLibrary(engine, createConnection(auth), engineSelection);

    storage.getDirectory.mockClear();
    fetcher.mockClear();
    engine.setConnection(undefined);

    expect(engineSelection.cache!.tracks.get("song")).toBeDefined();
    expect(storage.getDirectory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("forces a whole replacement even when the server timestamp is unchanged", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const serve = serveLibrary({
      tracks: [{ id: "new-song", title: "New song", albumId: "album" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("getIndexes"))
          return response({ indexes: { lastModified: 10 } });
        return serve(input);
      }),
    );
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    await loadLibrary(engine, createConnection(auth), engineSelection);

    expect(storage.writes).toBe(0);
    const refreshing = engine.refresh();
    expect(engineSelection.cache!.tracks.get("song")).toBeDefined();
    await refreshing;
    await engineSelection.cache!.flush();
    expect(storage.writes).toBe(1);
    expect(engineSelection.cache!.tracks.get("song")).toBeUndefined();
    expect(
      (engineSelection.cache!.albumTracks.get("album") ?? []).map((track) => track.id),
    ).toEqual(["new-song"]);
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
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    loadLibrary(engine, createConnection(auth), engineSelection);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    engine.setConnection(undefined);
    resolve(response({ indexes: { lastModified: 20 } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(engineSelection.cache!.tracks.get("song")).toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("reports missing or invalid snapshots offline without touching IndexedDB", async () => {
    const storage = installMetadataStorage();
    const indexedDB = { open: vi.fn() };
    vi.stubGlobal("indexedDB", indexedDB);
    const engineSelection = new TestSelection();
    const engine = new MetadataEngine(engineSelection);
    await loadCache(engineSelection, new Cache(account));
    await engine.refresh(false);

    expect([...engineSelection.cache!.artists.values()]).toEqual([]);
    expect(indexedDB.open).not.toHaveBeenCalled();
    engine.destroy();
    await storage.seed(account, { data: [] });
    const invalidSelection = new TestSelection();
    const invalid = new MetadataEngine(invalidSelection);
    await expect(loadCache(invalidSelection, new Cache(account))).rejects.toBeInstanceOf(Error);
    expect([...invalidSelection.cache!.artists.values()]).toEqual([]);
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
    const selection = new TestSelection();

    const engine = new MetadataEngine(selection);
    loadLibrary(engine, createConnection(auth), selection);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    engine.setConnection(undefined);
    await loadCache(selection, new Cache(other));
    const accepted = selection.cache!.artists;
    expect(selection.cache!.account).toEqual(other);
    resolve(response({ indexes: { lastModified: 20 } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(selection.cache!.artists.get("artist")?.name).toBe("Other");
    expect(selection.cache!.artists).toBe(accepted);
    expect(selection.cache!.artists.get("artist")?.name).toBe("Other");
    expect(storage.files.size).toBe(1);
    expect(storage.writes).toBe(0);
    engine.destroy();
  });
});

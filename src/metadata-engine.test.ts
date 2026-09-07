import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataEngine, type MetadataAccount, type MetadataSnapshot } from "./metadata-engine";
import { SubsonicClient } from "./subsonic-client";

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
async function snapshotPath(identity: MetadataAccount) {
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
    async seed(identity: MetadataAccount, data: unknown) {
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

describe("metadata engine", () => {
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
    const engine = new MetadataEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(engine.getAlbum("album")).toEqual({
      id: "album",
      title: "Album",
      artistId: "artist",
      artworkId: "cover",
      year: 2024,
      genres: [],
    });
    expect(engine.getTrack("second")).toMatchObject({
      artistId: "guest",
      albumId: "album",
      number: 2,
      disc: 1,
      mimeType: "audio/flac",
      duration: 120,
    });
    expect(engine.getTrack("first")?.artistId).toBe("artist");
    expect(engine.getArtist("artist")?.genres.map((genre) => genre.toLowerCase())).toEqual([
      "jazz",
      "rock",
    ]);
    expect(engine.getArtistAlbums("artist").map((album) => album.id)).toEqual(["album"]);
    expect(engine.getArtistAlbums("guest")).toEqual([]);
    expect(engine.getAlbumTracks("album").map((track) => track.id)).toEqual(["first", "second"]);
    expect(engine.getAlbumTracks("missing")).toEqual([]);
    const persisted = JSON.parse(await storage.files.get(await snapshotPath(account))!.text());
    expect(persisted.artists[0]).not.toHaveProperty("albums");
    expect(persisted.albums[0]).not.toHaveProperty("tracks");
    expect(JSON.stringify(persisted)).not.toMatch(/contentType|coverArt|discNumber/);
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
    const engine = new MetadataEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    const ids = engine.getArtists().map((artist) => artist.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(engine.getAlbum("album")?.artistId);
    expect(ids).toContain(engine.getTrack("song")?.artistId);
    engine.refresh();
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(engine.getArtists().map((artist) => artist.id)).toEqual(ids);
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
      const engine = new MetadataEngine();
      await engine.restore(account);
      expect(engine.status).toBe("error");
      expect(engine.getArtists()).toEqual([]);
      engine.destroy();
    },
  );

  it.each(["album-artist", "track-album", "track-artist", "account"])(
    "rejects invalid snapshot references: %s",
    async (reference) => {
      const storage = installMetadataStorage();
      const data = snapshot();
      if (reference === "album-artist") data.albums[0].artistId = "missing";
      if (reference === "track-album") data.tracks[0].albumId = "missing";
      if (reference === "track-artist") data.tracks[0].artistId = "missing";
      if (reference === "account") data.account = { ...account, username: "other" };
      await storage.seed(account, data);
      const engine = new MetadataEngine();
      await engine.restore(account);
      expect(engine.status).toBe("error");
      expect(engine.error).toBeInstanceOf(Error);
      engine.destroy();
    },
  );

  it("aborts an in-progress snapshot write after destruction", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    vi.stubGlobal("fetch", serveLibrary());
    const engine = new MetadataEngine();
    await engine.restore(account);
    const before = await storage.files.get(await snapshotPath(account))!.text();
    storage.beforeWrite = vi.fn(() => engine.destroy());
    engine.setClient(new SubsonicClient(auth));
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
    const first = new MetadataEngine();
    const second = new MetadataEngine();
    first.setClient(new SubsonicClient(auth));
    second.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => {
      expect(first.status).toBe("ready");
      expect(second.status).toBe("ready");
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0]);
    expect(storage.files.size).toBe(1);
    first.destroy();
    second.destroy();
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
    const engine = new MetadataEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(engine.getTrack("song")?.title).toBe("Newer");
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("restores the whole snapshot at startup without a client or network requests", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new MetadataEngine();
    await engine.restore(account);
    expect(engine.status).toBe("ready");
    expect(engine.getArtists()).toEqual(snapshot().artists);
    expect(engine.getAlbum("album")).toEqual(snapshot().albums[0]);
    expect(engine.getTrack("song")).toEqual(snapshot().tracks[0]);
    expect(engine.getArtistAlbums("artist")).toEqual(snapshot().albums);
    expect(engine.getAlbumTracks("album")).toEqual(snapshot().tracks);
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
    const engine = new MetadataEngine();
    await engine.restore(account);
    storage.getDirectory.mockClear();
    engine.setClient(new SubsonicClient(auth));
    expect(engine.status).toBe("refreshing");
    expect(engine.getTrack("song")?.title).toBe("Song");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    resolve(response({ indexes: { lastModified: 10 } }));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(storage.getDirectory).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    engine.destroy();
  });

  it("persists a complete normalized snapshot and restores it in a new engine", async () => {
    const storage = installMetadataStorage();
    vi.stubGlobal("fetch", serveLibrary());
    const engine = new MetadataEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(engine.getTrack("song")).toMatchObject({
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
    const restored = new MetadataEngine();
    await restored.restore(account);
    expect(restored.getTrack("song")?.mimeType).toBe("audio/flac");
    restored.destroy();
  });

  it("keeps cached data and reports warnings after refresh or persistence failure", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    vi.stubGlobal("fetch", serveLibrary());
    storage.failWrites = true;
    const engine = new MetadataEngine();
    await engine.restore(account);
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.warning).toBeInstanceOf(Error));
    expect(engine.getTrack("song")).toEqual(snapshot().tracks[0]);
    expect(engine.status).toBe("ready");
    engine.destroy();
    const restored = new MetadataEngine();
    await restored.restore(account);
    expect(restored.getTrack("song")).toEqual(snapshot().tracks[0]);
    restored.destroy();
  });

  it("does not read storage or fetch again when entering offline mode", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn(async () => response({ indexes: { lastModified: 10 } }));
    vi.stubGlobal("fetch", fetcher);
    const engine = new MetadataEngine();
    await engine.restore(account);
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    storage.getDirectory.mockClear();
    fetcher.mockClear();
    engine.setNetwork("offline");
    expect(engine.status).toBe("ready");
    expect(engine.getTrack("song")).toBeDefined();
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
    const engine = new MetadataEngine();
    await engine.restore(account);
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(storage.writes).toBe(0);
    engine.refresh();
    expect(engine.getTrack("song")).toBeDefined();
    await vi.waitFor(() => expect(storage.writes).toBe(1));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));
    expect(engine.getTrack("song")).toBeUndefined();
    expect(engine.getAlbumTracks("album").map((track) => track.id)).toEqual(["new-song"]);
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
    const engine = new MetadataEngine();
    await engine.restore(account);
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    engine.setNetwork("offline");
    resolve(response({ indexes: { lastModified: 20 } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.status).toBe("ready");
    expect(engine.getTrack("song")).toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(storage.writes).toBe(0);
    engine.destroy();
  });

  it("reports missing or invalid snapshots offline without touching IndexedDB", async () => {
    const storage = installMetadataStorage();
    const indexedDB = { open: vi.fn() };
    vi.stubGlobal("indexedDB", indexedDB);
    const engine = new MetadataEngine();
    engine.setNetwork("offline");
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("error"));
    expect(engine.getArtists()).toEqual([]);
    expect(indexedDB.open).not.toHaveBeenCalled();
    engine.destroy();
    await storage.seed(account, { data: [] });
    const invalid = new MetadataEngine();
    await invalid.restore(account);
    expect(invalid.status).toBe("error");
    expect(invalid.getArtists()).toEqual([]);
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
    const engine = new MetadataEngine();
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await engine.restore(other);
    resolve(response({ indexes: { lastModified: 20 } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getArtist("artist")?.name).toBe("Other");
    expect(storage.files.size).toBe(1);
    expect(storage.writes).toBe(0);
    engine.destroy();
  });
});

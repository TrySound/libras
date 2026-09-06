import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataEngine } from "./metadata-engine";
import { SubsonicClient } from "./subsonic-client";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

const artist = { id: "artist-1", name: "Artist", albums: [] };

function installDatabase(record?: unknown) {
  const records = new Map<string, unknown>();
  if (record) records.set(`${auth.host}\n${auth.username}`, record);

  const database = {
    close() {},
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const transaction: Record<string, unknown> & {
        objectStore: () => {
          get: (key: string) => Record<string, unknown>;
          put: (value: unknown, key: string) => void;
        };
      } = {
        objectStore: () => ({
          get(key) {
            const request: Record<string, unknown> = {};
            queueMicrotask(() => {
              request.result = records.get(key);
              (request.onsuccess as (() => void) | undefined)?.();
            });
            return request;
          },
          put(value, key) {
            records.set(key, value);
            queueMicrotask(() => (transaction.oncomplete as (() => void) | undefined)?.());
          },
        }),
      };
      return transaction;
    },
  };

  vi.stubGlobal("indexedDB", {
    open() {
      const request: Record<string, unknown> = { result: database };
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
      return request;
    },
  });
}

function response(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("metadata engine", () => {
  it("loads an existing library without network access", async () => {
    installDatabase({ data: [artist], lastModified: 1, savedAt: 1 });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new MetadataEngine();

    engine.setNetwork("offline");
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));

    expect(engine.getArtists()).toEqual([artist]);
    expect(engine.status).toBe("ready");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("provides indexed metadata access", async () => {
    const track = { id: "track-1", title: "Track" };
    const album = { id: "album-1", name: "Album", tracks: [track] };
    installDatabase({
      data: [{ id: "artist-1", name: "Artist", albums: [album] }],
      lastModified: 1,
      savedAt: 1,
    });
    const engine = new MetadataEngine();
    engine.setNetwork("offline");
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));

    expect(engine.getArtists()).toEqual([{ id: "artist-1", name: "Artist", albums: [album] }]);
    expect(engine.getArtist("artist-1")).toEqual({
      id: "artist-1",
      name: "Artist",
      albums: [album],
    });
    expect(engine.getAlbum("album-1")).toEqual(album);
    expect(engine.getTrack("track-1")).toEqual(track);
    expect(engine.getArtist("missing")).toBeUndefined();
    expect(engine.getAlbum("missing")).toBeUndefined();
    expect(engine.getTrack("missing")).toBeUndefined();
  });

  it("fails offline when no library is available", async () => {
    installDatabase();
    const engine = new MetadataEngine();

    engine.setNetwork("offline");
    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("error"));
    expect(engine.error).toBeInstanceOf(Error);
  });

  it("publishes cached metadata before a slow online revalidation completes", async () => {
    installDatabase({ data: [artist], lastModified: 10, savedAt: 1 });
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engine = new MetadataEngine();
    try {
      engine.setClient(new SubsonicClient(auth));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      expect(engine.status).toBe("refreshing");
      expect(engine.getArtists()).toEqual([artist]);
      resolve(response({ indexes: { lastModified: 10 } }));
      await vi.waitFor(() => expect(engine.status).toBe("ready"));
      expect(engine.getArtists()).toEqual([artist]);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      engine.destroy();
    }
  });

  it("keeps existing metadata when the server reports no changes", async () => {
    installDatabase({ data: [artist], lastModified: 10, savedAt: 1 });
    const fetcher = vi.fn(async () => response({ indexes: { lastModified: 10 } }));
    vi.stubGlobal("fetch", fetcher);
    const engine = new MetadataEngine();

    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));

    expect(engine.getArtists()).toEqual([artist]);
    expect(engine.status).toBe("ready");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fetches and publishes a fresh library", async () => {
    installDatabase();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getIndexes")) return response({ indexes: { lastModified: 20 } });
      if (url.includes("getArtists")) {
        return response({ artists: { index: [{ artist: [{ id: "artist-1", name: "Artist" }] }] } });
      }
      if (url.includes("getAlbumList2")) return response({ albumList2: { album: [] } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const engine = new MetadataEngine();

    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.status).toBe("ready"));

    expect(engine.getArtists()).toEqual([artist]);
    expect(engine.status).toBe("ready");
  });

  it("retains existing metadata and exposes refresh warnings", async () => {
    installDatabase({ data: [artist], lastModified: 10, savedAt: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("Unavailable"))),
    );
    const engine = new MetadataEngine();

    engine.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(engine.warning).toBeInstanceOf(Error));

    expect(engine.getArtists()).toEqual([artist]);
    expect(engine.status).toBe("ready");
    expect(engine.warning).toBeInstanceOf(Error);
  });
});

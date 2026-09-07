import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverEngine } from "./cover-engine";
import type { MetadataAccount, MetadataSnapshot } from "./metadata-engine";
import { SubsonicClient } from "./subsonic-client";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
const offline = { allowNetwork: false };
const online = { allowNetwork: true };
function snapshot(): MetadataSnapshot {
  return {
    account,
    lastModified: 10,
    savedAt: 100,
    artists: [{ id: "artist", name: "Artist", artworkId: "artist-cover", genres: [] }],
    albums: [
      { id: "album", title: "Album", artistId: "artist", artworkId: "album-cover", genres: [] },
    ],
    tracks: [
      {
        id: "one",
        title: "One",
        artistId: "artist",
        albumId: "album",
        artworkId: "track-cover",
        number: 1,
        genres: [],
      },
      { id: "two", title: "Two", artistId: "artist", albumId: "album", number: 2, genres: [] },
    ],
  };
}
function catalog() {
  return {
    account,
    metadataSavedAt: 100,
    artists: [{ id: "artist", candidates: ["artist-cover", "album-cover", "track-cover"] }],
    albums: [{ id: "album", candidates: ["album-cover", "track-cover"] }],
    tracks: [
      { id: "one", candidates: ["track-cover", "album-cover", "artist-cover"] },
      { id: "two", candidates: ["album-cover", "artist-cover"] },
    ],
    images: [
      {
        id: "album-cover",
        fileName: "11111111-1111-1111-1111-111111111111.image",
        type: "image/jpeg",
        size: 5,
        cachedAt: 100,
      },
    ],
  };
}
async function catalogName(identity = account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${identity.host}\n${identity.username}`),
  );
  return `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
}
function installOpfs() {
  const storage = {
    files: new Map<string, File>(),
    failCatalogWrites: false,
    beforeCatalogWrite: undefined as (() => void) | undefined,
    writes: 0,
    reads: vi.fn(),
    async seed(value: unknown = catalog(), identity = account) {
      const name = await catalogName(identity);
      storage.files.set(name, new File([JSON.stringify(value)], name));
    },
    async json(identity = account) {
      return JSON.parse(await storage.files.get(await catalogName(identity))!.text());
    },
    image() {
      const name = catalog().images[0].fileName;
      storage.files.set(name, new File(["image"], name));
    },
  };
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!storage.files.has(name) && !options?.create)
        throw new DOMException("Missing", "NotFoundError");
      if (!storage.files.has(name)) storage.files.set(name, new File([], name));
      return {
        async getFile() {
          storage.reads(name);
          const file = storage.files.get(name);
          if (!file) throw new DOMException("Missing", "NotFoundError");
          return file;
        },
        async createWritable() {
          let value: BlobPart = "";
          return {
            async write(data: BlobPart) {
              if (name.endsWith(".json")) storage.beforeCatalogWrite?.();
              if (name.endsWith(".json") && storage.failCatalogWrites)
                throw new Error("Storage full");
              value = data;
            },
            async close() {
              storage.writes++;
              storage.files.set(name, new File([value], name));
            },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      storage.files.delete(name);
    },
  };
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: vi.fn(async () => ({ getDirectoryHandle: vi.fn(async () => directory) })),
    },
  });
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:cover-${++sequence}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return storage;
}
const engines: CoverEngine[] = [];
function engine(metadata: { snapshot: MetadataSnapshot | undefined } = { snapshot: snapshot() }) {
  const result = new CoverEngine(metadata);
  engines.push(result);
  return result;
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cover engine", () => {
  it("reads metadata on explicit refresh without effects or metadata listeners", async () => {
    const storage = installOpfs();
    const metadata: { snapshot: MetadataSnapshot | undefined } = { snapshot: undefined };
    const covers = engine(metadata);
    await covers.refresh();
    expect(storage.files.size).toBe(0);
    metadata.snapshot = snapshot();
    expect(storage.files.size).toBe(0);
    await covers.refresh();
    expect((await storage.json()).metadataSavedAt).toBe(100);
    metadata.snapshot = { ...snapshot(), savedAt: 200, albums: [], tracks: [] };
    expect((await storage.json()).metadataSavedAt).toBe(100);
    await covers.refresh();
    expect((await storage.json()).metadataSavedAt).toBe(200);
  });

  it("persists complete, deduplicated entity references without downloading images", async () => {
    const storage = installOpfs();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const covers = engine();
    await covers.refresh();
    expect(await storage.json()).toEqual({ ...catalog(), images: [] });
    expect(storage.files.size).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    const writes = storage.writes;
    storage.reads.mockClear();
    await covers.refresh();
    expect(storage.writes).toBe(writes);
    expect(storage.reads).not.toHaveBeenCalled();
  });

  it("restores all references and cache flags without a client, reading image bytes lazily", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const bytes = vi.spyOn(File.prototype, "arrayBuffer");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const covers = engine({ snapshot: undefined });
    await covers.restore(account);
    expect(bytes).not.toHaveBeenCalled();
    const artist = covers.getArtistCover("artist", offline);
    const album = covers.getAlbumCover("album", offline);
    const track = covers.getTrackCover("one", offline);
    expect(artist.cached).toBe(true);
    expect(album.cached).toBe(true);
    expect(track.artworkId).toBe("album-cover");
    expect(covers.getTrackCover("one", offline)).toBe(track);
    await vi.waitFor(() => expect(track.source).toBe("blob:cover-1"));
    expect(artist.source).toBe(track.source);
    expect(album.source).toBe(track.source);
    expect(bytes).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).not.toBeInstanceOf(File);
    storage.reads.mockClear();
    for (let i = 0; i < 20; i++) expect(covers.getArtistCover("artist", offline).cached).toBe(true);
    expect(storage.reads).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("waits for catalog restoration before choosing an online URL", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const covers = engine();
    covers.setClient(new SubsonicClient(auth));
    const cover = covers.getCover("album-cover", online);
    expect(cover.source).toBeUndefined();
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps track references bounded instead of repeating entire artist libraries", async () => {
    const storage = installOpfs();
    const data = snapshot();
    data.tracks = Array.from({ length: 100 }, (_, index) => ({
      ...data.tracks[0],
      id: String(index),
      artworkId: `cover-${index}`,
    }));
    await engine({ snapshot: data }).refresh();
    expect(
      (await storage.json()).tracks.every(
        (track: { candidates: string[] }) => track.candidates.length <= 4,
      ),
    ).toBe(true);
  });

  it("discards superseded reference writes without leaving an empty catalog", async () => {
    const storage = installOpfs();
    const metadata = { snapshot: snapshot() };
    const covers = engine(metadata);
    let replacement: Promise<void> | undefined;
    storage.beforeCatalogWrite = () => {
      storage.beforeCatalogWrite = undefined;
      metadata.snapshot = { ...snapshot(), savedAt: 200, albums: [], tracks: [] };
      replacement = covers.refresh();
    };
    await covers.refresh();
    await replacement;
    expect((await storage.json()).metadataSavedAt).toBe(200);
    expect((await storage.json()).tracks).toEqual([]);
    expect(covers.error).toBeUndefined();
  });

  it("uses candidate priority rather than metadata record order", async () => {
    const storage = installOpfs();
    const data = snapshot();
    data.albums.push({
      id: "earlier",
      title: "Earlier",
      year: 2000,
      artistId: "artist",
      artworkId: "earlier-cover",
      genres: [],
    });
    await engine({ snapshot: data }).refresh();
    expect((await storage.json()).artists[0].candidates).toEqual([
      "artist-cover",
      "earlier-cover",
      "album-cover",
      "track-cover",
    ]);
  });

  it("removes missing-file records once at startup, retaining references", async () => {
    const storage = installOpfs();
    await storage.seed();
    const covers = engine();
    await covers.restore(account);
    expect(covers.getAlbumCover("album", offline).cached).toBe(false);
    expect(covers.getAlbumCover("album", offline).artworkId).toBe("album-cover");
    expect((await storage.json()).images).toEqual([]);
    storage.reads.mockClear();
    expect(covers.getTrackCover("one", offline).source).toBeUndefined();
    expect(storage.reads).not.toHaveBeenCalled();
  });

  it("rebuilds references on metadata replacement while retaining downloaded images", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const metadata = { snapshot: snapshot() };
    const covers = engine(metadata);
    await covers.restore(account);
    const old = covers.getTrackCover("one", offline);
    await vi.waitFor(() => expect(old.source).toBeDefined());
    metadata.snapshot = { ...snapshot(), savedAt: 200, albums: [], tracks: [] };
    await covers.refresh();
    expect(old.source).toBeUndefined();
    expect(old.cached).toBe(false);
    expect((await storage.json()).tracks).toEqual([]);
    expect((await storage.json()).images).toEqual(catalog().images);
    expect(covers.getCover("album-cover", offline).cached).toBe(true);
  });

  it("resolves online URLs and shares one download across entity and cache-only handles", async () => {
    const storage = installOpfs();
    const covers = engine();
    await covers.refresh();
    covers.setClient(new SubsonicClient(auth));
    const album = covers.getAlbumCover("album", online);
    const track = covers.getTrackCover("two", online);
    const cached = covers.getTrackCover("two", offline);
    const artist = covers.getArtistCover("artist", offline);
    const notify = vi.fn();
    const unsubscribe = covers.subscribe(notify);
    const fetcher = vi.fn(
      async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    await vi.waitFor(() => expect(album.source).toContain("/rest/getCoverArt.view?"));
    expect(new URL(album.source!).searchParams.get("id")).toBe("album-cover");
    expect(cached.source).toBeUndefined();
    expect(album.cache()).toBeUndefined();
    track.cache();
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    expect(artist.source).toBe(cached.source);
    expect(cached.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalled();
    unsubscribe();
    const saved = await storage.json();
    expect(saved.images).toHaveLength(1);
    expect(storage.files.get(saved.images[0].fileName)?.size).toBe(5);
    expect(JSON.stringify(saved)).not.toContain(auth.token);
    expect(JSON.stringify(saved)).not.toContain(auth.salt);
    expect(JSON.stringify(saved)).not.toContain("getCoverArt");
    const restored = engine();
    await restored.restore(account);
    expect(restored.getTrackCover("two", offline).cached).toBe(true);
  });

  it.each([200, 304])(
    "revalidates cached images with conditional headers (HTTP %s)",
    async (status) => {
      const storage = installOpfs();
      await storage.seed({
        ...catalog(),
        images: [{ ...catalog().images[0], etag: '"old"', lastModified: "Yesterday" }],
      });
      storage.image();
      const fetcher = vi.fn(
        async (..._args: Parameters<typeof fetch>) =>
          new Response(status === 200 ? "updated" : null, {
            status,
            headers: { "Content-Type": "image/jpeg", ETag: '"new"' },
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const covers = engine();
      await covers.restore(account);
      const cached = covers.getAlbumCover("album", offline);
      await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
      covers.setClient(new SubsonicClient(auth));
      const onlineCover = covers.getAlbumCover("album", online);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
      expect(headers.get("If-None-Match")).toBe('"old"');
      expect(headers.get("If-Modified-Since")).toBe("Yesterday");
      if (status === 200) {
        await vi.waitFor(() => expect(onlineCover.source).toBe("blob:cover-2"));
        expect(cached.source).toBe(onlineCover.source);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
        expect((await storage.json()).images[0].etag).toBe('"new"');
      } else {
        expect(cached.source).toBe("blob:cover-1");
        expect(storage.writes).toBe(0);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps the previous image and catalog after a failed replacement", async () => {
    const storage = installOpfs();
    const original = { ...catalog(), images: [{ ...catalog().images[0], etag: '"old"' }] };
    await storage.seed(original);
    storage.image();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("updated", { headers: { "Content-Type": "image/jpeg" } })),
    );
    const covers = engine();
    await covers.restore(account);
    storage.failCatalogWrites = true;
    covers.setClient(new SubsonicClient(auth));
    const cover = covers.getAlbumCover("album", online);
    await vi.waitFor(() => expect(covers.error).toBeInstanceOf(Error));
    expect(cover.source).toBe("blob:cover-1");
    expect(await storage.json()).toEqual(original);
    expect(await storage.files.get(original.images[0].fileName)!.text()).toBe("image");
    expect(storage.files.size).toBe(2);
  });

  it("rejects corrupt or foreign catalogs without overwriting them", async () => {
    const storage = installOpfs();
    const foreign = { ...catalog(), account: { ...account, username: "other" } };
    await storage.seed(foreign);
    const covers = engine();
    await covers.restore(account);
    expect(covers.error).toBeInstanceOf(Error);
    await covers.refresh();
    expect(storage.writes).toBe(0);
    expect(await storage.json()).toEqual(foreign);
  });

  it("does not migrate legacy image files or sidecars", async () => {
    const storage = installOpfs();
    storage.files.set("old.image", new File(["image"], "old.image"));
    storage.files.set("old.json", new File(['{"type":"image/jpeg"}'], "old.json"));
    const covers = engine();
    await covers.refresh();
    expect(covers.getAlbumCover("album", offline).cached).toBe(false);
    expect(storage.files.has("old.image")).toBe(true);
    expect(storage.files.has("old.json")).toBe(true);
    expect((await storage.json()).images).toEqual([]);
  });

  it("does not publish or persist stale downloads after switching accounts", async () => {
    const storage = installOpfs();
    const metadata = { snapshot: snapshot() };
    const covers = engine(metadata);
    await covers.refresh();
    covers.setClient(new SubsonicClient(auth));
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
    const old = covers.getAlbumCover("album", online);
    await vi.waitFor(() => expect(old.source).toBeDefined());
    old.cache();
    const other: MetadataAccount = { ...account, username: "other" };
    metadata.snapshot = { ...snapshot(), account: other };
    await covers.refresh();
    resolve(new Response("image", { headers: { "Content-Type": "image/jpeg" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(old.source).toBeUndefined();
    expect((await storage.json()).images).toEqual([]);
    expect((await storage.json(other)).images).toEqual([]);
    expect([...storage.files.keys()].some((name) => name.endsWith(".image"))).toBe(false);
  });

  it("merges concurrent downloads from different tabs under the same Web Lock", async () => {
    const storage = installOpfs();
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => {
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    });
    Object.assign(navigator, { locks: { request } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } })),
    );
    const first = engine();
    const second = engine();
    await Promise.all([first.refresh(), second.refresh()]);
    first.setClient(new SubsonicClient(auth));
    second.setClient(new SubsonicClient(auth));
    const one = first.getCover("one-cover", online);
    const two = second.getCover("two-cover", online);
    await vi.waitFor(() => {
      expect(one.source).toBeDefined();
      expect(two.source).toBeDefined();
    });
    one.cache();
    two.cache();
    await vi.waitFor(() => {
      expect(one.cached).toBe(true);
      expect(two.cached).toBe(true);
    });
    expect((await storage.json()).images.map((image: { id: string }) => image.id).sort()).toEqual([
      "one-cover",
      "two-cover",
    ]);
    expect(new Set(request.mock.calls.map(([name]) => name)).size).toBe(1);
  });
});

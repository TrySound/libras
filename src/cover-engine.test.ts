import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverEngine } from "./cover.svelte";
import { Storage } from "./storage";
import type { MetadataSnapshot } from "./metadata.svelte";
import type { Account } from "./schema";
import { Network } from "./network.svelte";
import { Memory } from "./memory-test-helpers.svelte";

function createConnection(credentials: Parameters<Network["prepare"]>[0]) {
  const network = new Network();
  const client = network.prepare(credentials);
  const artwork = network.accept(client).artwork;
  return {
    account: artwork.account,
    signal: artwork.signal,
    url: (id: string, size: number) => artwork.url(id, size),
    read: (id: string, options: Parameters<typeof artwork.read>[1]) => artwork.read(id, options),
    abort: () => network.setMode("offline"),
  };
}

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
function library(data?: MetadataSnapshot) {
  const memory = new Memory();
  // CoverEngine consumes the workspace selected by Session.
  memory.account = data?.account ?? account;
  let savedAt: number | undefined;
  const publish = (data: MetadataSnapshot) => {
    memory.account = data.account;
    memory.artists = new Map(data.artists.map((artist) => [artist.id, artist]));
    memory.albums = new Map(data.albums.map((album) => [album.id, album]));
    memory.tracks = new Map(data.tracks.map((track) => [track.id, track]));
    memory.artistAlbums = new Map(
      data.artists.map((artist) => [
        artist.id,
        data.albums
          .filter((album) => album.artistId === artist.id)
          .sort(
            (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title),
          ),
      ]),
    );
    memory.albumTracks = new Map(
      data.albums.map((album) => [
        album.id,
        data.tracks
          .filter((track) => track.albumId === album.id)
          .sort(
            (a, b) =>
              (a.disc ?? 1) - (b.disc ?? 1) ||
              (a.number ?? Infinity) - (b.number ?? Infinity) ||
              a.title.localeCompare(b.title),
          ),
      ]),
    );
    savedAt = data.savedAt;
  };
  if (data) publish(data);
  return {
    memory,
    get savedAt() {
      return savedAt;
    },
    publish,
  };
}
function engine(metadata = library(snapshot()), restore = true) {
  const result = new CoverEngine(metadata.memory, metadata);
  engines.push(result);
  if (restore) void result.restore(new Storage(metadata.memory.account!));
  return result;
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cover engine", () => {
  it("uses injected storage while retaining object URL ownership", async () => {
    installOpfs();
    const data = catalog();
    const access = {
      account,
      read: vi.fn(async () => data),
      update: vi.fn(async () => data),
      readImage: vi.fn(async () => new Blob(["image"], { type: "image/jpeg" })),
      saveImage: vi.fn(async () => undefined),
    };
    const storage = { account, artwork: access };
    const covers = engine(library(), false);
    await covers.restore(storage);
    const cover = covers.ensureAlbumCover("album", offline);
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    expect(access.read).toHaveBeenCalledOnce();
    expect(access.readImage).toHaveBeenCalledWith(data.images[0]);
    expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
    covers.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
  });

  it("detaches network handles without discarding cached artwork or accepting late downloads", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const metadata = library();
    const covers = engine(metadata);
    await covers.restore(new Storage(account));
    const cached = covers.ensureAlbumCover("album", offline);
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    const images = metadata.memory.images;
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = createConnection(auth);
    covers.setConnection(client);
    metadata.memory.albumArtwork = new Map(metadata.memory.albumArtwork).set("remote", ["remote"]);
    const remote = covers.ensureAlbumCover("remote", online);
    await vi.waitFor(() => expect(remote.source).toContain("getCoverArt"));
    remote.cache();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    client.abort();
    covers.setConnection(undefined);
    expect(remote.source).toBeUndefined();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    resolve(new Response("late image", { headers: { "Content-Type": "image/jpeg" } }));
    await Promise.resolve();
    await Promise.resolve();
    remote.cache();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cached.source).toBe("blob:cover-1");
    expect(metadata.memory.images).toBe(images);
    expect(storage.writes).toBe(0);
  });

  it("reads metadata on explicit refresh without effects or metadata listeners", async () => {
    const storage = installOpfs();
    const metadata = library();
    const covers = engine(metadata);
    await covers.refresh();
    expect(storage.files.size).toBe(0);
    metadata.publish(snapshot());
    expect(storage.files.size).toBe(0);
    await covers.refresh();
    expect((await storage.json()).metadataSavedAt).toBe(100);
    metadata.publish({ ...snapshot(), savedAt: 200, albums: [], tracks: [] });
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
    const metadata = library();
    const covers = engine(metadata);
    await covers.restore(new Storage(account));
    expect([...metadata.memory.artistArtwork]).toEqual([
      ["artist", catalog().artists[0].candidates],
    ]);
    expect([...metadata.memory.albumArtwork]).toEqual([["album", catalog().albums[0].candidates]]);
    expect(metadata.memory.trackArtwork.get("one")).toEqual(catalog().tracks[0].candidates);
    expect([...metadata.memory.images.values()]).toEqual(catalog().images);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(bytes).not.toHaveBeenCalled();
    const artist = covers.ensureArtistCover("artist", offline);
    const album = covers.ensureAlbumCover("album", offline);
    const track = covers.ensureTrackCover("one", offline);
    await vi.waitFor(() => expect(artist.source).toMatch(/^blob:/));
    await vi.waitFor(() => expect(album.source).toBe(artist.source));
    await vi.waitFor(() => expect(track.source).toBe(album.source));
    expect(covers.ensureTrackCover("one", offline)).toBe(track);
    await vi.waitFor(() => expect(track.source).toBe("blob:cover-1"));
    expect(artist.source).toBe(track.source);
    expect(album.source).toBe(track.source);
    expect(bytes).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).not.toBeInstanceOf(File);
    storage.reads.mockClear();
    expect(covers.ensureArtistCover("artist", offline)).toBe(artist);
    expect(storage.reads).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not install late image bytes after the selected account changes", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const metadata = library(snapshot());
    const covers = engine(metadata);
    await covers.restore(new Storage(account));
    let resolve!: (bytes: ArrayBuffer) => void;
    vi.spyOn(File.prototype, "arrayBuffer").mockImplementationOnce(
      () =>
        new Promise<ArrayBuffer>((done) => {
          resolve = done;
        }),
    );
    const cover = covers.ensureAlbumCover("album", offline);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    metadata.memory.account = { ...account, username: "other" };
    resolve(new TextEncoder().encode("image").buffer);
    await new Promise((done) => setTimeout(done, 0));
    expect(cover.source).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await covers.restore(new Storage(metadata.memory.account!));
    expect(metadata.memory.images.size).toBe(0);
    expect(metadata.memory.trackArtwork.size).toBe(0);
  });

  it("waits for catalog restoration before choosing an online URL", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const covers = engine();
    covers.setConnection(createConnection(auth));
    const cover = covers.ensureAlbumCover("album", online);
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
    await engine(library(data)).refresh();
    expect(
      (await storage.json()).tracks.every(
        (track: { candidates: string[] }) => track.candidates.length <= 4,
      ),
    ).toBe(true);
  });

  it("discards superseded reference writes without leaving an empty catalog", async () => {
    const storage = installOpfs();
    const metadata = library(snapshot());
    const covers = engine(metadata);
    let replacement: Promise<void> | undefined;
    storage.beforeCatalogWrite = () => {
      storage.beforeCatalogWrite = undefined;
      metadata.publish({ ...snapshot(), savedAt: 200, albums: [], tracks: [] });
      replacement = covers.refresh();
    };
    await covers.refresh();
    await replacement;
    expect((await storage.json()).metadataSavedAt).toBe(200);
    expect((await storage.json()).tracks).toEqual([]);
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
    await engine(library(data)).refresh();
    expect((await storage.json()).artists[0].candidates).toEqual([
      "artist-cover",
      "earlier-cover",
      "album-cover",
      "track-cover",
    ]);
  });

  it("removes missing-file records on first access, retaining references", async () => {
    const storage = installOpfs();
    await storage.seed();
    const covers = engine();
    await covers.restore(new Storage(account));
    const cover = covers.ensureAlbumCover("album", offline);
    expect(cover.source).toBeUndefined();
    await vi.waitFor(async () => expect((await storage.json()).images).toEqual([]));
    storage.reads.mockClear();
    expect(covers.ensureTrackCover("one", offline).source).toBeUndefined();
    expect(storage.reads).not.toHaveBeenCalled();
  });

  it("rebuilds references on metadata replacement while retaining downloaded images", async () => {
    const storage = installOpfs();
    await storage.seed();
    storage.image();
    const metadata = library(snapshot());
    const covers = engine(metadata);
    await covers.restore(new Storage(account));
    const old = covers.ensureTrackCover("one", offline);
    await vi.waitFor(() => expect(old.source).toBeDefined());
    const previousReferences = metadata.memory.trackArtwork;
    const previousImages = metadata.memory.images;
    metadata.publish({ ...snapshot(), savedAt: 200, albums: [], tracks: [] });
    await covers.refresh();
    expect(old.source).toBeUndefined();
    expect(metadata.memory.trackArtwork.size).toBe(0);
    expect(previousReferences.has("one")).toBe(true);
    expect(metadata.memory.images).not.toBe(previousImages);
    expect([...metadata.memory.images.values()]).toEqual([...previousImages.values()]);
    expect((await storage.json()).tracks).toEqual([]);
    expect((await storage.json()).images).toEqual(catalog().images);
  });

  it("resolves online URLs and shares one download across entity and cache-only handles", async () => {
    const storage = installOpfs();
    const metadata = library(snapshot());
    const covers = engine(metadata);
    await covers.refresh();
    covers.setConnection(createConnection(auth));
    const album = covers.ensureAlbumCover("album", online);
    const track = covers.ensureTrackCover("two", online);
    const cached = covers.ensureTrackCover("two", offline);
    const artist = covers.ensureArtistCover("artist", offline);
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
    expect(cached.source).toMatch(/^blob:/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalled();
    unsubscribe();
    const saved = await storage.json();
    expect(saved.images).toHaveLength(1);
    expect([...metadata.memory.images.values()]).toEqual(saved.images);
    const published = JSON.stringify([...metadata.memory.images.values()]);
    expect(published).not.toContain("blob:");
    expect(published).not.toContain(auth.token);
    expect(published).not.toContain(auth.salt);
    expect(published).not.toContain("getCoverArt");
    expect(storage.files.get(saved.images[0].fileName)?.size).toBe(5);
    expect(JSON.stringify(saved)).not.toContain(auth.token);
    expect(JSON.stringify(saved)).not.toContain(auth.salt);
    expect(JSON.stringify(saved)).not.toContain("getCoverArt");
    const restored = engine();
    await restored.restore(new Storage(account));
    const restoredCover = restored.ensureTrackCover("two", offline);
    await vi.waitFor(() => expect(restoredCover.source).toMatch(/^blob:/));
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
      await covers.restore(new Storage(account));
      const cached = covers.ensureAlbumCover("album", offline);
      await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
      covers.setConnection(createConnection(auth));
      const onlineCover = covers.ensureAlbumCover("album", online);
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
    const fetcher = vi.fn(
      async () => new Response("updated", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const covers = engine();
    await covers.restore(new Storage(account));
    storage.failCatalogWrites = true;
    covers.setConnection(createConnection(auth));
    const cover = covers.ensureAlbumCover("album", online);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await covers.restore(new Storage(account));
    expect(covers.ensureAlbumCover("album", offline).source).toBeUndefined();
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
    expect(covers.ensureAlbumCover("album", offline).source).toBeUndefined();
    expect(storage.files.has("old.image")).toBe(true);
    expect(storage.files.has("old.json")).toBe(true);
    expect((await storage.json()).images).toEqual([]);
  });

  it("does not publish or persist stale downloads after switching accounts", async () => {
    const storage = installOpfs();
    const metadata = library(snapshot());
    const covers = engine(metadata);
    await covers.refresh();
    covers.setConnection(createConnection(auth));
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
    const old = covers.ensureAlbumCover("album", online);
    await vi.waitFor(() => expect(old.source).toBeDefined());
    old.cache();
    const other: Account = { ...account, username: "other" };
    metadata.publish({ ...snapshot(), account: other });
    await covers.restore(new Storage(other));
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
    first.setConnection(createConnection(auth));
    second.setConnection(createConnection(auth));
    const one = first.ensureAlbumCover("album", online);
    const two = second.ensureTrackCover("one", online);
    await vi.waitFor(() => {
      expect(one.source).toBeDefined();
      expect(two.source).toBeDefined();
    });
    one.cache();
    two.cache();
    await vi.waitFor(() => {
      expect(one.source).toMatch(/^blob:/);
      expect(two.source).toMatch(/^blob:/);
    });
    expect((await storage.json()).images.map((image: { id: string }) => image.id).sort()).toEqual([
      "album-cover",
      "track-cover",
    ]);
    expect(new Set(request.mock.calls.map(([name]) => name)).size).toBe(1);
  });
});

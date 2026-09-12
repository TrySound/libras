import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { flushSync } from "svelte";
import { observeCover } from "./cover-reactivity.test.svelte";
import { CoverEngine } from "../src/cover.svelte";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { Network } from "../src/network.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
const image = (text = "image", validators = {}) => ({
  blob: new Blob([text]),
  type: "image/jpeg",
  ...validators,
});
function snapshot(): LibrarySnapshot {
  return {
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
function createConnection(credentials = auth) {
  const network = new Network();
  const artwork = network.accept(network.prepare(credentials)).artwork;
  return {
    ...artwork,
    account: artwork.account,
    signal: artwork.signal,
    url: (id: string, size: number) => artwork.url(id, size),
    read: (id: string, options: Parameters<typeof artwork.read>[1]) => artwork.read(id, options),
    abort: () => network.setMode("offline"),
  };
}
const engines: CoverEngine[] = [];
function installOpfs() {
  const disk = installDisk();
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:cover-${++sequence}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return disk;
}
async function engine(cache = new Cache(account)) {
  if (cache.savedAt === undefined) await cache.replaceLibrary(snapshot());
  const selection = new TestSelection();
  selection.cache = cache;
  const covers = new CoverEngine(selection);
  engines.push(covers);
  covers.activate();
  return { selection, cache, covers };
}
function catalog(disk: ReturnType<typeof installDisk>) {
  return JSON.parse([...disk.files].find(([path]) => path.endsWith("/images.json"))![1]);
}
async function seed(validators = {}) {
  const cache = new Cache(account);
  await cache.replaceLibrary(snapshot());
  await cache.saveImage("album-cover", image("image", validators));
  return cache;
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cover engine using Cache", () => {
  it("uses the selected Cache without persisting candidates or writing on refresh", async () => {
    const disk = installOpfs();
    const { cache, covers } = await engine();
    const candidates = vi.spyOn(cache, "albumArtwork", "get");
    const read = vi.spyOn(cache, "readImage");
    const writes = disk.state.writes;
    disk.getDirectory.mockClear();
    const cover = covers.ensureAlbumCover("album");
    await covers.refresh();
    expect(candidates).not.toHaveBeenCalled();
    expect(cover.source).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(disk.state.writes).toBe(writes);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect([...disk.files.keys()].some((path) => path.endsWith("images.json"))).toBe(false);
    expect(disk.blobs.size).toBe(0);
  });

  it("keeps thousands of cached covers idle through refresh and reconnect until demanded", async () => {
    installOpfs();
    const { cache, covers } = await engine(await seed());
    const library = snapshot();
    library.artists = Array.from({ length: 3804 }, (_, index) => ({
      id: `artist-${index}`,
      name: `Artist ${index}`,
      artworkId: "album-cover",
      genres: [],
    }));
    await cache.replaceLibrary({ ...library, savedAt: 200 });
    const read = vi.spyOn(cache, "readImage");
    const decode = vi.fn(async () => {});
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode() {
          return decode();
        }
      },
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const handles = library.artists.map((artist) => covers.ensureArtistCover(artist.id));
    await covers.refresh();
    covers.setConnection(createConnection());
    await covers.refresh();
    covers.setConnection(undefined);
    await cache.replaceLibrary({ ...library, savedAt: 300 });
    await covers.refresh();
    expect(handles.every((cover) => cover.source === undefined)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    handles[0].load();
    await vi.waitFor(() => expect(handles[0].source).toBe("blob:cover-1"));
    expect(read).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(handles.slice(1).every((cover) => cover.source === undefined)).toBe(true);
    handles[1].load();
    await vi.waitFor(() => expect(handles[1].source).toBe(handles[0].source));
    expect(read).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("restores through Cache and shares lazy offline bytes and object URLs across handles", async () => {
    const disk = installOpfs();
    await seed();
    const bytes = vi.spyOn(File.prototype, "arrayBuffer");
    const restored = new Cache(account);
    await restored.load();
    const { covers } = await engine(restored);
    expect(bytes).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    const read = vi.spyOn(restored, "readImage");
    const artist = covers.ensureArtistCover("artist");
    const album = covers.ensureAlbumCover("album");
    const track = covers.ensureTrackCover("one");
    artist.load();
    album.load();
    track.load();
    await vi.waitFor(() => expect(artist.source).toBe("blob:cover-1"));
    expect(album.source).toBe(artist.source);
    expect(track.source).toBe(artist.source);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("album-cover", expect.any(AbortSignal));
    expect(bytes).toHaveBeenCalledOnce();
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).not.toBeInstanceOf(File);
    disk.getDirectory.mockClear();
    for (let i = 0; i < 3; i++) {
      expect(covers.ensureTrackCover("one")).toBe(track);
      expect(track.source).toBe("blob:cover-1");
      track.load();
    }
    expect(disk.getDirectory).not.toHaveBeenCalled();
    covers.destroy();
    expect(track.source).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:cover-1");
  });

  it("refreshes existing handles after metadata replacement without rewriting images", async () => {
    const disk = installOpfs();
    const { covers, cache, selection } = await engine(await seed());
    const old = covers.ensureTrackCover("one");
    old.load();
    await vi.waitFor(() => expect(old.source).toBeDefined());
    const references = selection.cache!.trackArtwork;
    const images = selection.cache!.images;
    const saved = catalog(disk);
    await cache.replaceLibrary({ ...snapshot(), savedAt: 200, albums: [], tracks: [] });
    await covers.refresh();
    expect(old.source).toBeUndefined();
    expect(selection.cache!.trackArtwork.size).toBe(0);
    expect(references.has("one")).toBe(true);
    expect(selection.cache!.images).toBe(images);
    expect(catalog(disk)).toEqual(saved);
  });

  it("repairs missing bytes in Cache and chooses the next cached candidate", async () => {
    const disk = installOpfs();
    const cache = await seed();
    await cache.saveImage("track-cover", image("fallback"));
    const missing = cache.images.get("album-cover")!;
    disk.blobs.delete([...disk.blobs.keys()].find((path) => path.endsWith(missing.fileName))!);
    const { covers } = await engine(cache);
    const references = cache.albumArtwork;
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    expect(cache.images.has("album-cover")).toBe(false);
    expect(cache.albumArtwork).toBe(references);
    expect(catalog(disk).map((record: { id: string }) => record.id)).toEqual(["track-cover"]);
    expect(await (vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).text()).toBe("fallback");
  });

  it("reads a competing replacement on the first offline acquisition", async () => {
    installOpfs();
    const original = await seed();
    const read = vi.spyOn(original, "readImage");
    const { covers } = await engine(original);
    const competing = new Cache(account);
    await competing.load();
    await competing.saveImage("album-cover", image("replacement"));
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    expect(await (vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).text()).toBe(
      "replacement",
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("shares one explicit download without acquiring undemanded handles", async () => {
    const disk = installOpfs();
    const { covers, selection } = await engine();
    covers.setConnection(createConnection());
    const album = covers.ensureAlbumCover("album");
    const track = covers.ensureTrackCover("two");
    const cached = covers.ensureTrackCover("two");
    const artist = covers.ensureArtistCover("artist");
    expect(track).toBe(cached);
    const fetcher = vi.fn(
      async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const sources: (string | undefined)[] = [];
    const stop = observeCover(() => sources.push(cached.source));
    onTestFinished(stop);
    flushSync();
    expect(sources).toEqual([undefined]);
    await covers.refresh();
    expect(album.source).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(cached.source).toBeUndefined();
    album.load();
    track.load();
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    expect(artist.source).toBeUndefined();
    artist.load();
    await vi.waitFor(() => expect(artist.source).toBe(cached.source));
    expect(album.source).toBe(cached.source);
    expect(fetcher).toHaveBeenCalledOnce();
    flushSync();
    expect(sources.at(-1)).toBe("blob:cover-1");
    const saved = catalog(disk);
    expect(saved).toEqual([...selection.cache!.images.values()]);
    expect(Array.isArray(saved)).toBe(true);
    expect(disk.blobs.size).toBe(1);
    for (const secret of ["blob:", "getCoverArt", auth.token, auth.salt])
      expect(JSON.stringify(saved)).not.toContain(secret);
    const restored = new Cache(account);
    await restored.load();
    const other = await engine(restored);
    const cover = other.covers.ensureTrackCover("two");
    cover.load();
    await vi.waitFor(() => expect(cover.source).toMatch(/^blob:/));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("persists freshness across reloads and renews it on 304 without changing bytes or URLs", async () => {
    const disk = installOpfs();
    let now = Date.parse("2026-06-01T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn(
      async () =>
        new Response("image", {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "private, max-age=60",
            ETag: '"v1"',
          },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await engine();
    first.covers.setConnection(createConnection());
    first.covers.ensureAlbumCover("album").load();
    await vi.waitFor(() =>
      expect(first.cache.images.get("album-cover")?.freshUntil).toBe(now + 60_000),
    );
    first.covers.destroy();

    const restored = new Cache(account);
    await restored.load();
    const second = await engine(restored);
    second.covers.setConnection(createConnection());
    const cover = second.covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(cover.source).toMatch(/^blob:/));
    expect(fetcher).toHaveBeenCalledOnce();
    const source = cover.source;
    const record = restored.images.get("album-cover")!;
    const writes = disk.state.writes;
    now += 61_000;
    fetcher.mockImplementation(async () => new Response(null, { status: 304 }));
    // Reusing the same handle after expiry must revalidate without reconnecting.
    cover.load();
    await vi.waitFor(() =>
      expect(restored.images.get("album-cover")?.freshUntil).toBe(now + 60_000),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cover.source).toBe(source);
    expect(restored.images.get("album-cover")?.fileName).toBe(record.fileName);
    expect(disk.blobs.size).toBe(1);
    expect(disk.state.writes).toBe(writes + 1);
    const thirdCache = new Cache(account);
    await thirdCache.load();
    const third = await engine(thirdCache);
    third.covers.setConnection(createConnection());
    const thirdCover = third.covers.ensureAlbumCover("album");
    thirdCover.load();
    await vi.waitFor(() => expect(thirdCover.source).toMatch(/^blob:/));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries failed loads on the same handle without reconnecting", async () => {
    installOpfs();
    const { covers } = await engine();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary network failure"))
      .mockResolvedValueOnce(new Response("image", { headers: { "Content-Type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetcher);
    covers.setConnection(createConnection());
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await new Promise((done) => setTimeout(done, 0));
    expect(cover.source).toBeUndefined();
    cover.load();
    await vi.waitFor(() => expect(cover.source).toMatch(/^blob:/));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not refresh the catalog or notify unrelated handles when an image arrives", async () => {
    installOpfs();
    const { covers, cache } = await engine();
    const library = snapshot();
    library.artists.push({
      id: "unrelated",
      name: "Unrelated",
      artworkId: "unrelated-cover",
      genres: [],
    });
    await cache.replaceLibrary({ ...library, savedAt: 200 });
    const unrelated = covers.ensureArtistCover("unrelated");
    const cover = covers.ensureAlbumCover("album");
    await covers.refresh();
    const observe = vi.fn(() => unrelated.source);
    onTestFinished(observeCover(observe));
    flushSync();
    const refresh = vi.spyOn(covers, "refresh");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } })),
    );
    covers.setConnection(createConnection());
    cover.load();
    await vi.waitFor(() => expect(cache.images.has("album-cover")).toBe(true));
    flushSync();
    expect(cover.source).toMatch(/^blob:/);
    expect(refresh).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
  });

  it("keeps memory-only replacements when the old disk image is evicted", async () => {
    installOpfs();
    const { covers, cache } = await engine(await seed({ etag: '"old"' }));
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    const oldFile = cache.images.get("album-cover")!.fileName;
    const save = vi.spyOn(cache, "saveImage").mockRejectedValue(new Error("Storage full"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("new image", { headers: { "Content-Type": "image/jpeg" } })),
    );
    covers.setConnection(createConnection());
    cover.load();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(cover.source).toBe("blob:cover-2");
    await cache.evictImage("album-cover", oldFile);
    await covers.refresh();
    expect(cache.images.size).toBe(0);
    expect(cover.source).toBe("blob:cover-2");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:cover-2");
  });

  it.each(["success", "failure", "disconnect"])(
    "keeps the old source until replacement decode completes (%s)",
    async (outcome) => {
      installOpfs();
      const { covers, cache } = await engine(await seed({ etag: '"old"' }));
      const cover = covers.ensureAlbumCover("album");
      cover.load();
      await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
      const decoded = deferred<void>();
      const decode = vi.fn(() => decoded.promise);
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          decode() {
            return decode();
          }
        },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("new image", { headers: { "Content-Type": "image/jpeg" } })),
      );
      const save = vi.spyOn(cache, "saveImage");
      covers.setConnection(createConnection());
      cover.load();
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      expect(cover.source).toBe("blob:cover-1");
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      if (outcome === "disconnect") covers.setConnection(undefined);
      if (outcome === "failure") decoded.reject(new Error("Invalid image"));
      else decoded.resolve();
      await vi.waitFor(() =>
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(
          outcome === "success" ? "blob:cover-1" : "blob:cover-2",
        ),
      );
      expect(cover.source).toBe(outcome === "success" ? "blob:cover-2" : "blob:cover-1");
      if (outcome !== "success") expect(save).not.toHaveBeenCalled();
    },
  );

  it("keeps renewed freshness in memory if a 304 metadata write fails", async () => {
    const disk = installOpfs();
    const { covers, cache } = await engine(await seed({ etag: '"v1"', freshUntil: 0 }));
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(cover.source).toMatch(/^blob:/));
    const source = cover.source;
    disk.state.beforeWrite = (path) => {
      if (path.endsWith("/images.json")) throw new Error("Storage full");
    };
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 304,
          headers: { "Cache-Control": "max-age=600" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    covers.setConnection(createConnection());
    cover.load();
    await vi.waitFor(() => expect(cache.imagesError).toBeDefined());
    expect(cover.source).toBe(source);
    expect(cache.images.get("album-cover")?.freshUntil).toBe(0);
    covers.setConnection(undefined);
    covers.setConnection(createConnection());
    await covers.refresh();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cover.source).toBe(source);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it.each(["no-cache", "max-age=0"])(
    "revalidates %s even without validators",
    async (cacheControl) => {
      installOpfs();
      const { covers } = await engine(await seed({ cacheControl, freshUntil: 0 }));
      const fetcher = vi.fn(
        async () =>
          new Response("updated", {
            headers: { "Content-Type": "image/jpeg", "Cache-Control": cacheControl },
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      covers.setConnection(createConnection());
      const cover = covers.ensureAlbumCover("album");
      cover.load();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(cover.source).toMatch(/^blob:/));
    },
  );

  it.each([false, true])(
    "keeps no-store artwork in memory only (previous cache: %s)",
    async (existing) => {
      const disk = installOpfs();
      const { covers, cache } = await engine(existing ? await seed({ etag: '"old"' }) : undefined);
      const fetcher = vi.fn(
        async () =>
          new Response("private image", {
            headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store, max-age=600" },
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const save = vi.spyOn(cache, "saveImage");
      covers.setConnection(createConnection());
      const cover = covers.ensureAlbumCover("album");
      cover.load();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(cover.source).toBe(existing ? "blob:cover-2" : "blob:cover-1"));
      await vi.waitFor(() => expect(cache.images.size).toBe(0));
      await vi.waitFor(() => expect(disk.blobs.size).toBe(0));
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each([200, 304])("revalidates cached artwork using HTTP validators (%s)", async (status) => {
    const disk = installOpfs();
    const { covers } = await engine(await seed({ etag: '"old"', lastModified: "Yesterday" }));
    const writes = disk.state.writes;
    const cached = covers.ensureAlbumCover("album");
    cached.load();
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    const fetcher = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(status === 200 ? "updated" : null, {
          status,
          headers: { "Content-Type": "image/jpeg", ETag: '"new"' },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    covers.setConnection(createConnection());
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("If-None-Match")).toBe('"old"');
    expect(headers.get("If-Modified-Since")).toBe("Yesterday");
    if (status === 200) {
      await vi.waitFor(() => expect(cover.source).toBe("blob:cover-2"));
      expect(cached.source).toBe(cover.source);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
      expect(catalog(disk)[0].etag).toBe('"new"');
      expect(disk.blobs.size).toBe(1);
    } else {
      expect(cached.source).toBe("blob:cover-1");
      expect(disk.state.writes).toBe(writes);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    }
  });

  it("displays new bytes even when persisting a replacement fails", async () => {
    const disk = installOpfs();
    const { covers, cache } = await engine(await seed({ etag: '"old"' }));
    const original = catalog(disk);
    disk.state.beforeWrite = (path) => {
      if (path.endsWith("/images.json")) throw new Error("Storage full");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("new image", { headers: { "Content-Type": "image/jpeg" } })),
    );
    covers.setConnection(createConnection());
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(cache.imagesError).toBeDefined());
    expect(cover.source).toBe("blob:cover-2");
    expect(catalog(disk)).toEqual(original);
    expect(disk.blobs.size).toBe(1);
    expect(await [...disk.blobs.values()][0].text()).toBe("image");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
  });

  it.each(["slow", "failed"])(
    "publishes memory artwork independently of %s storage",
    async (storage) => {
      installOpfs();
      const { covers, cache } = await engine();
      const pending = deferred<Awaited<ReturnType<Cache["saveImage"]>>>();
      const save = vi.spyOn(cache, "saveImage").mockImplementation(() => pending.promise);
      const fetcher = vi.fn(
        async () =>
          new Response("image", {
            headers: { "Content-Type": "image/jpeg" },
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      covers.setConnection(createConnection());
      const cover = covers.ensureAlbumCover("album");
      await covers.refresh();
      expect(fetcher).not.toHaveBeenCalled();
      cover.load();
      cover.load();
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(cover.source).toBe("blob:cover-1");
      expect(cache.images.size).toBe(0);
      if (storage === "failed") pending.reject(new Error("Storage full"));
      else pending.resolve(undefined);
      await new Promise((done) => setTimeout(done, 0));
      await covers.refresh();
      covers.setConnection(undefined);
      covers.setConnection(createConnection());
      const shared = covers.ensureTrackCover("two");
      shared.load();
      await covers.refresh();
      expect(shared.source).toBe(cover.source);
      expect(cover.source).toBe("blob:cover-1");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
    },
  );

  it("resumes demanded artwork on reconnect without loading undemanded covers", async () => {
    installOpfs();
    const { covers } = await engine();
    const fetcher = vi.fn(
      async () =>
        new Response("image", {
          headers: { "Content-Type": "image/jpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const wanted = covers.ensureAlbumCover("album");
    covers.ensureTrackCover("one");
    wanted.load();
    await covers.refresh();
    expect(fetcher).not.toHaveBeenCalled();
    covers.setConnection(createConnection());
    await vi.waitFor(() => expect(wanted.source).toMatch(/^blob:/));
    expect(covers.ensureAlbumCover("album")).toBe(wanted);
    const source = wanted.source;
    covers.setConnection(undefined);
    await covers.refresh();
    expect(covers.ensureAlbumCover("album")).toBe(wanted);
    expect(wanted.source).toBe(source);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("detaches network handles but retains offline artwork and ignores late responses", async () => {
    const disk = installOpfs();
    const { covers, cache } = await engine(await seed());
    const library = snapshot();
    library.albums.push({
      id: "remote",
      title: "Remote",
      artistId: "artist",
      artworkId: "remote",
      genres: [],
    });
    await cache.replaceLibrary({ ...library, savedAt: 200 });
    const cached = covers.ensureAlbumCover("album");
    cached.load();
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    const images = cache.images;
    const writes = disk.state.writes;
    const response = deferred<Response>();
    const fetcher = vi.fn((_url: string, _options: RequestInit) => response.promise);
    vi.stubGlobal("fetch", fetcher);
    const connection = createConnection();
    covers.setConnection(connection);
    const remote = covers.ensureAlbumCover("remote");
    expect(remote.source).toBeUndefined();
    remote.load();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    connection.abort();
    covers.setConnection(undefined);
    expect(remote.source).toBeUndefined();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    response.resolve(new Response("late image"));
    await new Promise((done) => setTimeout(done, 0));
    remote.load();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cached.source).toBe("blob:cover-1");
    expect(cache.images).toBe(images);
    expect(disk.state.writes).toBe(writes);
  });

  it.each(["switch", "destroy"])("does not install late cached bytes after %s", async (action) => {
    installOpfs();
    const { covers, selection } = await engine(await seed());
    const bytes = deferred<ArrayBuffer>();
    const read = vi
      .spyOn(File.prototype, "arrayBuffer")
      .mockImplementationOnce(() => bytes.promise);
    const cover = covers.ensureAlbumCover("album");
    cover.load();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (action === "switch") {
      selection.cache = new Cache({ ...account, username: "other" });
      covers.activate();
    } else covers.destroy();
    bytes.resolve(new TextEncoder().encode("image").buffer);
    await new Promise((done) => setTimeout(done, 0));
    expect(cover.source).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["listener", "other"])(
    "isolates pending downloads when selecting another cache (%s)",
    async (username) => {
      const disk = installOpfs();
      const { covers, selection, cache } = await engine();
      const late = deferred<Response>();
      const fresh = deferred<Response>();
      const fetcher = vi.fn().mockReturnValueOnce(late.promise).mockReturnValueOnce(fresh.promise);
      vi.stubGlobal("fetch", fetcher);
      covers.setConnection(createConnection());
      const old = covers.ensureAlbumCover("album");
      expect(old.source).toBeUndefined();
      old.load();
      const next = new Cache({ ...account, username });
      await next.replaceLibrary(snapshot());
      selection.cache = next;
      covers.activate();
      covers.setConnection(createConnection({ ...auth, username }));
      const current = covers.ensureAlbumCover("album");
      expect(current.source).toBeUndefined();
      current.load();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      fresh.resolve(new Response("fresh", { headers: { "Content-Type": "image/jpeg" } }));
      await vi.waitFor(() => expect(current.source).toBe("blob:cover-1"));
      late.resolve(new Response("late", { headers: { "Content-Type": "image/jpeg" } }));
      await new Promise((done) => setTimeout(done, 0));
      expect(old.source).toBeUndefined();
      expect(cache.images.size).toBe(0);
      expect(next.images.size).toBe(1);
      expect(disk.blobs.size).toBe(1);
      expect(await [...disk.blobs.values()][0].text()).toBe("fresh");
    },
  );

  it.each(["beforeWrite", "afterClose"] as const)(
    "retains memory artwork when persistence is cancelled at catalog %s",
    async (stage) => {
      const disk = installOpfs();
      const { covers, cache } = await engine();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } })),
      );
      covers.setConnection(createConnection());
      disk.state[stage] = (path) => {
        if (path.endsWith("/images.json")) covers.setConnection(undefined);
      };
      const save = vi.spyOn(cache, "saveImage");
      const cover = covers.ensureAlbumCover("album");
      cover.load();
      expect(cover.source).toBeUndefined();
      cover.load();
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      await expect(save.mock.results[0].value).rejects.toMatchObject({ name: "AbortError" });
      expect(cover.source).toBe("blob:cover-1");
      expect(cache.images.size).toBe(0);
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
      expect(disk.blobs.size).toBe(stage === "afterClose" ? 1 : 0);
      if (stage === "afterClose") {
        const restored = new Cache(account);
        await restored.load();
        expect(await (await restored.readImage("album-cover"))!.blob.text()).toBe("image");
      }
    },
  );

  it.each(["album", "track"])(
    "adopts concurrent image commits across tabs (%s)",
    async (entity) => {
      const disk = installOpfs();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } })),
      );
      const first = await engine();
      const second = await engine();
      first.covers.setConnection(createConnection());
      second.covers.setConnection(createConnection());
      const one = first.covers.ensureAlbumCover("album");
      const two =
        entity === "album"
          ? second.covers.ensureAlbumCover("album")
          : second.covers.ensureTrackCover("one");

      one.load();
      two.load();
      await vi.waitFor(() => {
        expect(one.source).toMatch(/^blob:/);
        expect(two.source).toMatch(/^blob:/);
      });
      const expected = entity === "album" ? ["album-cover"] : ["album-cover", "track-cover"];
      expect(
        catalog(disk)
          .map((record: { id: string }) => record.id)
          .sort(),
      ).toEqual(expected);
      expect(disk.blobs.size).toBe(expected.length);
    },
  );
});

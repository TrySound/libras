import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverEngine } from "./cover.svelte";
import { Cache, type LibrarySnapshot } from "./cache.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { Network } from "./network.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
const offline = { allowNetwork: false };
const online = { allowNetwork: true };
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
    const cover = covers.ensureAlbumCover("album", offline);
    await covers.refresh();
    expect(candidates).toHaveBeenCalled();
    expect(cover.source).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(disk.state.writes).toBe(writes);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect([...disk.files.keys()].some((path) => path.endsWith("images.json"))).toBe(false);
    expect(disk.blobs.size).toBe(0);
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
    const artist = covers.ensureArtistCover("artist", offline);
    const album = covers.ensureAlbumCover("album", offline);
    const track = covers.ensureTrackCover("one", offline);
    await vi.waitFor(() => expect(artist.source).toBe("blob:cover-1"));
    expect(album.source).toBe(artist.source);
    expect(track.source).toBe(artist.source);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("album-cover", expect.any(AbortSignal));
    expect(bytes).toHaveBeenCalledOnce();
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).not.toBeInstanceOf(File);
    disk.getDirectory.mockClear();
    for (let i = 0; i < 3; i++) {
      expect(covers.ensureTrackCover("one", offline)).toBe(track);
      expect(track.source).toBe("blob:cover-1");
      track.cache();
    }
    expect(disk.getDirectory).not.toHaveBeenCalled();
    covers.destroy();
    expect(track.source).toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:cover-1");
  });

  it("refreshes existing handles after metadata replacement without rewriting images", async () => {
    const disk = installOpfs();
    const { covers, cache, selection } = await engine(await seed());
    const old = covers.ensureTrackCover("one", offline);
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
    const cover = covers.ensureAlbumCover("album", offline);
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    expect(cache.images.has("album-cover")).toBe(false);
    expect(cache.albumArtwork).toBe(references);
    expect(catalog(disk).images.map((record: { id: string }) => record.id)).toEqual([
      "track-cover",
    ]);
    expect(await (vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).text()).toBe("fallback");
  });

  it("reads a competing replacement on the first offline acquisition", async () => {
    installOpfs();
    const original = await seed();
    const { covers } = await engine(original);
    const competing = new Cache(account);
    await competing.load();
    await competing.saveImage("album-cover", image("replacement"));
    const cover = covers.ensureAlbumCover("album", offline);
    await vi.waitFor(() => expect(cover.source).toBe("blob:cover-1"));
    expect(await (vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).text()).toBe(
      "replacement",
    );
  });

  it("shares one explicit download across network and cache-only handles", async () => {
    const disk = installOpfs();
    const { covers, selection } = await engine();
    covers.setConnection(createConnection());
    const album = covers.ensureAlbumCover("album", online);
    const track = covers.ensureTrackCover("two", online);
    const cached = covers.ensureTrackCover("two", offline);
    const artist = covers.ensureArtistCover("artist", offline);
    const fetcher = vi.fn(
      async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const notify = vi.fn();
    const unsubscribe = covers.subscribe(notify);
    await vi.waitFor(() => expect(album.source).toContain("/rest/getCoverArt.view?"));
    expect(new URL(album.source!).searchParams.get("id")).toBe("album-cover");
    expect(fetcher).not.toHaveBeenCalled();
    expect(cached.source).toBeUndefined();
    album.cache();
    track.cache();
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    expect(artist.source).toBe(cached.source);
    expect(album.source).toBe(cached.source);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalled();
    unsubscribe();
    const saved = catalog(disk);
    expect(saved.images).toEqual([...selection.cache!.images.values()]);
    expect(Object.keys(saved)).toEqual(["images"]);
    expect(disk.blobs.size).toBe(1);
    for (const secret of ["blob:", "getCoverArt", auth.token, auth.salt])
      expect(JSON.stringify(saved)).not.toContain(secret);
    const restored = new Cache(account);
    await restored.load();
    const other = await engine(restored);
    const cover = other.covers.ensureTrackCover("two", offline);
    await vi.waitFor(() => expect(cover.source).toMatch(/^blob:/));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([200, 304])("revalidates cached artwork using HTTP validators (%s)", async (status) => {
    const disk = installOpfs();
    const { covers } = await engine(await seed({ etag: '"old"', lastModified: "Yesterday" }));
    const writes = disk.state.writes;
    const cached = covers.ensureAlbumCover("album", offline);
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
    const cover = covers.ensureAlbumCover("album", online);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("If-None-Match")).toBe('"old"');
    expect(headers.get("If-Modified-Since")).toBe("Yesterday");
    if (status === 200) {
      await vi.waitFor(() => expect(cover.source).toBe("blob:cover-2"));
      expect(cached.source).toBe(cover.source);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover-1");
      expect(catalog(disk).images[0].etag).toBe('"new"');
      expect(disk.blobs.size).toBe(1);
    } else {
      expect(cached.source).toBe("blob:cover-1");
      expect(disk.state.writes).toBe(writes);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    }
  });

  it("retains the old URL, records and bytes after failed replacement", async () => {
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
    const cover = covers.ensureAlbumCover("album", online);
    await vi.waitFor(() => expect(cache.imagesError).toBeDefined());
    expect(cover.source).toBe("blob:cover-1");
    expect(catalog(disk)).toEqual(original);
    expect(disk.blobs.size).toBe(1);
    expect(await [...disk.blobs.values()][0].text()).toBe("image");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
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
    const cached = covers.ensureAlbumCover("album", offline);
    await vi.waitFor(() => expect(cached.source).toBe("blob:cover-1"));
    const images = cache.images;
    const writes = disk.state.writes;
    const response = deferred<Response>();
    const fetcher = vi.fn((_url: string, _options: RequestInit) => response.promise);
    vi.stubGlobal("fetch", fetcher);
    const connection = createConnection();
    covers.setConnection(connection);
    const remote = covers.ensureAlbumCover("remote", online);
    await vi.waitFor(() => expect(remote.source).toContain("getCoverArt"));
    remote.cache();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    connection.abort();
    covers.setConnection(undefined);
    expect(remote.source).toBeUndefined();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    response.resolve(new Response("late image"));
    await new Promise((done) => setTimeout(done, 0));
    remote.cache();
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
    const cover = covers.ensureAlbumCover("album", offline);
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
      const old = covers.ensureAlbumCover("album", online);
      await vi.waitFor(() => expect(old.source).toBeDefined());
      old.cache();
      const next = new Cache({ ...account, username });
      await next.replaceLibrary(snapshot());
      selection.cache = next;
      covers.activate();
      covers.setConnection(createConnection({ ...auth, username }));
      const current = covers.ensureAlbumCover("album", online);
      await vi.waitFor(() => expect(current.source).toContain("getCoverArt"));
      current.cache();
      expect(fetcher).toHaveBeenCalledTimes(2);
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
    "cancels publication at catalog %s without deleting committed bytes",
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
      const cover = covers.ensureAlbumCover("album", online);
      await vi.waitFor(() => expect(cover.source).toContain("getCoverArt"));
      cover.cache();
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      await expect(save.mock.results[0].value).rejects.toMatchObject({ name: "AbortError" });
      expect(cover.source).toBeUndefined();
      expect(cache.images.size).toBe(0);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(disk.blobs.size).toBe(stage === "afterClose" ? 1 : 0);
      if (stage === "afterClose") {
        const restored = new Cache(account);
        await restored.load();
        expect(await (await restored.readImage("album-cover"))!.text()).toBe("image");
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
      const one = first.covers.ensureAlbumCover("album", online);
      const two =
        entity === "album"
          ? second.covers.ensureAlbumCover("album", online)
          : second.covers.ensureTrackCover("one", online);
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
      const expected = entity === "album" ? ["album-cover"] : ["album-cover", "track-cover"];
      expect(
        catalog(disk)
          .images.map((record: { id: string }) => record.id)
          .sort(),
      ).toEqual(expected);
      expect(disk.blobs.size).toBe(expected.length);
    },
  );
});

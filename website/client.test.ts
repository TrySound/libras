// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCatalog, loadCatalog } from "./catalog";
import { StaticSubsonicClient } from "./client";
import { MemoryStorage } from "./storage";
import { assetsFixture, searchFixture } from "./fixtures";
import { Network } from "../src/network.svelte";

const base = new URL("/libras/demo/catalog/", location.origin);
const auth = {
  host: new URL("/libras/demo", location.origin).href,
  username: "static-demo",
  token: "local",
  salt: "local",
};
const all = {
  artistCount: 500,
  artistOffset: 0,
  albumCount: 500,
  albumOffset: 0,
  songCount: 500,
  songOffset: 0,
};
function setup() {
  const storage = new MemoryStorage();
  const catalog = parseCatalog(searchFixture, assetsFixture, base);
  return { storage, catalog, client: new StaticSubsonicClient(auth, catalog, storage) };
}
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("static client", () => {
  it("reads exporter-supplied credits and paginates independently", async () => {
    const { client } = setup();
    const page = await client.search3({ ...all, artistCount: 0, songCount: 1, songOffset: 1 });
    expect(page.artists).toEqual([]);
    expect(page.tracks.map((t) => t.id)).toEqual(["song-2"]);
    expect(page.albums[0].artists?.map((a) => a.name)).toEqual(["Demo artist"]);
    expect(page.albums[0].year).toBe(2015);
    expect((await client.search3({ ...all, songOffset: 3 })).tracks).toEqual([]);
    await expect(client.search3({ ...all, albumOffset: -1 })).rejects.toThrow("pagination");
  });

  it("works with the real Network pipeline without any /rest requests", async () => {
    const { storage, catalog } = setup();
    const network = new Network((identity) => new StaticSubsonicClient(identity, catalog, storage));
    const connection = network.prepare(auth);
    await network.validate(connection);
    const active = network.accept(connection);
    const library = await active.metadata.readLibrary(new AbortController().signal);
    expect(library.artists[0].artworkId).toBe("artist-cover");
    expect(library.albums[0].artistIds).toEqual(["artist"]);
    expect(library.tracks.map((t) => t.number)).toEqual([1, 2, 10]);
    expect(active.audio.url("song-1", { format: "raw", position: 12 })).toBe(
      new URL("audio/song-1.mp3", base).href,
    );
    expect(active.artwork.url("cover", 200)).toBe(new URL("covers/album.svg", base).href);
    network.setMode("offline");
    expect(active.signal.aborted).toBe(true);
  });

  it("returns original asset URLs, honors cancellation, and never invents transcoding", async () => {
    const { client, catalog, storage } = setup();
    expect(client.getStreamUrl("song-1", { format: "mp3", timeOffset: 20 })).not.toContain("?");
    expect(() => client.getStreamUrl("missing")).toThrow("not found");
    expect(() => client.getCoverArtUrl("song-1")).toThrow("not found");
    const oggCatalog = {
      ...catalog,
      assets: new Map([
        ["ogg", { url: new URL("audio/original.ogg", base).href, contentType: "audio/ogg" }],
      ]),
    };
    const ogg = new StaticSubsonicClient(auth, oggCatalog, storage);
    expect(ogg.getStreamUrl("ogg", { format: "raw" })).toMatch(/\.ogg$/);
    expect(() => ogg.getStreamUrl("ogg", { format: "mp3" })).toThrow("cannot transcode");
    const controller = new AbortController();
    controller.abort();
    await expect(client.search3(all, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    client.abort();
    await expect(client.ping()).rejects.toMatchObject({ name: "AbortError" });
    expect(() => client.getStreamUrl("song-1")).toThrow();
    await expect(client.savePlayQueue({ tracks: [], position: 0 })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("shares the simulated queue within a runtime but resets for a new runtime", async () => {
    const { client, catalog, storage } = setup();
    const queue = { tracks: ["song-1", "song-1", "song-2"], current: "song-1", position: 12.5 };
    await client.savePlayQueue(queue);
    for (const position of [-1, NaN, Infinity]) {
      await expect(client.savePlayQueue({ ...queue, position })).rejects.toThrow();
    }
    const next = new StaticSubsonicClient(auth, catalog, storage);
    expect(await next.getPlayQueue()).toEqual(queue);
    Object.assign(await next.getPlayQueue(), { tracks: [] });
    expect(await next.getPlayQueue()).toEqual(queue);
    const fresh = new StaticSubsonicClient(auth, catalog, new MemoryStorage());
    expect(await fresh.getPlayQueue()).toEqual({ tracks: [], position: 0 });
  });
});

describe("catalog loading", () => {
  it("fetches only same-origin static JSON without authentication", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(searchFixture)))
      .mockResolvedValueOnce(new Response(JSON.stringify(assetsFixture)));
    const result = await loadCatalog(base, new AbortController().signal, fetcher);
    expect(result.tracks).toHaveLength(3);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      new URL("search3.json", base).href,
      new URL("assets.json", base).href,
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-cache" });
    await expect(
      loadCatalog(new URL("https://elsewhere.invalid/"), new AbortController().signal, fetcher),
    ).rejects.toThrow("alongside");
  });

  it("rejects path traversal, external URLs, missing assets and malformed metadata", () => {
    for (const path of [
      "https://elsewhere.invalid/song.mp3",
      "audio/../song.mp3",
      "audio/%2e%2e/song.mp3",
      "//elsewhere.invalid/song.mp3",
      "audio/song.mp3?token=secret",
    ]) {
      expect(() =>
        parseCatalog(
          searchFixture,
          { ...assetsFixture, cover: { path, contentType: "image/svg+xml" } },
          base,
        ),
      ).toThrow();
    }
    expect(() => parseCatalog({}, assetsFixture, base)).toThrow("invalid");
    expect(() => parseCatalog(searchFixture, {}, base)).toThrow("artwork");
  });

  it("preserves shared protocol fields and exporter-supplied structured credits", () => {
    const search = structuredClone(searchFixture);
    const data = search["subsonic-response"].searchResult3;
    const credits = {
      artists: [{ id: "guest", name: "Guest artist" }],
      displayArtist: "Guest artist feat. Demo artist",
      genres: [{ name: "Electronic" }],
    };
    Object.assign(data.album[0], credits);
    Object.assign(data.song[0], credits, { discNumber: 2 });
    const catalog = parseCatalog(search, assetsFixture, base);
    expect(catalog.albums[0]).toMatchObject({ ...credits, year: 2015 });
    expect(catalog.tracks[0]).toMatchObject({ ...credits, discNumber: 2, duration: 30, track: 1 });
  });

  it.each([
    { id: "" },
    { albumId: undefined },
    { duration: -1 },
    { coverArt: "" },
    { artists: undefined },
    { artists: [] },
    { displayArtist: undefined },
  ])("retains export-specific constraints for %j", (patch) => {
    const search = structuredClone(searchFixture);
    Object.assign(search["subsonic-response"].searchResult3.song[0], patch);
    expect(() => parseCatalog(search, assetsFixture, base)).toThrow("invalid");
  });

  it("rejects legacy-only album credits instead of converting them in the browser", () => {
    const search = structuredClone(searchFixture);
    Object.assign(search["subsonic-response"].searchResult3.album[0], {
      artists: undefined,
      displayArtist: undefined,
      artistId: "artist",
      artist: "Demo artist",
    });
    expect(() => parseCatalog(search, assetsFixture, base)).toThrow("invalid");
  });

  it("rejects failed downloads and cancellation instead of returning an empty library", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(loadCatalog(base, new AbortController().signal, fetcher)).rejects.toThrow(
      "HTTP 503",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(loadCatalog(base, controller.signal, fetcher)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

it("stores values in memory without touching localStorage or other instances", () => {
  localStorage.setItem("navidrome-auth", "regular");
  localStorage.setItem("navidrome-account", "regular-account");
  const { storage } = setup();
  storage.setItem("navidrome-auth", "demo");
  storage.setItem("navidrome-account", "demo-account");
  expect(storage.length).toBe(2);
  expect(storage.key(0)).toBe("navidrome-auth");
  expect(storage.getItem("navidrome-auth")).toBe("demo");
  storage.setItem("navidrome-auth", "updated");
  expect(storage.length).toBe(2);
  expect(storage.getItem("navidrome-auth")).toBe("updated");
  expect(storage.key(2)).toBeNull();
  expect(storage.getItem("missing")).toBeNull();
  storage.setItem("empty", "");
  expect(storage.getItem("empty")).toBe("");
  storage.removeItem("empty");
  expect(storage.getItem("empty")).toBeNull();
  expect(new MemoryStorage().length).toBe(0);
  storage.clear();
  expect(storage.length).toBe(0);
  expect(storage.key(0)).toBeNull();
  expect(storage.getItem("navidrome-auth")).toBeNull();
  expect(localStorage.length).toBe(2);
  expect(localStorage.getItem("navidrome-auth")).toBe("regular");
  expect(localStorage.getItem("navidrome-account")).toBe("regular-account");
});

// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { parseCatalog, StaticSubsonicClient } from "./client";
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
function setup(assets: unknown = assetsFixture) {
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(JSON.stringify(String(url).endsWith("search3.json") ? searchFixture : assets)),
  );
  const catalogBase = new URL(base);
  const createClient = (identity: typeof auth) =>
    new StaticSubsonicClient(identity, catalogBase, fetcher);
  return { fetcher, createClient, client: createClient(auth) };
}

describe("static client", () => {
  it("loads lazily, deduplicates concurrent requests and isolates catalog instances", async () => {
    const { client, fetcher } = setup();
    expect(fetcher).not.toHaveBeenCalled();
    const [, page] = await Promise.all([
      client.ping(),
      client.search3({ ...all, artistCount: 0, songCount: 1, songOffset: 1 }),
    ]);
    expect(page.artists).toEqual([]);
    expect(page.tracks.map((t) => t.id)).toEqual(["song-2"]);
    expect(page.albums).toHaveLength(1);
    expect((await client.search3({ ...all, songOffset: 3 })).tracks).toEqual([]);
    await expect(client.search3({ ...all, albumOffset: -1 })).rejects.toThrow("pagination");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const fresh = setup();
    await fresh.client.ping();
    expect(fresh.fetcher).toHaveBeenCalledTimes(2);
  });

  it("works with the real Network startup pipeline without a preceding ping", async () => {
    const { createClient, fetcher } = setup();
    const network = new Network(createClient);
    network.setMode("online");
    const active = network.open(auth);
    expect(await active.metadata.getModifiedAt()).toBeNull();
    const library = await active.metadata.readLibrary(new AbortController().signal);
    expect(library.tracks).toHaveLength(3);
    network.setMode("offline");
    network.setMode("online");
    const resumed = network.open(auth);
    expect(resumed.artwork.url("cover", 200)).toBe(new URL("covers/album.svg", base).href);
    expect(resumed.audio.url("song-1", { format: "raw", position: 0 })).toBe(
      new URL("audio/song-1.mp3", base).href,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serves original formats without inventing transcoding", async () => {
    const { client } = setup({
      ...assetsFixture,
      ogg: { path: "audio/original.ogg", contentType: "audio/ogg" },
    });
    await client.ping();
    expect(client.getStreamUrl("song-1", { format: "mp3", timeOffset: 20 })).not.toContain("?");
    expect(client.getStreamUrl("ogg", { format: "raw" })).toMatch(/\.ogg$/);
    expect(() => client.getStreamUrl("ogg", { format: "mp3" })).toThrow("cannot transcode");
    expect(() => client.getStreamUrl("missing")).toThrow("not found");
    expect(() => client.getCoverArtUrl("song-1")).toThrow("not found");
  });

  it("ignores server queue writes without loading metadata", async () => {
    const { client, fetcher } = setup();
    await client.savePlayQueue({ tracks: ["song-1"], current: "song-1", position: 12.5 });
    expect(await client.getPlayQueue()).toEqual({ tracks: [], position: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches same-origin JSON without authentication", async () => {
    const { client, fetcher } = setup();
    await client.search3(all);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      new URL("search3.json", base).href,
      new URL("assets.json", base).href,
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-cache" });
    expect(fetcher.mock.contexts).toEqual([undefined, undefined]);
    expect(() => new StaticSubsonicClient(auth, new URL("https://elsewhere.invalid/"))).toThrow(
      "alongside",
    );
  });

  it("retries failed metadata loads instead of caching rejected promises", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(client.getIndexes()).rejects.toThrow("HTTP 404");
    expect((await client.search3(all)).tracks).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("cancels metadata requests on disconnect without poisoning the next client", async () => {
    const { client, createClient, fetcher } = setup();
    const pendingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    fetcher.mockImplementationOnce(pendingFetch).mockImplementationOnce(pendingFetch);
    const pending = client.search3(all);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    client.abort();
    await rejected;
    const next = createClient(auth);
    expect((await next.search3(all)).tracks).toHaveLength(3);
  });

  it("honors caller cancellation while metadata is loading", async () => {
    const { client, fetcher } = setup();
    let finish!: () => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(new Response(JSON.stringify(searchFixture)));
        }),
    );
    const controller = new AbortController();
    const pending = client.search3(all, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    finish();
    await rejected;
    expect((await client.search3(all)).tracks).toHaveLength(3);
  });

  it("keeps media URLs within the catalog", async () => {
    for (const path of [
      "https://elsewhere.invalid/song.mp3",
      "../song.mp3",
      "//elsewhere.invalid/song.mp3",
    ]) {
      const { client } = setup({ cover: { path, contentType: "image/svg+xml" } });
      await client.ping();
      expect(() => client.getCoverArtUrl("cover")).toThrow("Invalid demo asset URL");
    }
  });
});

it("rejects unsuccessful responses and missing search3 data", () => {
  for (const response of [{ status: "failed" }, { status: "ok" }]) {
    expect(() => parseCatalog({ "subsonic-response": response }, {})).toThrow("search3");
  }
});

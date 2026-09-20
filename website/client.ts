import * as v from "valibot";
import {
  responseSchema,
  type SubsonicApi,
  type SubsonicAuth,
  type SubsonicClient,
  type SubsonicPlayQueue,
  type SubsonicStreamOptions,
} from "../src/subsonic-client";

const assetsSchema = v.record(v.string(), v.object({ path: v.string(), contentType: v.string() }));

export type StaticCatalog = ReturnType<typeof parseCatalog>;

export function parseCatalog(search: unknown, assetData: unknown, base: URL) {
  const response = v.parse(responseSchema, search)["subsonic-response"];
  if (response.status !== "ok" || !response.searchResult3) {
    throw new Error("The demo catalog is not a successful search3 response.");
  }
  return {
    artists: response.searchResult3.artist ?? [],
    albums: response.searchResult3.album ?? [],
    tracks: response.searchResult3.song ?? [],
    assets: v.parse(assetsSchema, assetData),
    base,
  };
}

export async function loadCatalog(base: URL, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (base.origin !== location.origin || !base.pathname.endsWith("/") || base.search || base.hash) {
    throw new Error("The demo catalog must be hosted alongside this website.");
  }
  const read = async (name: string) => {
    signal.throwIfAborted();
    const response = await fetcher(new URL(name, base), {
      signal,
      cache: "no-cache",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Could not load demo metadata (HTTP ${response.status}).`);
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  };
  const [search, assets] = await Promise.all([read("search3.json"), read("assets.json")]);
  return parseCatalog(search, assets, base);
}

/** Local protocol simulation. Media URLs point directly to Pages, never /rest endpoints. */
export class StaticSubsonicClient implements SubsonicApi {
  private controller = new AbortController();
  readonly host: string;
  readonly username: string;

  constructor(
    auth: SubsonicAuth,
    private catalog: StaticCatalog,
  ) {
    this.host = auth.host;
    this.username = auth.username;
  }

  get signal() {
    return this.controller.signal;
  }
  abort() {
    this.controller.abort();
  }

  async ping() {
    this.signal.throwIfAborted();
    return {
      version: "1.16.1",
      type: "libras-static-demo",
      serverVersion: "1",
      openSubsonic: true as const,
    };
  }

  async getIndexes(_ifModifiedSince?: number) {
    this.signal.throwIfAborted();
    // Boot loads a fresh snapshot. No fabricated server timestamp; always resync metadata.
    return null;
  }

  async search3(options: Parameters<SubsonicClient["search3"]>[0], signal?: AbortSignal) {
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    for (const value of Object.values(options)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid catalog pagination.");
    }
    return {
      artists: this.catalog.artists.slice(
        options.artistOffset,
        options.artistOffset + options.artistCount,
      ),
      albums: this.catalog.albums.slice(
        options.albumOffset,
        options.albumOffset + options.albumCount,
      ),
      tracks: this.catalog.tracks.slice(options.songOffset, options.songOffset + options.songCount),
    };
  }

  private assetUrl(path: string) {
    const url = new URL(path, this.catalog.base);
    if (!url.href.startsWith(this.catalog.base.href)) throw new Error("Invalid demo asset URL.");
    return url.href;
  }

  getCoverArtUrl(id: string, _size?: number) {
    this.signal.throwIfAborted();
    const asset = this.catalog.assets[id];
    if (!asset?.contentType.startsWith("image/")) throw new Error("Demo artwork not found.");
    return this.assetUrl(asset.path);
  }

  getStreamUrl(id: string, options: SubsonicStreamOptions = {}) {
    this.signal.throwIfAborted();
    const asset = this.catalog.assets[id];
    if (!asset?.contentType.startsWith("audio/")) throw new Error("Demo audio not found.");
    if (options.format === "mp3" && asset.contentType !== "audio/mpeg") {
      throw new Error(
        "This demo cannot transcode audio. Use a browser that supports the original audio format.",
      );
    }
    // Original full files support native seeking. No fake transcodes or timeOffset slicing.
    return this.assetUrl(asset.path);
  }

  async getPlayQueue(): Promise<SubsonicPlayQueue> {
    this.signal.throwIfAborted();
    return { tracks: [], position: 0 };
  }

  async savePlayQueue(_queue: SubsonicPlayQueue) {
    this.signal.throwIfAborted();
    // The app's local playback queue is authoritative; the demo has no server queue.
  }
}

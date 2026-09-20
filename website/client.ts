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

type StaticCatalog = ReturnType<typeof parseCatalog>;

export function parseCatalog(search: unknown, assetData: unknown) {
  const response = v.parse(responseSchema, search)["subsonic-response"];
  if (response.status !== "ok" || !response.searchResult3) {
    throw new Error("The demo catalog is not a successful search3 response.");
  }
  return {
    artists: response.searchResult3.artist ?? [],
    albums: response.searchResult3.album ?? [],
    tracks: response.searchResult3.song ?? [],
    assets: v.parse(assetsSchema, assetData),
  };
}

/** Local protocol simulation. Media URLs point directly to Pages, never /rest endpoints. */
export class StaticSubsonicClient implements SubsonicApi {
  private controller = new AbortController();
  readonly host: string;
  readonly username: string;

  private pending?: Promise<StaticCatalog>;
  // The demo reuses one base URL object across reconnects; separate mounts stay isolated.
  private static catalogs = new WeakMap<URL, StaticCatalog>();

  constructor(
    auth: SubsonicAuth,
    private base: URL,
    private fetcher: typeof fetch = fetch,
  ) {
    if (
      base.origin !== location.origin ||
      !base.pathname.endsWith("/") ||
      base.search ||
      base.hash
    ) {
      throw new Error("The demo catalog must be hosted alongside this website.");
    }
    this.host = auth.host;
    this.username = auth.username;
  }

  private get catalog() {
    const catalog = StaticSubsonicClient.catalogs.get(this.base);
    if (!catalog) throw new Error("The demo catalog is still loading.");
    return catalog;
  }

  private async loadCatalog(signal = this.signal) {
    this.signal.throwIfAborted();
    signal.throwIfAborted();
    if (!StaticSubsonicClient.catalogs.has(this.base)) {
      const combined = AbortSignal.any([this.signal, signal]);
      this.pending ??= (async () => {
        const fetcher = this.fetcher;
        const read = async (name: string) => {
          const response = await fetcher(new URL(name, this.base), {
            signal: combined,
            cache: "no-cache",
            credentials: "omit",
            redirect: "error",
          });
          if (!response.ok)
            throw new Error(`Could not load demo metadata (HTTP ${response.status}).`);
          return response.json();
        };
        const [search, assets] = await Promise.all([read("search3.json"), read("assets.json")]);
        combined.throwIfAborted();
        const catalog = parseCatalog(search, assets);
        StaticSubsonicClient.catalogs.set(this.base, catalog);
        return catalog;
      })().finally(() => {
        this.pending = undefined;
      });
      await this.pending;
    }
    this.signal.throwIfAborted();
    signal.throwIfAborted();
    return this.catalog;
  }

  get signal() {
    return this.controller.signal;
  }
  abort() {
    this.controller.abort();
  }

  async ping() {
    await this.loadCatalog();
    return {
      version: "1.16.1",
      type: "libras-static-demo",
      serverVersion: "1",
      openSubsonic: true as const,
    };
  }

  async getIndexes(_ifModifiedSince?: number) {
    this.signal.throwIfAborted();
    await this.loadCatalog();
    // No fabricated server timestamp; always sync the loaded snapshot.
    return null;
  }

  async search3(options: Parameters<SubsonicClient["search3"]>[0], signal?: AbortSignal) {
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    for (const value of Object.values(options)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid catalog pagination.");
    }
    await this.loadCatalog(signal);
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
    const url = new URL(path, this.base);
    if (!url.href.startsWith(this.base.href)) throw new Error("Invalid demo asset URL.");
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

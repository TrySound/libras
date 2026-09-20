import * as v from "valibot";
import type {
  SubsonicApi,
  SubsonicAuth,
  SubsonicClient,
  SubsonicPlayQueue,
  SubsonicStreamOptions,
} from "../src/subsonic-client";
import type { StaticCatalog } from "./catalog";

const queueSchema = v.object({
  current: v.optional(v.string()),
  position: v.pipe(v.number(), v.finite(), v.minValue(0)),
  tracks: v.array(v.string()),
});

/** Local protocol simulation. Media URLs point directly to Pages, never /rest endpoints. */
export class StaticSubsonicClient implements SubsonicApi {
  private controller = new AbortController();
  readonly host: string;
  readonly username: string;

  constructor(
    auth: SubsonicAuth,
    private catalog: StaticCatalog,
    private storage: Storage,
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

  getCoverArtUrl(id: string, _size?: number) {
    this.signal.throwIfAborted();
    const asset = this.catalog.assets.get(id);
    if (!asset?.contentType.startsWith("image/")) throw new Error("Demo artwork not found.");
    return asset.url;
  }

  getStreamUrl(id: string, options: SubsonicStreamOptions = {}) {
    this.signal.throwIfAborted();
    const asset = this.catalog.assets.get(id);
    if (!asset?.contentType.startsWith("audio/")) throw new Error("Demo audio not found.");
    if (options.format === "mp3" && asset.contentType !== "audio/mpeg") {
      throw new Error(
        "This demo cannot transcode audio. Use a browser that supports the original audio format.",
      );
    }
    // Original full files support native seeking. No fake transcodes or timeOffset slicing.
    return asset.url;
  }

  async getPlayQueue(): Promise<SubsonicPlayQueue> {
    this.signal.throwIfAborted();
    const saved = this.storage.getItem("remote-queue");
    if (saved === null) return { tracks: [], position: 0 };
    const parsed = v.safeParse(queueSchema, JSON.parse(saved));
    if (!parsed.success) throw new Error("The saved demo queue is invalid.");
    return parsed.output;
  }

  async savePlayQueue(queue: SubsonicPlayQueue) {
    this.signal.throwIfAborted();
    this.storage.setItem(
      "remote-queue",
      JSON.stringify(v.parse(queueSchema, { ...queue, tracks: [...queue.tracks] })),
    );
  }
}

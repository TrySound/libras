import * as v from "valibot";
import type {
  SubsonicApi,
  SubsonicAuth,
  SubsonicPlayQueue,
  SubsonicClient,
  SubsonicStreamOptions,
} from "../src/subsonic-client";
import { readDeezer } from "./deezer-api";

const demoTrackIds = [3135439, 3135442, 3135444] as const;
const artistSchema = v.object({ id: v.literal(702), name: v.string() });
const trackSchema = v.object({
  id: v.number(),
  title: v.string(),
  explicit_lyrics: v.boolean(),
  artist: artistSchema,
});
const albumSchema = v.object({
  id: v.literal(302117),
  title: v.string(),
  artist: artistSchema,
  cover_medium: v.string(),
  tracks: v.object({ data: v.array(trackSchema) }),
});

function mediaUrl(value: string, origin: string) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password)
    throw new Error("Unexpected Deezer media URL.");
  return url.href;
}

type Catalog = ReturnType<DeezerSubsonicClient["parse"]>;

/** The demo's in-browser data backend; no server process or real account. */
export class DeezerSubsonicClient implements SubsonicApi {
  readonly host: string;
  readonly username: string;
  readonly audioDownloads = false;
  private controller = new AbortController();
  private catalog?: Catalog;
  private pending?: Promise<Catalog>;

  constructor(
    auth: SubsonicAuth,
    private read = readDeezer,
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

  private parse(input: unknown) {
    const album = v.parse(albumSchema, input);
    const artist = { id: "702", name: album.artist.name, coverArt: "302117" };
    const tracks = demoTrackIds.map((id) => {
      const track = album.tracks.data.find((track) => track.id === id);
      if (!track) throw new Error("A selected Deezer recording is missing.");
      return {
        id: String(id),
        title: `${track.title} — Preview${track.explicit_lyrics ? " [Explicit]" : ""}`,
        album: album.title,
        albumId: "302117",
        artists: [artist],
        displayArtist: artist.name,
        coverArt: "302117",
        contentType: "audio/mpeg",
        discNumber: 1,
        track: album.tracks.data.indexOf(track) + 1,
        // Full-song duration is not the preview duration. The player measures the clip.
      };
    });
    return {
      artists: [artist],
      albums: [
        {
          id: "302117",
          name: album.title,
          artists: [artist],
          displayArtist: artist.name,
          coverArt: "302117",
        },
      ],
      tracks,
      artwork: mediaUrl(album.cover_medium, "https://cdn-images.dzcdn.net"),
    };
  }
  private async load(signal = this.signal) {
    const combined = AbortSignal.any([this.signal, signal]);
    combined.throwIfAborted();
    if (!this.catalog) {
      this.pending ??= this.read("album/302117", combined)
        .then((input) => {
          combined.throwIfAborted();
          const catalog = this.parse(input);
          this.catalog = catalog;
          return catalog;
        })
        .finally(() => {
          this.pending = undefined;
        });
      await this.pending;
    }
    combined.throwIfAborted();
    return this.catalog!;
  }
  async ping() {
    await this.load();
    return {
      version: "1.16.1",
      type: "libras-deezer-demo",
      serverVersion: "1",
      openSubsonic: true as const,
    };
  }
  async getIndexes(_ifModifiedSince?: number) {
    await this.load();
    return null;
  }
  async search3(options: Parameters<SubsonicClient["search3"]>[0], signal?: AbortSignal) {
    for (const value of Object.values(options)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid catalog pagination.");
    }
    const catalog = await this.load(signal);
    return {
      artists: catalog.artists.slice(
        options.artistOffset,
        options.artistOffset + options.artistCount,
      ),
      albums: catalog.albums.slice(options.albumOffset, options.albumOffset + options.albumCount),
      tracks: catalog.tracks.slice(options.songOffset, options.songOffset + options.songCount),
    };
  }
  getCoverArtUrl(id: string, _size?: number) {
    this.signal.throwIfAborted();
    if (id !== "302117" || !this.catalog) throw new Error("Demo artwork unavailable.");
    return this.catalog.artwork;
  }
  async getStreamUrl(id: string, _options: SubsonicStreamOptions = {}, signal = this.signal) {
    if (!demoTrackIds.some((allowed) => String(allowed) === id))
      throw new Error("Unknown demo track.");
    const combined = AbortSignal.any([this.signal, signal]);
    combined.throwIfAborted();
    const input = await this.read(`track/${id}`, combined);
    combined.throwIfAborted();
    const track = v.parse(
      v.object({
        id: v.number(),
        artist: v.object({ id: v.literal(702) }),
        album: v.object({ id: v.literal(302117) }),
        readable: v.boolean(),
        preview: v.string(),
      }),
      input,
    );
    if (String(track.id) !== id || !track.readable || !track.preview)
      throw new Error("This Deezer preview is unavailable.");
    return mediaUrl(track.preview, "https://cdnt-preview.dzcdn.net");
  }
  async getPlaylists() {
    this.signal.throwIfAborted();
    return [];
  }
  private unsupported(): never {
    this.signal.throwIfAborted();
    throw new Error("Playlists are unavailable in this demo.");
  }
  async getPlaylist(_id: string) {
    return this.unsupported();
  }
  async createPlaylist(_name: string, _ids?: readonly string[]) {
    return this.unsupported();
  }
  async replacePlaylist(_id: string, _ids: readonly string[]) {
    return this.unsupported();
  }
  async updatePlaylist(_id: string, _options: Parameters<SubsonicClient["updatePlaylist"]>[1]) {
    return this.unsupported();
  }
  async deletePlaylist(_id: string) {
    return this.unsupported();
  }
  async getPlayQueue(): Promise<SubsonicPlayQueue> {
    this.signal.throwIfAborted();
    return { tracks: [], position: 0 };
  }
  async savePlayQueue(_queue: SubsonicPlayQueue) {
    this.signal.throwIfAborted();
  }
}

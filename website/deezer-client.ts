import * as v from "valibot";
import type {
  SubsonicApi,
  SubsonicAuth,
  SubsonicPlayQueue,
  SubsonicClient,
  SubsonicStreamOptions,
} from "../src/subsonic-client";
import { readDeezer } from "./deezer-api";
import { demoAlbums } from "./deezer-catalog";

const artistSchema = v.object({ id: v.number(), name: v.string() });
const trackSchema = v.object({
  id: v.number(),
  title: v.string(),
  explicit_lyrics: v.boolean(),
  artist: artistSchema,
});
const albumSchema = v.object({
  id: v.number(),
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

  private parse(input: unknown, selection: (typeof demoAlbums)[number]) {
    const album = v.parse(albumSchema, input);
    if (album.id !== selection.id || album.artist.id !== selection.artistId)
      throw new Error("Unexpected Deezer album or artist.");
    const albumId = String(album.id);
    const artist = { id: String(album.artist.id), name: album.artist.name, coverArt: albumId };
    const tracks = selection.tracks.map(({ id }) => {
      const track = album.tracks.data.find((track) => track.id === id);
      if (!track || track.artist.id !== selection.artistId)
        throw new Error("A selected Deezer recording is missing or has an unexpected artist.");
      return {
        id: String(id),
        title: `${track.title} — Preview${track.explicit_lyrics ? " [Explicit]" : ""}`,
        album: album.title,
        albumId,
        artists: [artist],
        displayArtist: artist.name,
        coverArt: albumId,
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
          id: albumId,
          name: album.title,
          artists: [artist],
          displayArtist: artist.name,
          coverArt: albumId,
        },
      ],
      tracks,
      artwork: { [albumId]: mediaUrl(album.cover_medium, "https://cdn-images.dzcdn.net") },
    };
  }
  private async load(signal = this.signal) {
    const combined = AbortSignal.any([this.signal, signal]);
    combined.throwIfAborted();
    if (!this.catalog) {
      this.pending ??= Promise.all(
        demoAlbums.map(async (selection) => {
          const input = await this.read(`album/${selection.id}`, combined);
          combined.throwIfAborted();
          return this.parse(input, selection);
        }),
      )
        .then((catalogs) => {
          combined.throwIfAborted();
          const catalog = {
            artists: catalogs.flatMap((catalog) => catalog.artists),
            albums: catalogs.flatMap((catalog) => catalog.albums),
            tracks: catalogs.flatMap((catalog) => catalog.tracks),
            artwork: Object.fromEntries(
              catalogs.flatMap((catalog) => Object.entries(catalog.artwork)),
            ),
          };
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
    const artwork = this.catalog?.artwork[id];
    if (!artwork) throw new Error("Demo artwork unavailable.");
    return artwork;
  }
  async getStreamUrl(id: string, _options: SubsonicStreamOptions = {}, signal = this.signal) {
    const selection = demoAlbums.find((album) =>
      album.tracks.some((track) => String(track.id) === id),
    );
    if (!selection) throw new Error("Unknown demo track.");
    const combined = AbortSignal.any([this.signal, signal]);
    combined.throwIfAborted();
    const input = await this.read(`track/${id}`, combined);
    combined.throwIfAborted();
    const track = v.parse(
      v.object({
        id: v.number(),
        artist: v.object({ id: v.literal(selection.artistId) }),
        album: v.object({ id: v.literal(selection.id) }),
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

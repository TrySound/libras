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

const streamSchema = v.object({
  id: v.number(),
  artist: v.object({ id: v.number() }),
  album: v.object({ id: v.number() }),
  readable: v.boolean(),
  preview: v.string(),
});

function mediaUrl(value: string, origin: string) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password)
    throw new Error("Unexpected Deezer media URL.");
  return url.href;
}

function catalogMetadata() {
  const entries = demoAlbums.map((selection) => {
    const albumId = String(selection.id);
    const artist = { id: String(selection.artistId), name: selection.artist, coverArt: albumId };
    return {
      artist,
      album: {
        id: albumId,
        name: selection.title,
        year: selection.year,
        artists: [artist],
        displayArtist: artist.name,
        coverArt: albumId,
      },
      tracks: selection.tracks.map((track, index) => ({
        id: String(track.id),
        title: `${track.title} — Preview${track.explicit ? " [Explicit]" : ""}`,
        album: selection.title,
        albumId,
        artists: [artist],
        displayArtist: artist.name,
        coverArt: albumId,
        contentType: "audio/mpeg",
        discNumber: 1,
        track: index + 1,
        // Full-song duration is not the preview duration. The player measures the clip.
      })),
      artwork: mediaUrl(selection.artwork, "https://cdn-images.dzcdn.net"),
    };
  });
  return {
    artists: [...new Map(entries.map((entry) => [entry.artist.id, entry.artist])).values()],
    albums: entries.map((entry) => entry.album),
    tracks: entries.flatMap((entry) => entry.tracks),
    artwork: Object.fromEntries(entries.map((entry) => [entry.album.id, entry.artwork])),
  };
}

/** Browsing uses the committed snapshot; only playback resolves live Deezer data. */
export class DeezerSubsonicClient implements SubsonicApi {
  readonly host: string;
  readonly username: string;
  private controller = new AbortController();
  private catalog = catalogMetadata();

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
  async ping() {
    this.signal.throwIfAborted();
    return {
      version: "1.16.1",
      type: "libras-deezer-demo",
      serverVersion: "1",
      openSubsonic: true as const,
    };
  }
  async getIndexes(_ifModifiedSince?: number) {
    this.signal.throwIfAborted();
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
    const artwork = this.catalog.artwork[id];
    if (!artwork) throw new Error("Demo artwork unavailable.");
    return artwork;
  }
  async getStreamUrl(id: string, _options: SubsonicStreamOptions = {}, signal = this.signal) {
    const selection = demoAlbums.find((album) =>
      album.tracks.some((track) => String(track.id) === id),
    );
    const recording = selection?.tracks.find((track) => String(track.id) === id);
    if (!selection || !recording) throw new Error("Unknown demo track.");
    const combined = AbortSignal.any([this.signal, signal]);
    combined.throwIfAborted();
    const input = await this.read(`track/${id}`, combined);
    combined.throwIfAborted();
    const parsed = v.safeParse(streamSchema, input);
    if (!parsed.success)
      throw new Error(
        `Deezer preview unavailable for ${selection.artist} — ${recording.title} (track ${id}).`,
      );
    const track = parsed.output;
    if (
      String(track.id) !== id ||
      track.artist.id !== selection.artistId ||
      track.album.id !== selection.id
    ) {
      throw new Error(
        `Deezer returned a different recording for ${recording.title}: expected track ${id}, album ${selection.id}, artist ${selection.artistId}; received track ${track.id}, album ${track.album.id}, artist ${track.artist.id}.`,
      );
    }
    if (!track.readable || !track.preview)
      throw new Error(
        `This Deezer preview is unavailable: ${selection.artist} — ${recording.title} (track ${id}).`,
      );
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

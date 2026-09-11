import type { Artist, Album, Track, Account, DownloadedFile, ImageRecord } from "./schema";
import type { Cache, Immutable } from "./cache.svelte";
export type { Immutable } from "./cache.svelte";

/**
 * Transitional state for domains not yet migrated to Cache, plus selection of
 * the active account cache. Library and queue getters delegate without copying.
 * Resource engines still publish artwork and download replacements here.
 * ReadonlyMap is a type contract: never mutate a map after publishing it.
 */
export class Memory {
  cache = $state.raw<Cache>();

  // Temporary read-only bridge while resource data still lives here.
  // Library and queue records have one owner: the selected account cache.
  get artists() {
    return this.cache?.artists ?? emptyArtists;
  }
  get albums() {
    return this.cache?.albums ?? emptyAlbums;
  }
  get tracks() {
    return this.cache?.tracks ?? emptyTracks;
  }
  get artistAlbums() {
    return this.cache?.artistAlbums ?? emptyArtistAlbums;
  }
  get albumTracks() {
    return this.cache?.albumTracks ?? emptyAlbumTracks;
  }

  downloads = $state.raw<ReadonlyMap<string, Immutable<DownloadedFile>>>(new Map());

  get images() {
    return this.cache?.images ?? emptyImages;
  }
  get artistArtwork() {
    return this.cache?.artistArtwork ?? emptyArtwork;
  }
  get albumArtwork() {
    return this.cache?.albumArtwork ?? emptyArtwork;
  }
  get trackArtwork() {
    return this.cache?.trackArtwork ?? emptyArtwork;
  }

  get queueTracks() {
    return this.cache?.queue.tracks ?? emptyQueue;
  }
  get queueIndex() {
    return this.cache?.queue.index ?? -1;
  }
  get queuePosition() {
    return this.cache?.queue.position ?? 0;
  }

  account = $state.raw<Readonly<Account> | null>(null);
}

const emptyImages: ReadonlyMap<string, Immutable<ImageRecord>> = new Map();
const emptyArtwork: ReadonlyMap<string, readonly string[]> = new Map();
const emptyQueue: readonly string[] = [];
const emptyArtists: ReadonlyMap<string, Immutable<Artist>> = new Map();
const emptyAlbums: ReadonlyMap<string, Immutable<Album>> = new Map();
const emptyTracks: ReadonlyMap<string, Immutable<Track>> = new Map();
const emptyArtistAlbums: ReadonlyMap<string, readonly Immutable<Album>[]> = new Map();
const emptyAlbumTracks: ReadonlyMap<string, readonly Immutable<Track>[]> = new Map();

/** Read-only bridge while binary caches are migrated. */
export type MemoryView = Readonly<Memory>;

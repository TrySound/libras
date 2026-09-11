import type { Artist, Album, Track, Account, ImageRecord } from "./schema";
import type { Cache, CachedDownload, Immutable } from "./cache.svelte";
export type DownloadView = Immutable<CachedDownload> & Readonly<Account> & { readonly key: string };
export type { Immutable } from "./cache.svelte";

/**
 * Transitional UI view of the selected Cache. No independently writable data
 * collections remain. Download rows add presentation-only account/key fields
 * until app.svelte reads the normalized cache directly.
 */
export class Memory {
  cache = $state.raw<Cache>();

  // Temporary read-only bridge. The selected cache owns all local records.
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

  #downloads = $derived.by((): ReadonlyMap<string, DownloadView> => {
    const cache = this.cache;
    if (!cache) return emptyDownloads;
    return new Map(
      [...cache.downloads].map(([key, record]) => [key, { ...record, ...cache.account, key }]),
    );
  });
  get downloads() {
    return this.#downloads;
  }

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

const emptyDownloads: ReadonlyMap<string, DownloadView> = new Map();
const emptyImages: ReadonlyMap<string, Immutable<ImageRecord>> = new Map();
const emptyArtwork: ReadonlyMap<string, readonly string[]> = new Map();
const emptyQueue: readonly string[] = [];
const emptyArtists: ReadonlyMap<string, Immutable<Artist>> = new Map();
const emptyAlbums: ReadonlyMap<string, Immutable<Album>> = new Map();
const emptyTracks: ReadonlyMap<string, Immutable<Track>> = new Map();
const emptyArtistAlbums: ReadonlyMap<string, readonly Immutable<Album>[]> = new Map();
const emptyAlbumTracks: ReadonlyMap<string, readonly Immutable<Track>[]> = new Map();

/** Read-only bridge until UI migration. */
export type MemoryView = Readonly<Memory>;

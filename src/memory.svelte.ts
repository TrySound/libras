import type { Artist, Album, Track, Account, DownloadedFile, ImageRecord } from "./schema";
import type { Cache, Immutable } from "./cache.svelte";
export type { Immutable } from "./cache.svelte";

/**
 * Transitional state for domains not yet migrated to Cache, plus selection of
 * the active library cache. Library getters delegate; they never copy records.
 * Queue and resource engines still publish their non-library replacements here.
 * ReadonlyMap is a type contract: never mutate a map after publishing it.
 */
export class Memory {
  cache = $state.raw<Cache>();

  // Temporary read-only bridge for engines whose non-library data still lives here.
  // Library records have one owner: the selected account cache.
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

  images = $state.raw<ReadonlyMap<string, Immutable<ImageRecord>>>(new Map());
  artistArtwork = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  albumArtwork = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  trackArtwork = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());

  queueTracks = $state.raw<readonly string[]>([]);
  queueIndex = $state(-1);
  queuePosition = $state(0);

  account = $state.raw<Readonly<Account> | null>(null);
}

const emptyArtists: ReadonlyMap<string, Immutable<Artist>> = new Map();
const emptyAlbums: ReadonlyMap<string, Immutable<Album>> = new Map();
const emptyTracks: ReadonlyMap<string, Immutable<Track>> = new Map();
const emptyArtistAlbums: ReadonlyMap<string, readonly Immutable<Album>[]> = new Map();
const emptyAlbumTracks: ReadonlyMap<string, readonly Immutable<Track>[]> = new Map();

/** Read-only bridge while queue and binary caches are migrated. */
export type MemoryView = Readonly<Memory>;

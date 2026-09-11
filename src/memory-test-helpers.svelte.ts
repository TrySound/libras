import type { Artist, Album, Track, Account, ImageRecord } from "./schema";
import type { DownloadView } from "./memory.svelte";
import type { Immutable, Cache } from "./cache.svelte";

/** Mutable fixture for isolated queue/resource engine tests, not an application data owner. */
export class Memory {
  cache = $state.raw<Cache>();
  artists = $state.raw<ReadonlyMap<string, Immutable<Artist>>>(new Map());
  albums = $state.raw<ReadonlyMap<string, Immutable<Album>>>(new Map());
  tracks = $state.raw<ReadonlyMap<string, Immutable<Track>>>(new Map());
  artistAlbums = $state.raw<ReadonlyMap<string, readonly Immutable<Album>[]>>(new Map());
  albumTracks = $state.raw<ReadonlyMap<string, readonly Immutable<Track>[]>>(new Map());
  downloads = $state.raw<ReadonlyMap<string, DownloadView>>(new Map());
  images = $state.raw<ReadonlyMap<string, Immutable<ImageRecord>>>(new Map());
  artistArtwork = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  albumArtwork = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  trackArtwork = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  get queueTracks() {
    return this.cache?.queue.tracks ?? [];
  }
  get queueIndex() {
    return this.cache?.queue.index ?? -1;
  }
  get queuePosition() {
    return this.cache?.queue.position ?? 0;
  }
  account = $state.raw<Readonly<Account> | null>(null);
}

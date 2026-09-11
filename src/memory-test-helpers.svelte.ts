import type { Artist, Album, Track, Account, DownloadedFile, ImageRecord } from "./schema";
import type { Immutable, Cache } from "./cache.svelte";

/** Mutable fixture for isolated queue/resource engine tests, not an application data owner. */
export class Memory {
  cache = $state.raw<Cache>();
  artists = $state.raw<ReadonlyMap<string, Immutable<Artist>>>(new Map());
  albums = $state.raw<ReadonlyMap<string, Immutable<Album>>>(new Map());
  tracks = $state.raw<ReadonlyMap<string, Immutable<Track>>>(new Map());
  artistAlbums = $state.raw<ReadonlyMap<string, readonly Immutable<Album>[]>>(new Map());
  albumTracks = $state.raw<ReadonlyMap<string, readonly Immutable<Track>[]>>(new Map());
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

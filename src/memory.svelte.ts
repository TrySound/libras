import type { Artist, Album, Track, MetadataAccount, DownloadedFile, ImageRecord } from "./schema";

/** Consumer-facing records are immutable; engines publish replacements. */
export type Immutable<T> = T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T;

/**
 * Passive, per-application memory. No I/O, validation, indexing, or lifecycle logic.
 * Prepare related maps first, replace them synchronously without awaiting, and
 * only notify engine subscribers after all assignments finish.
 * ReadonlyMap is a type contract: never mutate a map after publishing it.
 */
export class Memory {
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

  account = $state.raw<Readonly<MetadataAccount> | null>(null);
}

/** UI consumers read this view; each engine receives only its writable fields. */
export type MemoryView = Readonly<Memory>;

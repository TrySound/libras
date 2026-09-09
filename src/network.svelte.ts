import { SubsonicClient, type SubsonicAuth } from "./subsonic-client";
import type { Album, Artist, Track, MetadataAccount } from "./schema";

export type RemoteArtist = Omit<Artist, "id"> & { id?: string };
export type RemoteAlbum = Omit<Album, "artistId"> & { artistId?: string; artistName?: string };
export type RemoteTrack = Omit<Track, "artistId" | "albumId"> & {
  artistId?: string;
  artistName?: string;
  albumId?: string;
};

/** One captured connection for a complete metadata workflow, including login preparation. */
export interface MetadataConnection {
  readonly account: Readonly<MetadataAccount>;
  readonly signal: AbortSignal;
  getModifiedAt(since?: number): Promise<number | null>;
  listArtists(): Promise<readonly RemoteArtist[]>;
  listAlbums(options: { limit: number; offset: number }): Promise<readonly RemoteAlbum[]>;
  getAlbumTracks(albumId: string): Promise<readonly RemoteTrack[]>;
}

type RemoteQueue = {
  trackIds: readonly string[];
  /** Remote selection is by track ID, not duplicate occurrence index. */
  currentTrackId?: string;
  /** Seconds. */
  position: number;
};

export interface QueueConnection {
  readonly account: Readonly<MetadataAccount>;
  readonly signal: AbortSignal;
  read(): Promise<RemoteQueue>;
  write(queue: RemoteQueue): Promise<void>;
}

type ArtworkValidators = { etag?: string; lastModified?: string };
type RemoteArtwork = ArtworkValidators & { blob: Blob; type: string };

export interface ArtworkConnection {
  readonly account: Readonly<MetadataAccount>;
  readonly signal: AbortSignal;
  /** Browser image requests must be released by the consumer on detachment. */
  url(id: string, size: number): string;
  /** Null means the cached image is unchanged. */
  read(id: string, options: ArtworkValidators & { size: number }): Promise<RemoteArtwork | null>;
}

function genres(item: { genre?: string; genres?: { name: string }[] }) {
  const names = [item.genre ?? "", ...(item.genres ?? []).map((genre) => genre.name)]
    .flatMap((name) => name.split("|"))
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Map(names.map((name) => [name.toLocaleLowerCase(), name])).values()].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Connection ownership and access policy. Engines migrate behind this boundary separately. */
export class Network {
  #mode = $state<"online" | "offline">("offline");
  #client?: SubsonicClient;
  #candidate?: SubsonicClient;

  get mode() {
    return this.#mode;
  }

  setMode(mode: "online" | "offline") {
    this.#mode = mode;
    if (mode === "online") return;
    this.#client?.abort();
    this.#candidate?.abort();
    this.#client = undefined;
    this.#candidate = undefined;
  }

  /** Explicit login validation is allowed while normal access remains offline. */
  prepare(auth: SubsonicAuth) {
    const candidate = new SubsonicClient(auth);
    this.#candidate?.abort();
    this.#candidate = candidate;
    return candidate;
  }

  /** Accept only the live candidate; stale login work must never restore access. */
  accept(candidate: SubsonicClient) {
    candidate.signal.throwIfAborted();
    if (candidate !== this.#candidate) {
      throw new DOMException("Connection superseded.", "AbortError");
    }
    this.#client?.abort();
    this.#client = candidate;
    this.#candidate = undefined;
    this.#mode = "online";
  }

  #check(client: SubsonicClient, allowCandidate = false) {
    client.signal.throwIfAborted();
    if (allowCandidate && client === this.#candidate) return;
    if (client !== this.#client || this.#mode !== "online") {
      throw new DOMException("Connection superseded.", "AbortError");
    }
  }

  async #request<T>(client: SubsonicClient, run: () => Promise<T>, allowCandidate = false) {
    this.#check(client, allowCandidate);
    const result = await run();
    this.#check(client, allowCandidate);
    return result;
  }

  /** Capture metadata operations without exposing SDK requests to the metadata engine. */
  metadata(client: SubsonicClient): MetadataConnection {
    this.#check(client, true);
    const request = <T>(run: () => Promise<T>) => this.#request(client, run, true);
    return {
      account: Object.freeze({ host: client.host, username: client.username }),
      signal: client.signal,
      getModifiedAt: (since) => request(() => client.getIndexes(since)),
      listArtists: () =>
        request(async () =>
          (await client.getArtists()).map((artist) => ({
            id: artist.id,
            name: artist.name,
            artworkId: artist.coverArt || undefined,
            genres: genres(artist),
          })),
        ),
      listAlbums: ({ limit, offset }) =>
        request(async () =>
          (await client.getAlbumList2({ type: "alphabeticalByArtist", size: limit, offset })).map(
            (album) => ({
              id: album.id,
              title: album.name,
              artistId: album.artistId,
              artistName: album.artist,
              artworkId: album.coverArt || undefined,
              year: album.year && album.year > 0 ? album.year : undefined,
              genres: genres(album),
            }),
          ),
        ),
      getAlbumTracks: (albumId) =>
        request(async () =>
          (await client.getAlbum(albumId)).map((track) => ({
            id: track.id,
            title: track.title,
            albumId: track.albumId,
            artistId: track.artistId,
            artistName: track.artist,
            artworkId: track.coverArt || undefined,
            number: track.track && track.track > 0 ? track.track : undefined,
            disc: track.discNumber && track.discNumber > 0 ? track.discNumber : undefined,
            duration: track.duration,
            mimeType: track.contentType,
            genres: genres(track),
          })),
        ),
    };
  }

  /** Queue access is available only after accepting a connection, never during login staging. */
  queue(client: SubsonicClient): QueueConnection {
    this.#check(client);
    return {
      account: Object.freeze({ host: client.host, username: client.username }),
      signal: client.signal,
      read: () =>
        this.#request(client, async () => {
          const queue = await client.getPlayQueue();
          return {
            trackIds: queue.tracks,
            currentTrackId: queue.current,
            position: queue.position,
          };
        }),
      write: (queue) =>
        this.#request(client, () =>
          client.savePlayQueue({
            tracks: queue.trackIds,
            current: queue.currentTrackId,
            position: queue.position,
          }),
        ),
    };
  }

  artwork(client: SubsonicClient): ArtworkConnection {
    this.#check(client);
    return {
      account: Object.freeze({ host: client.host, username: client.username }),
      signal: client.signal,
      url: (id, size) => {
        this.#check(client);
        return client.getCoverArtUrl(id, size);
      },
      read: (id, options) =>
        this.#request(client, async () => {
          const headers = new Headers();
          if (options.etag) headers.set("If-None-Match", options.etag);
          if (options.lastModified) headers.set("If-Modified-Since", options.lastModified);
          const response = await fetch(client.getCoverArtUrl(id, options.size), {
            headers,
            signal: client.signal,
          });
          this.#check(client);
          if (response.status === 304 && (options.etag || options.lastModified)) return null;
          if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
          const blob = await response.blob();
          return {
            blob,
            type: response.headers.get("Content-Type")?.split(";")[0] ?? "image/jpeg",
            etag: response.headers.get("ETag") ?? undefined,
            lastModified: response.headers.get("Last-Modified") ?? undefined,
          };
        }),
    };
  }

  /** Resume an authenticated session after access has explicitly been enabled. */
  open(auth: SubsonicAuth) {
    if (this.#mode === "offline") throw new Error("Network access is offline.");
    const client = this.prepare(auth);
    this.accept(client);
    return client;
  }
}

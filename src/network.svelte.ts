import { SubsonicClient, createSubsonicAuth } from "./subsonic-client";
import { authSchema, type Auth } from "./auth";
import * as v from "valibot";
import type { Album, Artist, Track, Account } from "./schema";

/** Fetch failed before returning a response; browsers do not expose a reliable CORS diagnosis. */
export class NetworkTransportError extends Error {
  constructor(cause: unknown) {
    super("The server request failed.", { cause });
    this.name = "NetworkTransportError";
  }
}

export interface PasswordAuth {
  host: string;
  username: string;
  password: string;
}

/** Credential-free identity for one connection lifetime, owned by its Network. */
export interface NetworkConnection {
  readonly account: Readonly<Account>;
  readonly signal: AbortSignal;
}

export type RemoteArtist = Omit<Artist, "id"> & { id?: string };
export type RemoteAlbum = Omit<Album, "artistId"> & { artistId?: string; artistName?: string };
export type RemoteTrack = Omit<Track, "artistId" | "albumId"> & {
  artistId?: string;
  artistName?: string;
  albumId?: string;
};

type RemoteLibrary = {
  artists: readonly RemoteArtist[];
  albums: readonly RemoteAlbum[];
  tracksByAlbum: ReadonlyMap<string, readonly RemoteTrack[]>;
};

/** One captured connection for a complete metadata workflow, including login preparation. */
export interface MetadataConnection extends NetworkConnection {
  getModifiedAt(since?: number): Promise<number | null>;
  readLibrary(signal: AbortSignal): Promise<RemoteLibrary>;
}

type RemoteQueue = {
  trackIds: readonly string[];
  /** Remote selection is by track ID, not duplicate occurrence index. */
  currentTrackId?: string;
  /** Seconds. */
  position: number;
};

export interface QueueConnection extends NetworkConnection {
  read(): Promise<RemoteQueue>;
  write(queue: RemoteQueue): Promise<void>;
}

type AudioFormat = "raw" | "mp3";

export interface AudioConnection extends NetworkConnection {
  /** Browser playback must release network media explicitly on detachment. Position is seconds. */
  url(id: string, options: { format: AudioFormat; position?: number }): string;
  /** The consumer streams the body to storage and must cancel any unused response. */
  read(id: string, options: { format: AudioFormat; signal: AbortSignal }): Promise<Response>;
}

type ArtworkValidators = { etag?: string; lastModified?: string };
type RemoteArtwork = ArtworkValidators & { blob: Blob; type: string };

export interface ArtworkConnection extends NetworkConnection {
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

type ConnectionEntry = { handle: NetworkConnection; client: SubsonicClient };

/** Application server access, connection ownership, and cancellation policy. */
export class Network {
  #mode = $state<"online" | "offline">("offline");
  #active?: ConnectionEntry;
  #candidate?: ConnectionEntry;

  get mode() {
    return this.#mode;
  }

  setMode(mode: "online" | "offline") {
    this.#mode = mode;
    if (mode === "online") return;
    this.#active?.client.abort();
    this.#candidate?.client.abort();
    this.#active = undefined;
    this.#candidate = undefined;
  }

  /** Prepare credentials without enabling access, persisting data, or making requests. */
  createAuth(input: PasswordAuth): Auth {
    const host = input.host.trim();
    const withProtocol = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    return v.parse(
      authSchema,
      createSubsonicAuth({
        host: new URL(withProtocol).toString().replace(/\/$/, ""),
        username: input.username,
        password: input.password,
      }),
    );
  }

  /** Explicit login validation is allowed while normal access remains offline. */
  prepare(auth: Auth): NetworkConnection {
    const candidate = new SubsonicClient(auth, {
      fetch: (input, init) => this.#fetch(input, init),
    });
    this.#candidate?.client.abort();
    const connection = Object.freeze({
      account: Object.freeze({ host: candidate.host, username: candidate.username }),
      signal: candidate.signal,
    });
    this.#candidate = { handle: connection, client: candidate };
    return connection;
  }

  /** Accept only the live candidate; stale login work must never restore access. */
  accept(connection: NetworkConnection) {
    connection.signal.throwIfAborted();
    const candidate = this.#candidate;
    if (!candidate || candidate.handle !== connection) {
      throw new DOMException("Connection superseded.", "AbortError");
    }
    this.#active?.client.abort();
    this.#active = candidate;
    this.#candidate = undefined;
    this.#mode = "online";
  }

  #resolve(connection: NetworkConnection) {
    connection.signal.throwIfAborted();
    if (this.#active?.handle === connection) return this.#active.client;
    if (this.#candidate?.handle === connection) return this.#candidate.client;
    throw new DOMException("Connection superseded.", "AbortError");
  }

  #check(client: SubsonicClient, allowCandidate = false) {
    client.signal.throwIfAborted();
    if (allowCandidate && client === this.#candidate?.client) return;
    if (client !== this.#active?.client || this.#mode !== "online") {
      throw new DOMException("Connection superseded.", "AbortError");
    }
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit) {
    try {
      return await fetch(input, init);
    } catch (error) {
      init?.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new NetworkTransportError(error);
    }
  }

  async #request<T>(client: SubsonicClient, run: () => Promise<T>, allowCandidate = false) {
    this.#check(client, allowCandidate);
    const result = await run();
    this.#check(client, allowCandidate);
    return result;
  }

  /** Capture metadata operations without exposing SDK requests to the metadata engine. */
  metadata(connection: NetworkConnection): MetadataConnection {
    const client = this.#resolve(connection);
    this.#check(client, true);
    return {
      account: connection.account,
      signal: connection.signal,
      getModifiedAt: (since) => this.#request(client, () => client.getIndexes(since), true),
      readLibrary: (signal) => this.#readLibrary(client, signal),
    };
  }

  async #readLibrary(client: SubsonicClient, workflowSignal: AbortSignal): Promise<RemoteLibrary> {
    const controller = new AbortController();
    // The SDK adds its connection signal to each request.
    const signal = AbortSignal.any([workflowSignal, controller.signal]);
    const check = () => {
      signal.throwIfAborted();
      this.#check(client, true);
    };
    const read = async <T>(run: () => Promise<T>) => {
      check();
      const result = await run();
      check();
      return result;
    };
    const listArtists = () =>
      read(async () =>
        (await client.getArtists(signal)).map((artist) => ({
          id: artist.id,
          name: artist.name,
          artworkId: artist.coverArt || undefined,
          genres: genres(artist),
        })),
      );
    const listAlbums = (offset: number) =>
      read(async () =>
        (
          await client.getAlbumList2({ type: "alphabeticalByArtist", size: 500, offset }, signal)
        ).map((album) => ({
          id: album.id,
          title: album.name,
          artistId: album.artistId,
          artistName: album.artist,
          artworkId: album.coverArt || undefined,
          year: album.year && album.year > 0 ? album.year : undefined,
          genres: genres(album),
        })),
      );
    const getAlbumTracks = (albumId: string) =>
      read(async () =>
        (await client.getAlbum(albumId, signal)).map((track) => ({
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
      );
    const fetchAlbums = async () => {
      const albums: RemoteAlbum[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = await listAlbums(offset);
        albums.push(...page);
        if (page.length < 500) return albums;
      }
    };
    try {
      const [artists, albums] = await Promise.all([listArtists(), fetchAlbums()]);
      check();
      const tracksByAlbum = new Map<string, readonly RemoteTrack[]>();
      let next = 0;
      const worker = async () => {
        while (next < albums.length) {
          check();
          const album = albums[next++];
          tracksByAlbum.set(album.id, await getAlbumTracks(album.id));
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, albums.length) }, worker));
      check();
      return { artists, albums, tracksByAlbum };
    } finally {
      // Cancel sibling requests on failure without revoking the connection.
      controller.abort();
    }
  }

  /** Queue access is available only after accepting a connection, never during login staging. */
  queue(connection: NetworkConnection): QueueConnection {
    const client = this.#resolve(connection);
    this.#check(client);
    return {
      account: connection.account,
      signal: connection.signal,
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

  artwork(connection: NetworkConnection): ArtworkConnection {
    const client = this.#resolve(connection);
    this.#check(client);
    return {
      account: connection.account,
      signal: connection.signal,
      url: (id, size) => {
        this.#check(client);
        return client.getCoverArtUrl(id, size);
      },
      read: (id, options) =>
        this.#request(client, async () => {
          const headers = new Headers();
          if (options.etag) headers.set("If-None-Match", options.etag);
          if (options.lastModified) headers.set("If-Modified-Since", options.lastModified);
          const response = await this.#fetch(client.getCoverArtUrl(id, options.size), {
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

  audio(connection: NetworkConnection): AudioConnection {
    const client = this.#resolve(connection);
    this.#check(client);
    const url = (id: string, options: { format: AudioFormat; position?: number }) => {
      this.#check(client);
      return client.getStreamUrl(id, {
        format: options.format,
        estimateContentLength: true,
        timeOffset: options.position,
      });
    };
    return {
      account: connection.account,
      signal: connection.signal,
      url,
      read: async (id, options) => {
        const signal = AbortSignal.any([client.signal, options.signal]);
        signal.throwIfAborted();
        const response = await this.#fetch(url(id, { format: options.format }), { signal });
        try {
          this.#check(client);
          signal.throwIfAborted();
          if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
          return response;
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          throw error;
        }
      },
    };
  }

  /** Resume an authenticated session after access has explicitly been enabled. */
  open(auth: Auth) {
    if (this.#mode === "offline") throw new Error("Network access is offline.");
    const connection = this.prepare(auth);
    this.accept(connection);
    return connection;
  }
}

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
interface NetworkIdentity {
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

export type MetadataConnection = Pick<
  MetadataAccess,
  "account" | "signal" | "getModifiedAt" | "readLibrary"
>;
export type NetworkConnection = Readonly<NetworkIdentity & { metadata: MetadataConnection }>;
export type ActiveNetworkConnection = Readonly<
  NetworkConnection & {
    queue: QueueConnection;
    artwork: ArtworkConnection;
    audio: AudioConnection;
  }
>;

type RemoteQueue = {
  trackIds: readonly string[];
  /** Remote selection is by track ID, not duplicate occurrence index. */
  currentTrackId?: string;
  /** Seconds. */
  position: number;
};

export type QueueConnection = Pick<QueueAccess, "account" | "signal" | "read" | "write">;

type AudioFormat = "raw" | "mp3";

export type AudioConnection = Pick<AudioAccess, "account" | "signal" | "url" | "read">;

type ArtworkValidators = { etag?: string; lastModified?: string };
type RemoteArtwork = ArtworkValidators & { blob: Blob; type: string };

export type ArtworkConnection = Pick<ArtworkAccess, "account" | "signal" | "url" | "read">;

function genres(item: { genre?: string; genres?: { name: string }[] }) {
  const names = [item.genre ?? "", ...(item.genres ?? []).map((genre) => genre.name)]
    .flatMap((name) => name.split("|"))
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Map(names.map((name) => [name.toLocaleLowerCase(), name])).values()].sort((a, b) =>
    a.localeCompare(b),
  );
}

type Request = <T>(run: () => Promise<T>) => Promise<T>;

async function networkFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (error) {
    init?.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new NetworkTransportError(error);
  }
}

class MetadataAccess {
  readonly account: Readonly<Account>;
  readonly signal: AbortSignal;
  readonly #client: SubsonicClient;
  readonly #request: Request;

  constructor(account: Readonly<Account>, client: SubsonicClient, request: Request) {
    this.account = account;
    this.signal = client.signal;
    this.#client = client;
    this.#request = request;
  }

  getModifiedAt(since?: number) {
    return this.#request(() => this.#client.getIndexes(since));
  }

  async readLibrary(workflowSignal: AbortSignal): Promise<RemoteLibrary> {
    const controller = new AbortController();
    const signal = AbortSignal.any([workflowSignal, controller.signal]);
    const read = async <T>(run: () => Promise<T>) => {
      signal.throwIfAborted();
      const result = await this.#request(run);
      signal.throwIfAborted();
      return result;
    };
    const listArtists = () =>
      read(async () =>
        (await this.#client.getArtists(signal)).map((artist) => ({
          id: artist.id,
          name: artist.name,
          artworkId: artist.coverArt || undefined,
          genres: genres(artist),
        })),
      );
    const listAlbums = (offset: number) =>
      read(async () =>
        (
          await this.#client.getAlbumList2(
            { type: "alphabeticalByArtist", size: 500, offset },
            signal,
          )
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
        (await this.#client.getAlbum(albumId, signal)).map((track) => ({
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
      signal.throwIfAborted();
      const tracksByAlbum = new Map<string, readonly RemoteTrack[]>();
      let next = 0;
      const worker = async () => {
        while (next < albums.length) {
          signal.throwIfAborted();
          const album = albums[next++];
          tracksByAlbum.set(album.id, await getAlbumTracks(album.id));
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, albums.length) }, worker));
      signal.throwIfAborted();
      return { artists, albums, tracksByAlbum };
    } finally {
      controller.abort();
    }
  }
}

class QueueAccess {
  readonly account: Readonly<Account>;
  readonly signal: AbortSignal;
  readonly #client: SubsonicClient;
  readonly #request: Request;

  constructor(account: Readonly<Account>, client: SubsonicClient, request: Request) {
    this.account = account;
    this.signal = client.signal;
    this.#client = client;
    this.#request = request;
  }

  async read(): Promise<RemoteQueue> {
    const queue = await this.#request(() => this.#client.getPlayQueue());
    return {
      trackIds: queue.tracks,
      currentTrackId: queue.current,
      position: queue.position,
    };
  }

  write(queue: RemoteQueue) {
    return this.#request(() =>
      this.#client.savePlayQueue({
        tracks: queue.trackIds,
        current: queue.currentTrackId,
        position: queue.position,
      }),
    );
  }
}

class ArtworkAccess {
  readonly account: Readonly<Account>;
  readonly signal: AbortSignal;
  readonly #client: SubsonicClient;
  readonly #request: Request;

  constructor(account: Readonly<Account>, client: SubsonicClient, request: Request) {
    this.account = account;
    this.signal = client.signal;
    this.#client = client;
    this.#request = request;
  }

  url(id: string, size: number) {
    this.signal.throwIfAborted();
    return this.#client.getCoverArtUrl(id, size);
  }

  read(id: string, options: ArtworkValidators & { size: number }) {
    return this.#request(async () => {
      const headers = new Headers();
      if (options.etag) headers.set("If-None-Match", options.etag);
      if (options.lastModified) headers.set("If-Modified-Since", options.lastModified);
      const response = await networkFetch(this.#client.getCoverArtUrl(id, options.size), {
        headers,
        signal: this.signal,
      });
      this.signal.throwIfAborted();
      if (response.status === 304 && (options.etag || options.lastModified)) return null;
      if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
      const blob = await response.blob();
      return {
        blob,
        type: response.headers.get("Content-Type")?.split(";")[0] ?? "image/jpeg",
        etag: response.headers.get("ETag") ?? undefined,
        lastModified: response.headers.get("Last-Modified") ?? undefined,
      } satisfies RemoteArtwork;
    });
  }
}

class AudioAccess {
  readonly account: Readonly<Account>;
  readonly signal: AbortSignal;
  readonly #client: SubsonicClient;
  readonly #request: Request;

  constructor(account: Readonly<Account>, client: SubsonicClient, request: Request) {
    this.account = account;
    this.signal = client.signal;
    this.#client = client;
    this.#request = request;
  }

  url(id: string, options: { format: AudioFormat; position?: number }) {
    this.signal.throwIfAborted();
    return this.#client.getStreamUrl(id, {
      format: options.format,
      estimateContentLength: true,
      timeOffset: options.position,
    });
  }

  async read(id: string, options: { format: AudioFormat; signal: AbortSignal }) {
    const signal = AbortSignal.any([this.signal, options.signal]);
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      return await this.#request(async () => {
        response = await networkFetch(this.url(id, { format: options.format }), { signal });
        signal.throwIfAborted();
        if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
        return response;
      });
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      throw error;
    }
  }
}

type CandidateConnection = { handle: NetworkConnection; client: SubsonicClient };

/** Application server access, connection ownership, and cancellation policy. */
export class Network {
  #mode = $state<"online" | "offline">("offline");
  #active?: SubsonicClient;
  #candidate?: CandidateConnection;

  get mode() {
    return this.#mode;
  }

  setMode(mode: "online" | "offline") {
    this.#mode = mode;
    if (mode === "online") return;
    this.#active?.abort();
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
    const client = new SubsonicClient(auth, { fetch: networkFetch });
    this.#candidate?.client.abort();
    const account = Object.freeze({ host: client.host, username: client.username });
    const request: Request = (run) => this.#request(client, run);
    const metadata = Object.freeze(new MetadataAccess(account, client, request));
    const connection = Object.freeze({ account, signal: client.signal, metadata });
    this.#candidate = { handle: connection, client };
    return connection;
  }

  /** Accept only the live candidate; stale login work must never restore access. */
  accept(connection: NetworkConnection): ActiveNetworkConnection {
    connection.signal.throwIfAborted();
    const candidate = this.#candidate;
    if (!candidate || candidate.handle !== connection) {
      throw new DOMException("Connection superseded.", "AbortError");
    }
    const { client } = candidate;
    const request: Request = (run) => this.#request(client, run);
    const queue = Object.freeze(new QueueAccess(connection.account, client, request));
    const artwork = Object.freeze(new ArtworkAccess(connection.account, client, request));
    const audio = Object.freeze(new AudioAccess(connection.account, client, request));
    const active = Object.freeze({ ...connection, queue, artwork, audio });
    this.#active?.abort();
    this.#active = client;
    this.#candidate = undefined;
    this.#mode = "online";
    return active;
  }

  async #request<T>(client: SubsonicClient, run: () => Promise<T>) {
    client.signal.throwIfAborted();
    const result = await run();
    client.signal.throwIfAborted();
    return result;
  }

  /** Resume an authenticated session after access has explicitly been enabled. */
  open(auth: Auth) {
    if (this.#mode === "offline") throw new Error("Network access is offline.");
    const connection = this.prepare(auth);
    return this.accept(connection);
  }
}

import * as v from "valibot";
import { md5 } from "js-md5";
import { credentialsSchema, type Auth, type Credentials } from "./auth";

/** Protocol requests need a host and secrets, not a resolved cache/account identity. */
export interface SubsonicAuth {
  host: string;
  credentials: Credentials;
}

const reservedParameters = new Set(["u", "p", "t", "s", "apiKey", "v", "c", "f"]);

/** The only place that translates credentials into wire parameters. */
export function authenticationParameters(credentials: Credentials): URLSearchParams {
  switch (credentials.method) {
    case "apiKey":
      return new URLSearchParams({ apiKey: credentials.apiKey });
    case "token":
      return new URLSearchParams({
        u: credentials.username,
        t: credentials.token,
        s: credentials.salt,
      });
    case "password": {
      // A literal enc: prefix must be escaped using the protocol's hex encoding.
      // This is only encoding, not encryption or another authentication method.
      const password = credentials.password.startsWith("enc:")
        ? `enc:${Array.from(new TextEncoder().encode(credentials.password), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
        : credentials.password;
      return new URLSearchParams({ u: credentials.username, p: password });
    }
  }
}

export class SubsonicError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SubsonicError";
  }
}

/** Fetch exceptions can contain credential-bearing URLs; never retain their causes. */
export class SubsonicTransportError extends Error {
  constructor() {
    super("The server request failed.");
    this.name = "SubsonicTransportError";
  }
}

export class SubsonicHttpError extends Error {
  constructor(readonly status: number) {
    super(`The server returned HTTP ${status}.`);
    this.name = "SubsonicHttpError";
  }
}

const extensionSchema = v.object({ name: v.string(), versions: v.array(v.number()) });
export type OpenSubsonicExtension = v.InferOutput<typeof extensionSchema>;

/** Discovery is public. Failures remain errors, not evidence of missing capabilities. */
export function getOpenSubsonicExtensions(
  host: string,
  options: SubsonicClientOptions = {},
  signal?: AbortSignal,
): Promise<OpenSubsonicExtension[]> {
  return new SubsonicClient({ host }, options).getOpenSubsonicExtensions(signal);
}

/** Prepare token authentication without retaining the password or making a request. */
export function createSubsonicAuth(input: {
  host: string;
  username: string;
  password: string;
}): Auth & { credentials: Extract<Credentials, { method: "token" }> } {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const salt = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    host: input.host,
    username: input.username,
    credentials: {
      method: "token",
      username: input.username,
      token: md5(input.password + salt),
      salt,
    },
  };
}

const genreSchema = v.object({ name: v.string() });
const artistSchema = v.object({
  id: v.string(),
  name: v.string(),
  coverArt: v.optional(v.string()),
});

const albumSchema = v.object({
  id: v.string(),
  name: v.string(),
  artists: v.optional(v.array(artistSchema)),
  displayArtist: v.optional(v.string()),
  coverArt: v.optional(v.string()),
  genres: v.optional(v.array(genreSchema)),
  year: v.optional(v.number()),
});

const trackSchema = v.object({
  id: v.string(),
  title: v.string(),
  album: v.optional(v.string()),
  albumId: v.optional(v.string()),
  artists: v.optional(v.array(artistSchema)),
  displayArtist: v.optional(v.string()),
  duration: v.optional(v.number()),
  contentType: v.optional(v.string()),
  coverArt: v.optional(v.string()),
  discNumber: v.optional(v.number()),
  genres: v.optional(v.array(genreSchema)),
  track: v.optional(v.number()),
});

const playlistSchema = v.object({
  id: v.string(),
  name: v.string(),
  owner: v.optional(v.string()),
  public: v.optional(v.boolean()),
  coverArt: v.optional(v.string()),
  songCount: v.optional(v.number()),
  changed: v.optional(v.string()),
  entry: v.optional(v.array(trackSchema)),
});

export type SubsonicPlaylist = v.InferOutput<typeof playlistSchema>;

const serverInfoSchema = v.object({
  version: v.string(),
  type: v.string(),
  serverVersion: v.string(),
  openSubsonic: v.literal(true),
});

export const responseSchema = v.object({
  "subsonic-response": v.object({
    status: v.string(),
    // Keep identity optional here so minimal failures retain their actual error.
    // ping() validates the complete OpenSubsonic identity after request success.
    version: v.optional(v.string()),
    type: v.optional(v.string()),
    serverVersion: v.optional(v.string()),
    openSubsonic: v.optional(v.boolean()),
    error: v.optional(v.object({ code: v.optional(v.number()), message: v.optional(v.string()) })),
    openSubsonicExtensions: v.optional(v.array(extensionSchema)),
    tokenInfo: v.optional(v.object({ username: v.pipe(v.string(), v.nonEmpty()) })),
    indexes: v.optional(v.object({ lastModified: v.optional(v.union([v.number(), v.string()])) })),
    searchResult3: v.optional(
      v.object({
        artist: v.optional(v.array(artistSchema)),
        album: v.optional(v.array(albumSchema)),
        song: v.optional(v.array(trackSchema)),
      }),
    ),
    playlists: v.optional(v.object({ playlist: v.optional(v.array(playlistSchema)) })),
    playlist: v.optional(playlistSchema),
    playQueue: v.optional(
      v.object({
        current: v.optional(v.string()),
        entry: v.optional(v.array(v.object({ id: v.string() }))),
        position: v.optional(v.number()),
      }),
    ),
  }),
});

type SubsonicResponse = v.InferOutput<typeof responseSchema>["subsonic-response"];
export type SubsonicArtist = v.InferOutput<typeof artistSchema>;
export type SubsonicAlbum = v.InferOutput<typeof albumSchema>;
export type SubsonicTrack = v.InferOutput<typeof trackSchema>;
export type OpenSubsonicServerInfo = v.InferOutput<typeof serverInfoSchema>;

export interface SubsonicPlayQueue {
  current?: string;
  position: number;
  tracks: readonly string[];
}

export interface SubsonicStreamOptions {
  estimateContentLength?: boolean;
  timeOffset?: number;
  format?: "raw" | "mp3";
}

export interface SubsonicClientOptions {
  apiVersion?: string;
  clientName?: string;
  fetch?: typeof fetch;
  /** Only capabilities actually advertised by this server. Version 1 is supported. */
  extensions?: readonly OpenSubsonicExtension[];
}

/** Public protocol surface; alternate transports need not inherit private client state. */
export type SubsonicApi = Omit<
  Pick<SubsonicClient, keyof SubsonicClient>,
  "getStreamUrl" | "getOpenSubsonicExtensions" | "tokenInfo"
> & {
  getStreamUrl(
    id: string,
    options?: SubsonicStreamOptions,
    signal?: AbortSignal,
  ): string | Promise<string>;
};
export type SubsonicClientFactory = (
  auth: SubsonicAuth,
  options: SubsonicClientOptions,
) => SubsonicApi;

export class SubsonicClient {
  #apiVersion: string;
  #auth: { host: string; credentials?: Credentials };
  #formPost: boolean;
  #clientName: string;
  #fetch: typeof fetch;
  #controller = new AbortController();

  constructor(
    auth: { host: string; credentials?: Credentials },
    options: SubsonicClientOptions = {},
  ) {
    const credentials = auth.credentials && v.safeParse(credentialsSchema, auth.credentials);
    if (credentials && !credentials.success)
      throw new Error("The Subsonic authentication is invalid.");
    this.#auth = { host: auth.host, credentials: credentials?.output };
    this.#formPost =
      options.extensions?.some(
        (extension) => extension.name === "formPost" && extension.versions.includes(1),
      ) ?? false;
    this.#apiVersion = options.apiVersion ?? "1.16.1";
    this.#clientName = options.clientName ?? "libras";
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  get signal() {
    return this.#controller.signal;
  }

  abort() {
    this.#controller.abort();
  }

  get host() {
    return this.#auth.host;
  }

  #query(
    params?: Record<string, string | number | boolean | undefined> | URLSearchParams,
    authenticated = true,
  ) {
    this.signal.throwIfAborted();
    const query = new URLSearchParams({ v: this.#apiVersion, c: this.#clientName, f: "json" });
    if (authenticated && this.#auth.credentials) {
      for (const [name, value] of authenticationParameters(this.#auth.credentials))
        query.set(name, value);
    }
    const entries = params instanceof URLSearchParams ? params : Object.entries(params ?? {});
    for (const [name, value] of entries) {
      if (!reservedParameters.has(name) && value !== undefined) query.append(name, String(value));
    }
    return query;
  }

  #safeMessage(message: string | undefined) {
    if (!message) return "The Subsonic server rejected the request.";
    // Do not display echoed URLs. Redact both stored and wire-encoded secrets;
    // protocol codes remain available for the caller's policy decisions.
    if (/(?:https?:\/\/|[?&](?:u|p|t|s|apiKey)=)/i.test(message))
      return "The Subsonic server rejected the request.";
    const credentials = this.#auth.credentials;
    const values = [
      ...Object.entries(credentials ?? {}),
      ...(credentials ? authenticationParameters(credentials) : []),
    ];
    const secrets = new Set<string>();
    for (const [key, value] of values) {
      if (key === "method" || !value) continue;
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
      secrets.add(new URLSearchParams({ x: value }).toString().slice(2));
    }
    if (!secrets.size) return message;
    // Match complete overlapping secrets first, without reprocessing replacement markers.
    const pattern = [...secrets]
      .sort((a, b) => b.length - a.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return message.replace(new RegExp(pattern, "g"), () => "[redacted]");
  }

  #url(path: string, query: URLSearchParams) {
    return `${this.#auth.host}/rest/${path}.view?${query}`;
  }

  async #parse(response: Response, signal = this.signal): Promise<SubsonicResponse> {
    signal.throwIfAborted();
    if (!response.ok) throw new SubsonicHttpError(response.status);
    let input: unknown;
    try {
      input = await response.json();
    } catch {
      signal.throwIfAborted();
      throw new Error("The server returned an invalid Subsonic response.");
    }
    const parsed = v.safeParse(responseSchema, input);
    signal.throwIfAborted();
    if (!parsed.success) throw new Error("The server returned an invalid Subsonic response.");
    const result = parsed.output["subsonic-response"];
    if (result.status !== "ok") {
      throw new SubsonicError(result.error?.code, this.#safeMessage(result.error?.message));
    }
    return result;
  }

  async #get(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    requestSignal?: AbortSignal,
  ) {
    const signal = requestSignal ? AbortSignal.any([this.signal, requestSignal]) : this.signal;
    signal.throwIfAborted();
    const query = this.#query(params);
    return this.#send(path, query, { signal, post: this.#formPost });
  }

  async #send(
    path: string,
    query: URLSearchParams,
    options: { signal: AbortSignal; post?: boolean; keepalive?: boolean },
  ) {
    const { signal, post, keepalive } = options;
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path, post ? new URLSearchParams() : query), {
        signal,
        ...(post
          ? {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: query,
              ...(keepalive ? { keepalive } : {}),
            }
          : {}),
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError")
        throw new DOMException("The server request was cancelled.", "AbortError");
      throw new SubsonicTransportError();
    }
    return this.#parse(response, signal);
  }

  async #post(path: string, params: URLSearchParams) {
    return this.#send(path, this.#query(params), { signal: this.signal, post: true });
  }

  async getOpenSubsonicExtensions(requestSignal?: AbortSignal): Promise<OpenSubsonicExtension[]> {
    const signal = requestSignal ? AbortSignal.any([this.signal, requestSignal]) : this.signal;
    const result = await this.#send("getOpenSubsonicExtensions", this.#query(undefined, false), {
      signal,
    });
    if (!result.openSubsonicExtensions)
      throw new Error("The server returned an invalid extensions response.");
    return result.openSubsonicExtensions;
  }

  /** Validate an API key and resolve its account username; never tries another method. */
  async tokenInfo(requestSignal?: AbortSignal): Promise<{ username: string }> {
    if (this.#auth.credentials?.method !== "apiKey")
      throw new Error("API-key credentials are required for tokenInfo.");
    const result = await this.#get("tokenInfo", undefined, requestSignal);
    if (!result.tokenInfo) throw new Error("The server returned an invalid tokenInfo response.");
    return result.tokenInfo;
  }

  async getPlaylists(): Promise<SubsonicPlaylist[]> {
    const result = await this.#get("getPlaylists");
    if (!result.playlists) throw new Error("The server returned an invalid playlists response.");
    return result.playlists.playlist ?? [];
  }

  async getPlaylist(id: string): Promise<SubsonicPlaylist> {
    const result = await this.#get("getPlaylist", { id });
    if (!result.playlist) throw new Error("The server returned an invalid playlist response.");
    return result.playlist;
  }

  async createPlaylist(
    name: string,
    songIds: readonly string[] = [],
  ): Promise<SubsonicPlaylist | undefined> {
    const params = new URLSearchParams({ name });
    for (const id of songIds) params.append("songId", id);
    return (await this.#post("createPlaylist", params)).playlist;
  }

  async replacePlaylist(id: string, songIds: readonly string[]): Promise<void> {
    const params = new URLSearchParams({ playlistId: id });
    for (const songId of songIds) params.append("songId", songId);
    await this.#post("createPlaylist", params);
  }

  async updatePlaylist(
    id: string,
    options: {
      name?: string;
      songIdsToAdd?: readonly string[];
      songIndexesToRemove?: readonly number[];
    },
  ): Promise<void> {
    const params = new URLSearchParams({ playlistId: id });
    if (options.name !== undefined) params.set("name", options.name);
    for (const songId of options.songIdsToAdd ?? []) params.append("songIdToAdd", songId);
    for (const index of options.songIndexesToRemove ?? [])
      params.append("songIndexToRemove", String(index));
    await this.#post("updatePlaylist", params);
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.#post("deletePlaylist", new URLSearchParams({ id }));
  }

  async ping(): Promise<OpenSubsonicServerInfo> {
    const result = await this.#get("ping");
    const parsed = v.safeParse(serverInfoSchema, result);
    if (!parsed.success)
      throw new Error("The server did not return a valid OpenSubsonic identity.");
    return parsed.output;
  }

  async getIndexes(ifModifiedSince?: number) {
    const result = await this.#get("getIndexes", { ifModifiedSince });
    if (!result.indexes) return null;
    const lastModified = Number(result.indexes.lastModified);
    return Number.isFinite(lastModified) ? lastModified : null;
  }

  async search3(
    options: {
      artistCount: number;
      artistOffset: number;
      albumCount: number;
      albumOffset: number;
      songCount: number;
      songOffset: number;
    },
    signal?: AbortSignal,
  ) {
    const result = await this.#get("search3", { query: "", ...options }, signal);
    if (!result.searchResult3) throw new Error("The server returned an invalid Subsonic response.");
    return {
      artists: result.searchResult3.artist ?? [],
      albums: result.searchResult3.album ?? [],
      tracks: result.searchResult3.song ?? [],
    };
  }

  getCoverArtUrl(id: string, size?: number) {
    const query = this.#query({ id, size });
    return this.#url("getCoverArt", query);
  }

  getStreamUrl(id: string, options: SubsonicStreamOptions = {}) {
    const query = this.#query({
      id,
      format: options.format,
      estimateContentLength: options.estimateContentLength,
      timeOffset: options.timeOffset,
    });
    return this.#url("stream", query);
  }

  async getPlayQueue(): Promise<SubsonicPlayQueue> {
    const result = await this.#get("getPlayQueue");
    return {
      current: result.playQueue?.current,
      position: (result.playQueue?.position ?? 0) / 1000,
      tracks: result.playQueue?.entry?.map((track) => track.id) ?? [],
    };
  }

  async savePlayQueue(state: SubsonicPlayQueue) {
    const params = new URLSearchParams();
    for (const id of state.tracks) params.append("id", id);
    if (state.current) {
      params.set("current", state.current);
      params.set("position", String(Math.round(state.position * 1000)));
    }
    await this.#send("savePlayQueue", this.#query(params), {
      signal: this.signal,
      post: true,
      keepalive: true,
    });
  }
}

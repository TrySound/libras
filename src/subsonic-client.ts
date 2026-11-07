import * as v from "valibot";
import { credentialsSchema, normalizeAndValidateServerHost, type Credentials } from "./auth";

export interface SubsonicAuth {
  host: string;
  credentials: Credentials;
}

const reservedParameters = new Set(["u", "p", "t", "s", "v", "c", "f"]);

/** The only translation of credentials to wire parameters, including media URLs. */
function authenticationParameters(credentials: Credentials): URLSearchParams {
  if (credentials.method === "token")
    return new URLSearchParams({
      u: credentials.username,
      t: credentials.token,
      s: credentials.salt,
    });
  // Subsonic interprets enc: as hex. Escape a literal prefix; this is not encryption.
  const password = credentials.password.startsWith("enc:")
    ? `enc:${Array.from(new TextEncoder().encode(credentials.password), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    : credentials.password;
  return new URLSearchParams({ u: credentials.username, p: password });
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

/** Request exceptions can contain credential-bearing URLs; never retain causes. */
export class SubsonicTransportError extends Error {
  constructor() {
    super("The server request failed.");
    this.name = "SubsonicTransportError";
  }
}

/** Sanitize only fetch exceptions; response status, parsing and media bodies stay with callers. */
export async function subsonicFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (error) {
    init?.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError")
      throw new DOMException("The server request was cancelled.", "AbortError");
    throw new SubsonicTransportError();
  }
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

const responseSchema = v.object({
  "subsonic-response": v.object({
    status: v.picklist(["ok", "failed"]),
    // Keep identity optional here so minimal failures retain their actual error.
    // ping() validates the complete OpenSubsonic identity after request success.
    version: v.optional(v.string()),
    type: v.optional(v.string()),
    serverVersion: v.optional(v.string()),
    openSubsonic: v.optional(v.boolean()),
    error: v.optional(v.object({ code: v.optional(v.number()), message: v.optional(v.string()) })),
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
type OpenSubsonicServerInfo = v.InferOutput<typeof serverInfoSchema>;

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

interface SubsonicClientOptions {
  apiVersion?: string;
  clientName?: string;
  fetch?: typeof fetch;
}

/** Public protocol surface; alternate transports need not inherit private client state. */
export type SubsonicApi = Omit<Pick<SubsonicClient, keyof SubsonicClient>, "getStreamUrl"> & {
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
  #auth: SubsonicAuth;
  #clientName: string;
  #fetch: typeof fetch;
  #controller = new AbortController();

  constructor(auth: SubsonicAuth, options: SubsonicClientOptions = {}) {
    const parsed = v.safeParse(credentialsSchema, auth.credentials);
    if (!parsed.success) throw new Error("The Subsonic authentication is invalid.");
    // Validate restored sessions too. Injected demo clients do not use this transport.
    normalizeAndValidateServerHost(auth.host, { method: parsed.output.method });
    this.#auth = { host: auth.host, credentials: parsed.output };
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

  get username() {
    return this.#auth.credentials.username;
  }

  #query(params?: Record<string, string | number | boolean | undefined>) {
    this.signal.throwIfAborted();
    const query = authenticationParameters(this.#auth.credentials);
    query.set("v", this.#apiVersion);
    query.set("c", this.#clientName);
    query.set("f", "json");
    for (const [name, value] of Object.entries(params ?? {})) {
      if (!reservedParameters.has(name) && value !== undefined) query.set(name, String(value));
    }
    return query;
  }

  #safeMessage(message: string | undefined) {
    const rejected = "The Subsonic server rejected the request.";
    if (!message || /(?:https?:\/\/|[?&](?:u|p|t|s)=)/i.test(message)) return rejected;
    const values = [
      ...Object.entries(this.#auth.credentials),
      ...authenticationParameters(this.#auth.credentials),
    ];
    const secrets = new Set<string>();
    for (const [key, value] of values) {
      if (key === "method" || !value) continue;
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
      secrets.add(new URLSearchParams({ x: value }).toString().slice(2));
    }
    const pattern = [...secrets]
      .sort((a, b) => b.length - a.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return message.replace(new RegExp(pattern, "g"), () => "[redacted]");
  }

  #request(url: string, init: RequestInit) {
    return subsonicFetch(url, init, this.#fetch);
  }

  #url(path: string, query: URLSearchParams) {
    return `${this.#auth.host}/rest/${path}.view?${query}`;
  }

  async #parse(response: Response, signal = this.signal): Promise<SubsonicResponse> {
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
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
    return this.#parse(await this.#request(this.#url(path, query), { signal }), signal);
  }

  async #post(path: string, params: URLSearchParams) {
    const query = this.#query();
    for (const [key, value] of params) query.append(key, value);
    return this.#parse(
      await this.#request(this.#url(path, new URLSearchParams()), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: query,
        signal: this.signal,
      }),
    );
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
    const query = this.#query();
    for (const id of state.tracks) query.append("id", id);
    if (state.current) {
      query.set("current", state.current);
      query.set("position", String(Math.round(state.position * 1000)));
    }
    await this.#parse(
      await this.#request(this.#url("savePlayQueue", new URLSearchParams()), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: query,
        keepalive: true,
        signal: this.signal,
      }),
    );
  }
}

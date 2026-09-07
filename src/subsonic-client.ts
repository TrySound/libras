import * as v from "valibot";

export interface SubsonicAuth {
  host: string;
  username: string;
  token: string;
  salt: string;
}

const genreSchema = v.object({ name: v.string() });
const artistSchema = v.object({
  id: v.optional(v.string()),
  name: v.string(),
  coverArt: v.optional(v.string()),
  genre: v.optional(v.string()),
  genres: v.optional(v.array(genreSchema)),
});

const albumSchema = v.object({
  id: v.string(),
  name: v.string(),
  artist: v.optional(v.string()),
  artistId: v.optional(v.string()),
  coverArt: v.optional(v.string()),
  genre: v.optional(v.string()),
  genres: v.optional(v.array(genreSchema)),
  year: v.optional(v.number()),
});

const trackSchema = v.object({
  id: v.string(),
  title: v.string(),
  album: v.optional(v.string()),
  albumId: v.optional(v.string()),
  artist: v.optional(v.string()),
  artistId: v.optional(v.string()),
  duration: v.optional(v.number()),
  contentType: v.optional(v.string()),
  coverArt: v.optional(v.string()),
  discNumber: v.optional(v.number()),
  genre: v.optional(v.string()),
  genres: v.optional(v.array(genreSchema)),
  track: v.optional(v.number()),
});

const responseSchema = v.object({
  "subsonic-response": v.object({
    status: v.string(),
    error: v.optional(v.object({ message: v.optional(v.string()) })),
    indexes: v.optional(v.object({ lastModified: v.optional(v.union([v.number(), v.string()])) })),
    artists: v.optional(
      v.object({
        index: v.optional(v.array(v.object({ artist: v.optional(v.array(artistSchema)) }))),
      }),
    ),
    albumList2: v.optional(v.object({ album: v.optional(v.array(albumSchema)) })),
    album: v.optional(v.object({ song: v.optional(v.array(trackSchema)) })),
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

export interface SubsonicPlayQueue {
  current?: string;
  position: number;
  tracks: readonly string[];
}

export interface SubsonicStreamOptions {
  estimateContentLength?: boolean;
  format?: "raw" | "mp3";
}

export interface SubsonicClientOptions {
  apiVersion?: string;
  clientName?: string;
}

export class SubsonicClient {
  #apiVersion: string;
  #auth: SubsonicAuth;
  #clientName: string;

  constructor(auth: SubsonicAuth, options: SubsonicClientOptions = {}) {
    this.#auth = auth;
    this.#apiVersion = options.apiVersion ?? "1.16.1";
    this.#clientName = options.clientName ?? "music-web";
  }

  get host() {
    return this.#auth.host;
  }

  get username() {
    return this.#auth.username;
  }

  #query(params?: Record<string, string | number | boolean | undefined>) {
    const query = new URLSearchParams({
      u: this.#auth.username,
      t: this.#auth.token,
      s: this.#auth.salt,
      v: this.#apiVersion,
      c: this.#clientName,
      f: "json",
    });
    for (const [name, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.set(name, String(value));
    }
    return query;
  }

  #url(path: string, query: URLSearchParams) {
    return `${this.#auth.host}/rest/${path}.view?${query}`;
  }

  async #parse(response: Response): Promise<SubsonicResponse> {
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    const parsed = v.safeParse(responseSchema, await response.json());
    if (!parsed.success) throw new Error("The server returned an invalid Subsonic response.");
    const result = parsed.output["subsonic-response"];
    if (result.status !== "ok") {
      throw new Error(result.error?.message || "The Subsonic server rejected the request.");
    }
    return result;
  }

  async #get(path: string, params?: Record<string, string | number | boolean | undefined>) {
    const query = this.#query(params);
    return this.#parse(await fetch(this.#url(path, query)));
  }

  async getIndexes(ifModifiedSince?: number) {
    const result = await this.#get("getIndexes", { ifModifiedSince });
    if (!result.indexes) return null;
    const lastModified = Number(result.indexes.lastModified);
    return Number.isFinite(lastModified) ? lastModified : null;
  }

  async getArtists() {
    const result = await this.#get("getArtists");
    return (result.artists?.index ?? []).flatMap((index) => index.artist ?? []);
  }

  async getAlbumList2(options: { type: "alphabeticalByArtist"; size: number; offset: number }) {
    const result = await this.#get("getAlbumList2", options);
    return result.albumList2?.album ?? [];
  }

  async getAlbum(id: string) {
    const result = await this.#get("getAlbum", { id });
    return result.album?.song ?? [];
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
      await fetch(this.#url("savePlayQueue", new URLSearchParams()), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: query,
        keepalive: true,
      }),
    );
  }
}

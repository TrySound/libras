import * as v from "valibot";
import {
  albumSchema,
  artistSchema,
  trackSchema,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicTrack,
} from "../src/subsonic-client";

const id = v.pipe(v.string(), v.nonEmpty());
// Reuse the protocol shapes, adding only export-specific constraints and legacy credits.
const artist = v.object({ ...artistSchema.entries, id, coverArt: v.optional(id) });
const credits = {
  artists: v.optional(v.array(artist)),
  artist: v.optional(v.string()),
  artistId: v.optional(id),
};
const album = v.object({
  ...albumSchema.entries,
  ...credits,
  id,
  coverArt: v.optional(id),
});
const track = v.object({
  ...trackSchema.entries,
  ...credits,
  id,
  albumId: id,
  duration: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  coverArt: v.optional(id),
});
const snapshot = v.object({
  "subsonic-response": v.object({
    status: v.literal("ok"),
    searchResult3: v.object({
      artist: v.array(artist),
      album: v.array(album),
      song: v.array(track),
    }),
  }),
});
const assetsSchema = v.record(id, v.object({ path: id, contentType: id }));

export interface StaticCatalog {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  tracks: SubsonicTrack[];
  assets: ReadonlyMap<string, { url: string; contentType: string }>;
}

export function parseCatalog(search: unknown, assetData: unknown, base: URL): StaticCatalog {
  const result = v.safeParse(snapshot, search);
  const parsedAssets = v.safeParse(assetsSchema, assetData);
  if (!result.success || !parsedAssets.success) throw new Error("The demo catalog is invalid.");
  const data = result.output["subsonic-response"].searchResult3;
  const assets = new Map<string, { url: string; contentType: string }>();
  for (const [id, asset] of Object.entries(parsedAssets.output)) {
    // Export paths are relative assets, never remote URLs or credentials-bearing API links.
    if (
      !/^(audio|covers)\/[A-Za-z0-9._/-]+$/.test(asset.path) ||
      asset.path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("The demo catalog contains an unsafe asset path.");
    }
    const url = new URL(asset.path, base);
    if (url.origin !== base.origin || !url.href.startsWith(base.href))
      throw new Error("Invalid demo asset URL.");
    assets.set(id, { url: url.href, contentType: asset.contentType });
  }
  const unique = (items: { id: string }[]) =>
    new Set(items.map((item) => item.id)).size === items.length;
  if (![data.artist, data.album, data.song].every(unique))
    throw new Error("Duplicate demo catalog IDs.");
  const artists = new Map(data.artist.map((a) => [a.id, a]));
  const albums = new Set(data.album.map((a) => a.id));
  for (const item of [...data.artist, ...data.album, ...data.song]) {
    if (item.coverArt && !assets.get(item.coverArt)?.contentType.startsWith("image/")) {
      throw new Error("The demo catalog is missing artwork.");
    }
  }
  for (const song of data.song) {
    if (!albums.has(song.albumId) || !assets.get(song.id)?.contentType.startsWith("audio/")) {
      throw new Error("The demo catalog is missing an album or audio asset.");
    }
  }
  // The source export includes legacy album credits; adapt only here, not in the main app.
  const structured = <
    T extends {
      artists?: SubsonicArtist[];
      artistId?: string;
      artist?: string;
      displayArtist?: string;
    },
  >(
    item: T,
  ) => ({
    ...item,
    artists:
      item.artists ??
      (item.artistId && artists.has(item.artistId) ? [artists.get(item.artistId)!] : undefined),
    displayArtist: item.displayArtist ?? item.artist,
  });
  return {
    artists: data.artist,
    albums: data.album.map(structured),
    tracks: data.song.map(structured),
    assets,
  };
}

export async function loadCatalog(base: URL, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (base.origin !== location.origin || !base.pathname.endsWith("/") || base.search || base.hash) {
    throw new Error("The demo catalog must be hosted alongside this website.");
  }
  const read = async (name: string) => {
    signal.throwIfAborted();
    const response = await fetcher(new URL(name, base), {
      signal,
      cache: "no-cache",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Could not load demo metadata (HTTP ${response.status}).`);
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  };
  const [search, assets] = await Promise.all([read("search3.json"), read("assets.json")]);
  return parseCatalog(search, assets, base);
}

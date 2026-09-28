import * as v from "valibot";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const id = v.pipe(v.string(), v.minLength(1));

const ordinal = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)));

export const accountSchema = v.strictObject({ host: id, username: id });

export const artistSchema = v.strictObject({
  id,
  name: v.string(),
  artworkId: v.optional(id),
});

export const albumSchema = v.strictObject({
  id,
  title: v.string(),
  artistIds: v.pipe(v.array(id), v.minLength(1)),
  displayArtist: v.optional(v.string()),
  // Effective artwork: explicit album image, otherwise its artist's image.
  artworkId: v.optional(id),
  year: ordinal,
  genres: v.array(v.string()),
});

export const trackSchema = v.strictObject({
  id,
  title: v.string(),
  albumId: id,
  artistIds: v.pipe(v.array(id), v.minLength(1)),
  displayArtist: v.optional(v.string()),
  // Effective artwork: explicit track image, otherwise its album's effective image.
  artworkId: v.optional(id),
  number: ordinal,
  disc: ordinal,
  duration: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  mimeType: v.optional(v.string()),
  genres: v.array(v.string()),
});

// Playlist entries are occurrences, not a map keyed by song ID. They retain enough
// information to render cached details when the library has no matching album/track.
export const playlistEntrySchema = v.strictObject({
  id,
  title: v.string(),
  artist: v.optional(v.string()),
  album: v.optional(v.string()),
  artworkId: v.optional(id),
  duration: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
});

export const playlistSchema = v.strictObject({
  id,
  name: v.string(),
  owner: v.optional(v.string()),
  public: v.optional(v.boolean()),
  artworkId: v.optional(id),
  songCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  changed: v.optional(v.string()),
});

export const playlistDetailSchema = v.strictObject({
  summary: playlistSchema,
  entries: v.array(playlistEntrySchema),
  fetchedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Playlist = v.InferOutput<typeof playlistSchema>;
export type PlaylistEntry = v.InferOutput<typeof playlistEntrySchema>;
export type PlaylistDetail = v.InferOutput<typeof playlistDetailSchema>;

export const downloadTrackSchema = v.object({
  id: v.string(),
  title: v.string(),
  artist: v.string(),
  album: v.string(),
  contentType: v.optional(v.string()),
});

const imageMetadataSchema = v.object({
  cacheControl: v.optional(v.string()),
  expires: v.optional(v.string()),
  freshUntil: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  etag: v.optional(v.string()),
  lastModified: v.optional(v.string()),
});
export type ImageMetadata = v.InferOutput<typeof imageMetadataSchema>;

export const imageSchema = v.strictObject({
  id,
  fileName: v.pipe(v.string(), v.regex(/^[a-f0-9-]+\.image$/)),
  type: v.pipe(v.string(), v.regex(/^image\//)),
  size: v.pipe(v.number(), v.integer(), v.minValue(1)),
  cachedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  ...imageMetadataSchema.entries,
});

export type ImageRecord = v.InferOutput<typeof imageSchema>;

export type DownloadTrack = v.InferOutput<typeof downloadTrackSchema>;

export type Account = v.InferOutput<typeof accountSchema>;

export type Artist = v.InferOutput<typeof artistSchema>;

export type Album = v.InferOutput<typeof albumSchema>;

export type Track = v.InferOutput<typeof trackSchema>;

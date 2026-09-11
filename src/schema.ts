import * as v from "valibot";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const id = v.pipe(v.string(), v.minLength(1));

const ordinal = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)));

export const accountSchema = v.strictObject({ host: id, username: id });

export const artistSchema = v.strictObject({
  id,
  name: v.string(),
  artworkId: v.optional(id),
  genres: v.array(v.string()),
});

export const albumSchema = v.strictObject({
  id,
  title: v.string(),
  artistId: id,
  artworkId: v.optional(id),
  year: ordinal,
  genres: v.array(v.string()),
});

export const trackSchema = v.strictObject({
  id,
  title: v.string(),
  albumId: id,
  artistId: id,
  artworkId: v.optional(id),
  number: ordinal,
  disc: ordinal,
  duration: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  mimeType: v.optional(v.string()),
  genres: v.array(v.string()),
});

export const downloadTrackSchema = v.object({
  id: v.string(),
  title: v.string(),
  artist: v.string(),
  album: v.string(),
  contentType: v.optional(v.string()),
});

export const imageSchema = v.strictObject({
  id,
  fileName: v.pipe(v.string(), v.regex(/^[a-f0-9-]+\.image$/)),
  type: v.pipe(v.string(), v.regex(/^image\//)),
  size: v.pipe(v.number(), v.integer(), v.minValue(1)),
  cachedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  etag: v.optional(v.string()),
  lastModified: v.optional(v.string()),
});

export type ImageRecord = v.InferOutput<typeof imageSchema>;

export type DownloadTrack = v.InferOutput<typeof downloadTrackSchema>;

export type Account = v.InferOutput<typeof accountSchema>;

export type Artist = v.InferOutput<typeof artistSchema>;

export type Album = v.InferOutput<typeof albumSchema>;

export type Track = v.InferOutput<typeof trackSchema>;

import * as v from "valibot";

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

export type MetadataAccount = v.InferOutput<typeof accountSchema>;

export type Artist = v.InferOutput<typeof artistSchema>;

export type Album = v.InferOutput<typeof albumSchema>;

export type Track = v.InferOutput<typeof trackSchema>;

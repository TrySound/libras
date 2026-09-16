import type { Cache } from "./cache.svelte";

type Entity = "artists" | "albums" | "tracks";

/** Select one metadata reference; unavailable bytes do not select another image.
 * Track fallbacks use the album artist, including for compilation tracks. */
export function resolveArtworkId(
  library: Pick<Cache, "artists" | "albums" | "tracks">,
  entity: Entity,
  id: string,
): string | undefined {
  if (entity === "artists") return library.artists.get(id)?.artworkId;
  const track = entity === "tracks" ? library.tracks.get(id) : undefined;
  if (entity === "tracks" && !track) return undefined;
  const album = library.albums.get(track ? track.albumId : id);
  return (
    track?.artworkId ??
    album?.artworkId ??
    (album && library.artists.get(album.artistId)?.artworkId)
  );
}

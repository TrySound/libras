import { describe, expect, it } from "vitest";
import { resolveArtworkId } from "../src/cover.svelte";
import type { Artist, Album, Track } from "../src/schema";

function library() {
  return {
    artists: new Map<string, Artist>([
      ["artist", { id: "artist", name: "Artist", artworkId: "artist-art", genres: [] }],
      ["guest", { id: "guest", name: "Guest", artworkId: "guest-art", genres: [] }],
    ]),
    albums: new Map<string, Album>([
      [
        "album",
        { id: "album", title: "Album", artistId: "artist", artworkId: "album-art", genres: [] },
      ],
      [
        "other",
        { id: "other", title: "Other", artistId: "artist", artworkId: "other-art", genres: [] },
      ],
    ]),
    tracks: new Map<string, Track>([
      [
        "track",
        {
          id: "track",
          title: "Track",
          albumId: "album",
          artistId: "guest",
          artworkId: "track-art",
          genres: [],
        },
      ],
      [
        "sibling",
        {
          id: "sibling",
          title: "Sibling",
          albumId: "album",
          artistId: "artist",
          artworkId: "sibling-art",
          genres: [],
        },
      ],
    ]),
  };
}

describe("artwork resolution", () => {
  it("uses own artwork, then album artwork, then the album artist", () => {
    const data = library();
    expect(resolveArtworkId(data, "tracks", "track")).toBe("track-art");
    expect(resolveArtworkId(data, "albums", "album")).toBe("album-art");
    expect(resolveArtworkId(data, "artists", "artist")).toBe("artist-art");
    data.tracks.get("track")!.artworkId = undefined;
    expect(resolveArtworkId(data, "tracks", "track")).toBe("album-art");
    data.albums.get("album")!.artworkId = undefined;
    expect(resolveArtworkId(data, "tracks", "track")).toBe("artist-art");
    expect(resolveArtworkId(data, "albums", "album")).toBe("artist-art");
    data.artists.get("artist")!.artworkId = undefined;
    // No sibling tracks, other albums, or compilation guest fallback.
    for (const [entity, id] of [
      ["tracks", "track"],
      ["albums", "album"],
      ["artists", "artist"],
    ] as const)
      expect(resolveArtworkId(data, entity, id)).toBeUndefined();
  });

  it("handles missing entities and relationships", () => {
    const data = library();
    for (const entity of ["artists", "albums", "tracks"] as const)
      expect(resolveArtworkId(data, entity, "missing")).toBeUndefined();
    data.albums.clear();
    expect(resolveArtworkId(data, "tracks", "track")).toBe("track-art");
    data.tracks.get("track")!.artworkId = undefined;
    expect(resolveArtworkId(data, "tracks", "track")).toBeUndefined();
    const missingArtist = library();
    missingArtist.artists.clear();
    missingArtist.albums.get("album")!.artworkId = undefined;
    expect(resolveArtworkId(missingArtist, "albums", "album")).toBeUndefined();
  });
});

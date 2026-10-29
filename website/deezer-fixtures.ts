import { demoAlbums } from "./deezer-catalog";

// Synthetic API responses: committed IDs/labels, no live requests or signed URLs.
export const albumFixtures = demoAlbums.map((album) => {
  const artist = { id: album.artistId, name: album.artist };
  return {
    id: album.id,
    title: album.title,
    artist,
    cover_medium: `https://cdn-images.dzcdn.net/images/cover/fixture-${album.id}.jpg`,
    tracks: {
      data: album.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        explicit_lyrics: track.explicit,
        artist,
        duration: 300,
        readable: true,
        preview: "https://cdnt-preview.dzcdn.net/fixture.mp3?temporary=not-persisted",
      })),
    },
  };
});

export const deezerAlbumFixture = albumFixtures.find((album) => album.id === 302117)!;
export const archiveAlbumFixture = albumFixtures.find((album) => album.id === 59667692)!;

export async function readAlbumFixture(path: string) {
  const album = albumFixtures.find((album) => path === `album/${album.id}`);
  if (!album) throw new Error(`Unexpected fixture request: ${path}`);
  return album;
}

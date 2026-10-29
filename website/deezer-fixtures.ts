export const deezerAlbumFixture = {
  id: 302117,
  title: "Mer De Noms",
  artist: { id: 702, name: "A Perfect Circle" },
  cover_medium: "https://cdn-images.dzcdn.net/images/cover/example.jpg",
  tracks: {
    data: [
      { id: 3135439, title: "The Hollow", duration: 178, explicit_lyrics: false },
      { id: 3135442, title: "Judith", duration: 247, explicit_lyrics: true },
      { id: 3135444, title: "3 Libras", duration: 217, explicit_lyrics: false },
    ].map((track) => ({
      ...track,
      artist: { id: 702, name: "A Perfect Circle" },
      readable: true,
      preview: "https://cdnt-preview.dzcdn.net/example.mp3?temporary=not-persisted",
    })),
  },
};

export const archiveAlbumFixture = {
  id: 59667692,
  title: "Controlling Crowds (Parts I-III)",
  artist: { id: 1334, name: "Archive" },
  cover_medium: "https://cdn-images.dzcdn.net/images/cover/archive-example.jpg",
  tracks: {
    data: (
      [
        [476972622, "Controlling Crowds"],
        [476972632, "Bullets"],
        [476972642, "Words On Signs"],
        [476972652, "Dangervisit"],
        [476972662, "Quiet Time"],
        [476972672, "Collapse / Collide"],
        [476972682, "Clones"],
        [476972692, "Bastardized Ink"],
        [476972702, "Kings Of Speed"],
        [476972712, "Whore"],
        [476972722, "Chaos"],
        [476972732, "Razed To The Ground"],
        [476972742, "Funeral"],
      ] as const
    ).map(([id, title]) => ({
      id,
      title,
      duration: 300,
      explicit_lyrics: id === 476972712,
      artist: { id: 1334, name: "Archive" },
      readable: true,
      preview: "https://cdnt-preview.dzcdn.net/archive-example.mp3?temporary=not-persisted",
    })),
  },
};

export async function readAlbumFixture(path: string) {
  if (path === "album/302117") return deezerAlbumFixture;
  if (path === "album/59667692") return archiveAlbumFixture;
  throw new Error(`Unexpected fixture request: ${path}`);
}

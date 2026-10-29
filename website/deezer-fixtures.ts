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

export const additionalAlbumFixtures = [
  {
    id: 320369597,
    title: "Fantasies",
    artist: { id: 956, name: "Metric" },
    firstTrack: "Help I'm Alive",
    trackIds: [
      1758502927, 1758502937, 1758502947, 1758502957, 1758502967, 1758502977, 1758502987,
      1758502997, 1758503007, 1758503017,
    ],
  },
  {
    id: 14879699,
    title: "OK Computer",
    artist: { id: 399, name: "Radiohead" },
    firstTrack: "Airbag",
    trackIds: [
      138539971, 138539973, 138539975, 138539977, 138539979, 138539981, 138539983, 138539985,
      138539987, 138539989, 138539991, 138539993,
    ],
  },
  {
    id: 355921,
    title: "xx",
    artist: { id: 261212, name: "The xx" },
    firstTrack: "Intro",
    trackIds: [
      3787855, 3787856, 3787857, 3787858, 3787859, 3787860, 3787861, 3787862, 3787863, 3787864,
      3787865,
    ],
  },
].map(({ firstTrack, trackIds, ...album }) => ({
  ...album,
  cover_medium: `https://cdn-images.dzcdn.net/images/cover/fixture-${album.id}.jpg`,
  tracks: {
    data: trackIds.map((id, index) => ({
      id,
      title: index === 0 ? firstTrack : `Fixture track ${index + 1}`,
      duration: 300,
      explicit_lyrics: id === 1758502947,
      artist: album.artist,
      readable: true,
      preview: "https://cdnt-preview.dzcdn.net/fixture.mp3?temporary=not-persisted",
    })),
  },
}));

export async function readAlbumFixture(path: string) {
  const album = [deezerAlbumFixture, archiveAlbumFixture, ...additionalAlbumFixtures].find(
    (album) => path === `album/${album.id}`,
  );
  if (!album) throw new Error(`Unexpected fixture request: ${path}`);
  return album;
}

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

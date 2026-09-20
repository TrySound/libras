// Small, synthetic test-only export. No production catalog or source-server location.
export const searchFixture = {
  "subsonic-response": {
    status: "ok",
    searchResult3: {
      artist: [{ id: "artist", name: "Demo artist", coverArt: "artist-cover" }],
      album: [
        {
          id: "album",
          name: "Demo album",
          artists: [{ id: "artist", name: "Demo artist" }],
          displayArtist: "Demo artist",
          coverArt: "cover",
          year: 2015,
        },
      ],
      song: [1, 2, 10].map((number) => ({
        id: `song-${number}`,
        title: `Song ${number}`,
        albumId: "album",
        artists: [{ id: "artist", name: "Demo artist" }],
        displayArtist: "Demo artist",
        track: number,
        duration: 30,
        contentType: "audio/mpeg",
        coverArt: "cover",
      })),
    },
  },
};
export const assetsFixture = {
  "artist-cover": { path: "covers/artist.svg", contentType: "image/svg+xml" },
  cover: { path: "covers/album.svg", contentType: "image/svg+xml" },
  ...Object.fromEntries(
    [1, 2, 10].map((number) => [
      `song-${number}`,
      { path: `audio/song-${number}.mp3`, contentType: "audio/mpeg" },
    ]),
  ),
};

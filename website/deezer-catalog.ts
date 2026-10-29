// Exact editions/recordings used by the demo and its Settings credits.
export const demoAlbums = [
  {
    id: 302117,
    artistId: 702,
    artist: "A Perfect Circle",
    title: "Mer De Noms",
    year: 2000, // Original release: https://en.wikipedia.org/wiki/Mer_de_Noms
    tracks: [
      { id: 3135439, title: "The Hollow", explicit: false },
      { id: 3135442, title: "Judith", explicit: true },
      { id: 3135444, title: "3 Libras", explicit: false },
    ],
  },
  {
    id: 59667692,
    artistId: 1334,
    artist: "Archive",
    title: "Controlling Crowds (Parts I-III)",
    year: 2009, // Original release: https://en.wikipedia.org/wiki/Controlling_Crowds
    tracks: [
      { id: 476972622, title: "Controlling Crowds", explicit: false },
      { id: 476972632, title: "Bullets", explicit: false },
      { id: 476972642, title: "Words On Signs", explicit: false },
      { id: 476972652, title: "Dangervisit", explicit: false },
      { id: 476972662, title: "Quiet Time", explicit: false },
      { id: 476972672, title: "Collapse / Collide", explicit: false },
      { id: 476972682, title: "Clones", explicit: false },
      { id: 476972692, title: "Bastardized Ink", explicit: false },
      { id: 476972702, title: "Kings Of Speed", explicit: false },
      { id: 476972712, title: "Whore", explicit: true },
      { id: 476972722, title: "Chaos", explicit: false },
      { id: 476972732, title: "Razed To The Ground", explicit: false },
      { id: 476972742, title: "Funeral", explicit: false },
    ],
  },
] as const;

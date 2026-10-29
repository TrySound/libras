import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Exact editions from #79, excluding Puscifer. Original years are curated
// independently of Deezer's edition dates; the final column records the source.
// [album ID, artist ID, track count, original year, Wikipedia article]
export const selections = [
  [302117, 702, 12, 2000, "Mer_de_Noms"],
  [299425, 702, 12, 2003, "Thirteenth_Step"],
  [892847522, 702, 12, 2018, "Eat_the_Elephant"],
  [123427, 1334, 13, 1996, "Londinium_(album)"],
  [685674, 1334, 10, 2002, "You_All_Look_the_Same_to_Me"],
  [59667692, 1334, 13, 2009, "Controlling_Crowds"],
  [401340, 1182, 13, 2006, "Whatever_People_Say_I_Am,_That's_What_I'm_Not"],
  [401346, 1182, 12, 2007, "Favourite_Worst_Nightmare"],
  [6899610, 1182, 12, 2013, "AM_(Arctic_Monkeys_album)"],
  // The 12-track We Are Not Alone edition includes the alternate Rain (2005).
  [11019040, 5286, 12, 2004, "We_Are_Not_Alone_(Breaking_Benjamin_album)"],
  [13793191, 5286, 13, 2006, "Phobia_(Breaking_Benjamin_album)"],
  [426788, 5286, 11, 2009, "Dear_Agony"],
  [78721, 566, 12, 1995, "Foo_Fighters_(album)"],
  [8247832, 566, 14, 1997, "The_Colour_and_the_Shape"],
  [1205341, 566, 12, 2007, "Echoes,_Silence,_Patience_&_Grace"],
  [940640, 566, 11, 2011, "Wasting_Light"],
  [320369597, 956, 10, 2009, "Fantasies_(album)"],
  [320919507, 956, 11, 2012, "Synthetica"],
  [73299342, 956, 12, 2018, "Art_of_Doubt"],
  [16576221, 2210161, 12, 2015, "Nothing_but_Thieves_(album)"],
  [46921452, 2210161, 15, 2017, "Broken_Machine_(album)"],
  [180580152, 2210161, 11, 2020, "Moral_Panic_(album)"],
  [1612869, 1817, 12, 2005, "Signs_of_Life_(Poets_of_the_Fall_album)"],
  [6032549, 1817, 12, 2006, "Carnival_of_Rust"],
  [4909791, 1817, 10, 2010, "Twilight_Theater"],
  [7690769, 1177, 12, 2000, "Rated_R_(Queens_of_the_Stone_Age_album)"],
  [662259, 1177, 16, 2002, "Songs_for_the_Deaf"],
  [107240, 1177, 15, 2005, "Lullabies_to_Paralyze"],
  [6619332, 1177, 10, 2013, "...Like_Clockwork"],
  [14880317, 399, 12, 1995, "The_Bends_(album)"],
  [14879699, 399, 12, 1997, "OK_Computer"],
  [14880741, 399, 11, 2000, "Kid_A"],
  [14880659, 399, 10, 2007, "In_Rainbows"],
  [11429868, 480, 10, 2001, "Melody_A.M."],
  [301287, 480, 17, 2005, "The_Understanding_(Röyksopp_album)"],
  [1233213, 480, 11, 2009, "Junior_(Röyksopp_album)"],
  [14581962, 1865, 12, 1991, "Badmotorfinger"],
  [7816775, 1865, 15, 1994, "Superunknown"],
  [120874, 1865, 16, 1996, "Down_on_the_Upside"],
  [355921, 261212, 11, 2009, "Xx_(The_xx_album)"],
  [5771751, 261212, 11, 2012, "Coexist_(album)"],
  [15036387, 261212, 10, 2017, "I_See_You_(The_xx_album)"],
  [105614472, 689, 10, 1993, "Undertow_(Tool_album)"],
  [105614492, 689, 15, 1996, "Ænima"],
  [105611632, 689, 13, 2001, "Lateralus"],
  [105611582, 689, 11, 2006, "10,000_Days_(Tool_album)"],
  [108996972, 689, 10, 2019, "Fear_Inoculum"],
];

export async function refreshCatalog() {
  const albums = [];
  const trackIds = new Set();
  for (const [id, artistId, count, year, source] of selections) {
    const response = await fetch(`https://api.deezer.com/album/${id}`, {
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Album ${id}: metadata HTTP ${response.status}.`);
    const album = await response.json();
    if (
      album.id !== id ||
      album.artist?.id !== artistId ||
      album.nb_tracks !== count ||
      album.tracks?.next ||
      album.tracks?.data?.length !== count ||
      typeof album.title !== "string" ||
      typeof album.artist.name !== "string" ||
      typeof album.cover_medium !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(album.release_date)
    ) {
      throw new Error(
        `Album ${id}: edition, artist, count or metadata changed; review before refreshing.`,
      );
    }
    const artwork = new URL(album.cover_medium);
    if (artwork.origin !== "https://cdn-images.dzcdn.net" || artwork.username || artwork.password) {
      throw new Error(`Album ${id}: unexpected artwork URL; review before refreshing.`);
    }
    const tracks = album.tracks.data.map((track) => {
      if (
        !Number.isSafeInteger(track.id) ||
        trackIds.has(track.id) ||
        track.artist?.id !== artistId ||
        typeof track.title !== "string" ||
        typeof track.explicit_lyrics !== "boolean" ||
        !track.readable ||
        !track.preview
      ) {
        throw new Error(
          `Album ${id}: duplicate/mismatched recording or missing preview; review before refreshing.`,
        );
      }
      trackIds.add(track.id);
      return { id: track.id, title: track.title, explicit: track.explicit_lyrics };
    });
    albums.push({
      id,
      artistId,
      artist: album.artist.name,
      title: album.title,
      year,
      yearSource: `https://en.wikipedia.org/wiki/${source}`,
      sourceReleaseDate: album.release_date,
      artwork: artwork.href,
      tracks,
    });
  }
  if (
    albums.length !== 47 ||
    new Set(albums.map((album) => album.artistId)).size !== 14 ||
    trackIds.size !== 569
  ) {
    throw new Error("Catalog totals changed; review the selection before refreshing.");
  }
  // Only stable metadata is stored. Never write preview URLs, tokens, or audio.
  await writeFile(
    new URL("./deezer-catalog.json", import.meta.url),
    JSON.stringify(albums, null, 2) + "\n",
  );
  console.log("Refreshed 14 artists, 47 albums, 569 preview entries. No audio downloaded.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshCatalog().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

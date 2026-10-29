import { expect, it } from "vitest";
import { demoAlbums } from "./deezer-catalog";

it("contains exactly the 53 planned editions without the excluded artists", () => {
  expect(demoAlbums.map((album) => album.id)).toEqual([
    302117, 299425, 892847522, 123427, 685674, 59667692, 401340, 401346, 6899610, 11019040,
    13793191, 426788, 78721, 8247832, 1205341, 940640, 320369597, 320919507, 73299342, 16576221,
    46921452, 180580152, 1612869, 6032549, 4909791, 7690769, 662259, 107240, 6619332, 14880317,
    14879699, 14880741, 14880659, 11429868, 301287, 1233213, 8015732, 8015752, 8015762, 1240724,
    1603045, 62256972, 14581962, 7816775, 120874, 355921, 5771751, 15036387, 105614472, 105614492,
    105611632, 105611582, 108996972,
  ]);
  expect(new Set(demoAlbums.map((album) => album.artistId)).size).toBe(16);
  expect(demoAlbums.some((album) => album.artist.toLowerCase() === "puscifer")).toBe(false);
  const tracks = demoAlbums.flatMap((album) => album.tracks);
  expect(tracks).toHaveLength(663);
  expect(new Set(tracks.map((track) => track.id)).size).toBe(663);
  expect(demoAlbums.find((album) => album.id === 302117)?.tracks).toHaveLength(12);
});

it("replaces Audioslave with the selected Breaking Benjamin editions", () => {
  expect(demoAlbums.some((album) => album.artistId === 843)).toBe(false);
  const albums = demoAlbums.filter((album) => album.artistId === 5286);
  expect(
    albums.map((album) => ({ id: album.id, year: album.year, count: album.tracks.length })),
  ).toEqual([
    { id: 11019040, year: 2004, count: 12 },
    { id: 13793191, year: 2006, count: 13 },
    { id: 426788, year: 2009, count: 11 },
  ]);
  expect(albums[0].sourceReleaseDate).toBe("2009-09-01");
});

it("includes the selected Seether and Shinedown editions with original years", () => {
  expect(
    demoAlbums
      .filter((album) => [1189, 6691].includes(album.artistId))
      .map((album) => ({
        id: album.id,
        year: album.year,
        count: album.tracks.length,
      })),
  ).toEqual([
    { id: 8015732, year: 2004, count: 20 },
    { id: 8015752, year: 2005, count: 14 },
    { id: 8015762, year: 2007, count: 14 },
    { id: 1240724, year: 2008, count: 20 },
    { id: 1603045, year: 2012, count: 12 },
    { id: 62256972, year: 2018, count: 14 },
  ]);
  expect(demoAlbums.find((album) => album.id === 8015762)?.title).toContain("Bonus Track Version");
  expect(demoAlbums.find((album) => album.id === 8015752)?.sourceReleaseDate).toBe("2009-09-11");
});

it("preserves edition labels, explicit flags and independently curated years", () => {
  expect(demoAlbums.find((album) => album.id === 46921452)?.title).toContain("Deluxe");
  expect(demoAlbums.find((album) => album.id === 14581962)?.title).toContain(
    "25th Anniversary Remaster",
  );
  expect(demoAlbums.find((album) => album.id === 7816775)?.title).toContain("20th Anniversary");
  expect(
    demoAlbums.flatMap((album) => album.tracks).find((track) => track.id === 3135442)?.explicit,
  ).toBe(true);
  const undertow = demoAlbums.find((album) => album.id === 105614472)!;
  expect(undertow.year).toBe(1993);
  expect(undertow.sourceReleaseDate).toBe("2019-08-02");
  for (const album of demoAlbums) {
    expect(new URL(album.yearSource).origin).toBe("https://en.wikipedia.org");
    expect(new URL(album.artwork).origin).toBe("https://cdn-images.dzcdn.net");
    expect(album.year).toBeGreaterThan(1900);
    expect(album.sourceReleaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

it("contains no playback URLs or API tokens", () => {
  expect(JSON.stringify(demoAlbums)).not.toMatch(
    /cdnt-preview|hdnea|track_token|preview|password|token/i,
  );
});

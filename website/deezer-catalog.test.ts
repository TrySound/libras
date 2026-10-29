import { expect, it } from "vitest";
import { demoAlbums } from "./deezer-catalog";

it("contains exactly the 47 planned editions without the excluded artist", () => {
  expect(demoAlbums.map((album) => album.id)).toEqual([
    302117, 299425, 892847522, 123427, 685674, 59667692, 401340, 401346, 6899610, 98920, 108923,
    73462, 78721, 8247832, 1205341, 940640, 320369597, 320919507, 73299342, 16576221, 46921452,
    180580152, 1612869, 6032549, 4909791, 7690769, 662259, 107240, 6619332, 14880317, 14879699,
    14880741, 14880659, 11429868, 301287, 1233213, 14581962, 7816775, 120874, 355921, 5771751,
    15036387, 105614472, 105614492, 105611632, 105611582, 108996972,
  ]);
  expect(new Set(demoAlbums.map((album) => album.artistId)).size).toBe(14);
  expect(demoAlbums.some((album) => album.artist.toLowerCase() === "puscifer")).toBe(false);
  const tracks = demoAlbums.flatMap((album) => album.tracks);
  expect(tracks).toHaveLength(571);
  expect(new Set(tracks.map((track) => track.id)).size).toBe(571);
  expect(demoAlbums.find((album) => album.id === 302117)?.tracks).toHaveLength(12);
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
    expect(album.year).toBeGreaterThan(1900);
    expect(album.sourceReleaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

it("contains no playback URLs or API tokens", () => {
  expect(JSON.stringify(demoAlbums)).not.toMatch(/dzcdn|hdnea|track_token|preview|password|token/i);
});

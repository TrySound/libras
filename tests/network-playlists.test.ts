import { describe, expect, it } from "vitest";
import { Network } from "../src/network.svelte";
import { SubsonicClient } from "../src/subsonic-client";

const auth = { host: "https://music.example", username: "listener", token: "token", salt: "salt" };
function reply(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}

describe("playlist network projection", () => {
  it("reads summaries and standalone ordered occurrences without requiring library albums", async () => {
    const network = new Network(
      (auth) =>
        new SubsonicClient(auth, {
          fetch: async (input) => {
            if (String(input).includes("getPlaylists.view"))
              return reply({
                playlists: { playlist: [{ id: "p", name: "Mix", coverArt: "cover" }] },
              });
            return reply({
              playlist: {
                id: "p",
                name: "Mix",
                entry: [
                  { id: "missing", title: "Unknown", album: "Unindexed", displayArtist: "Singer" },
                  { id: "missing", title: "Unknown", album: "Unindexed", displayArtist: "Singer" },
                ],
              },
            });
          },
        }),
    );
    network.setMode("online");
    const connection = network.open(auth).playlists;
    expect(await connection.list()).toEqual([
      {
        id: "p",
        name: "Mix",
        artworkId: "cover",
        owner: undefined,
        public: undefined,
        songCount: undefined,
        changed: undefined,
      },
    ]);
    expect((await connection.read("p")).entries).toEqual([
      {
        id: "missing",
        title: "Unknown",
        album: "Unindexed",
        artist: "Singer",
        artworkId: undefined,
        duration: undefined,
      },
      {
        id: "missing",
        title: "Unknown",
        album: "Unindexed",
        artist: "Singer",
        artworkId: undefined,
        duration: undefined,
      },
    ]);
    network.setMode("offline");
  });
});

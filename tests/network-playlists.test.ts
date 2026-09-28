import { describe, expect, it, vi } from "vitest";
import { Network } from "../src/network.svelte";
import { SubsonicClient } from "../src/subsonic-client";

const auth = { host: "https://music.example", username: "listener", token: "token", salt: "salt" };
function reply(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}

describe("playlist network projection", () => {
  it("dispatches typed actions to their Subsonic operations", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      reply(
        String(input).includes("createPlaylist.view")
          ? { playlist: { id: "new", name: "New" } }
          : {},
      ),
    );
    const network = new Network((auth) => new SubsonicClient(auth, { fetch: fetcher }));
    network.setMode("online");
    const connection = network.open(auth).playlists;
    const expected = ["a", "a"];
    expect(await connection.mutate({ kind: "create", name: "New" })).toMatchObject({ id: "new" });
    await connection.mutate({ kind: "rename", id: "p", expected, name: "Renamed" });
    await connection.mutate({ kind: "append", id: "p", expected, ids: ["a", "a"] });
    await connection.mutate({ kind: "remove", id: "p", expected, indexes: [0, 1] });
    await connection.mutate({
      kind: "replace",
      id: "p",
      expected,
      ids: ["a", "a"],
      overwrite: true,
    });
    await connection.mutate({ kind: "delete", id: "p", expected });
    expect(
      fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname.split("/").at(-1)),
    ).toEqual([
      "createPlaylist.view",
      "updatePlaylist.view",
      "updatePlaylist.view",
      "updatePlaylist.view",
      "createPlaylist.view",
      "deletePlaylist.view",
    ]);
    network.setMode("offline");
  });
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

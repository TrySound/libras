// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { Network } from "../src/network.svelte";
import { Cache, downloadKey } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { TrackEngine } from "../src/track.svelte";
import { Covers } from "../src/covers.svelte";
import { Playback } from "../src/playback.svelte";
import Player from "../src/audio-player.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { installDisk } from "./cache-test-helpers";
import { AudioStub } from "./audio-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("downloads and plays a normalized single offline by its server ID without leaking across accounts", async () => {
  installDisk();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:single");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const network = new Network();
  const connection = network.accept(
    network.prepare({
      ...account,
      credentials: { method: "token", username: account.username, token: "token", salt: "salt" },
    }),
  );
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("search3.view")) {
        return new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              searchResult3: {
                song:
                  url.searchParams.get("songOffset") === "0"
                    ? [
                        {
                          id: "single",
                          title: "Standalone",
                          displayArtist: "Solo",
                          contentType: "audio/mpeg",
                        },
                      ]
                    : [],
              },
            },
          }),
        );
      }
      expect(url.pathname).toMatch(/stream.view$/);
      expect(url.searchParams.get("id")).toBe("single");
      return new Response("audio bytes", { headers: { "Content-Type": "audio/mpeg" } });
    }),
  );
  const selection = new TestSelection();
  const cache = new Cache(getAccountKey(account));
  await cache.load();
  selection.cache = cache;
  const tracks = new TrackEngine({ selection });
  const covers = new Covers(selection);
  const playback = new Playback({ selection, tracks, covers });
  const audio = new AudioStub();
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const component = mount(Player, {
    target: document.createElement("div"),
    props: {
      hasNext: true,
      hasPrevious: true,
      onnext() {},
      onprevious() {},
      onposition() {},
      onended() {},
      onstatechange: (state) => playback.updatePlayerState(state),
    },
  });
  flushSync();
  playback.attach(component);
  try {
    await cache.replaceLibrary({
      ...(await connection.metadata.readLibrary(connection.signal)),
      savedAt: 1,
      lastModified: null,
    });
    tracks.activate();
    tracks.setDownloadConnection(connection.audio);
    await tracks.download("single", { format: "mp3" });
    expect(cache.downloads.get(downloadKey("single", "mp3"))?.track).toMatchObject({
      id: "single",
      title: "Standalone",
      artist: "Solo",
      album: "Singles",
    });
    await cache.flush();
    network.setMode("offline");
    tracks.setDownloadConnection(undefined);
    tracks.setPlaybackConnection(undefined);
    const requestCount = requests.length;
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    selection.cache = restored;
    tracks.activate();
    playback.activate();
    playback.setQueue({ tracks: ["single", "missing", "single"], index: 2, position: 0 });
    await playback.play();
    expect(playback.track?.id).toBe("single");
    expect(audio.src).toBe("blob:single");
    expect(requests).toHaveLength(requestCount);
    await restored.replaceLibrary({
      artists: [],
      albums: [],
      tracks: [],
      savedAt: 2,
      lastModified: null,
    });
    expect(playback.track).toBeUndefined();
    expect(restored.queue).toEqual({
      tracks: ["single", "missing", "single"],
      index: 2,
      position: 0,
    });
    expect(tracks.getStatus("single")).toBe("downloaded");
    const other = new Cache(getAccountKey({ ...account, username: "other" }));
    await other.load();
    selection.cache = other;
    tracks.activate();
    playback.activate();
    expect(tracks.getStatus("single")).toBe("idle");
    expect(playback.track).toBeUndefined();
    expect(other.queue.tracks).toEqual([]);
    await restored.flush();
  } finally {
    await playback.destroy();
    await unmount(component);
    tracks.destroy();
    covers.destroy();
    network.setMode("offline");
  }
});

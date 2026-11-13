// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import Album from "../src/_album.svelte";
import { AuthStore, getAccountKey } from "../src/auth";
import { Cache, downloadKey } from "../src/cache.svelte";
import { Covers } from "../src/covers.svelte";
import { Network } from "../src/network.svelte";
import { Playback } from "../src/playback.svelte";
import { Session } from "../src/session.svelte";
import { TrackEngine } from "../src/track.svelte";
import { AudioTransport } from "../src/audio-transport.svelte";
import { AudioStub } from "./audio-test-helpers";
import { installDisk } from "./cache-test-helpers";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { createStorage, credentials, deferred } from "./session-test-helpers";

it("keeps completed MP3 browsable and playable when a raw retry is paused by Work offline", async () => {
  installDisk();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-mp3");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const audio = new AudioStub();
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const selection = new TestSelection();
  const cache = new Cache(getAccountKey(credentials));
  const song = { id: "mixed", title: "Mixed formats", artist: "Artist", album: "Album" };
  await cache.replaceLibrary({
    savedAt: 1,
    lastModified: 1,
    artists: [{ id: "artist", name: "Artist" }],
    albums: [{ id: "album", title: "Album", artistIds: ["artist"], genres: [] }],
    tracks: [
      {
        id: song.id,
        title: song.title,
        albumId: "album",
        artistIds: ["artist"],
        genres: [],
      },
    ],
  });
  await cache.saveDownload(
    song,
    "mp3",
    "audio/mpeg",
    new Response("cached MP3"),
    new AbortController().signal,
  );
  await cache.enqueueDownload(song, "raw", "audio/flac");
  await cache.failDownload(downloadKey(song.id, "raw"));
  selection.cache = cache;
  const covers = new Covers(selection);
  const tracks = new TrackEngine({ selection });
  const network = new Network();
  const storage = createStorage();
  const auth = new AuthStore(storage);
  const playback = new Playback({
    selection,
    tracks,
    covers,
    isAvailable: (id) => network.mode === "online" || tracks.isDownloaded(id),
  });
  const transport = new AudioTransport({
    onstatechange: (state) => playback.updatePlayerState(state),
  });
  playback.attach(transport);
  const session = new Session({
    selection,
    network,
    auth,
    covers,
    tracks,
    playback,
    preferences: storage,
    acquireOwnership: async () => async () => {},
  });
  vi.spyOn(network, "validate").mockResolvedValue(undefined);
  const accept = network.accept.bind(network);
  vi.spyOn(network, "accept").mockImplementation((candidate) => {
    const active = accept(candidate);
    return { ...active, metadata: { ...active.metadata, getModifiedAt: async () => 1 } };
  });
  const pending = deferred<Response>();
  const fetcher = vi.fn(async () => pending.promise);
  vi.stubGlobal("fetch", fetcher);
  const target = document.createElement("main");
  document.body.append(target);
  let app: ReturnType<typeof mount> | undefined;
  try {
    expect(
      await session.connect({
        host: credentials.host,
        username: credentials.username,
        password: "fictional",
      }),
    ).toBe(true);
    expect(cache.downloads.get(downloadKey(song.id, "raw"))?.status).toBe("failed");
    const retry = tracks.download(song.id, { format: "raw" });
    await vi.waitFor(() => expect(tracks.getStatus(song.id)).toBe("downloading"));
    expect(tracks.isDownloaded(song.id)).toBe(true);
    await session.setOfflineMode(true);
    await expect(retry).rejects.toBeDefined();
    expect(tracks.getStatus(song.id)).toBe("queued");
    expect(tracks.waitingForConnection).toBe(true);
    expect(cache.downloads.get(downloadKey(song.id, "raw"))?.status).toBe("queued");
    session.setDownloadedOnly(true);
    app = mount(Album, {
      target,
      props: {
        params: { albumId: "album" },
        cache,
        covers,
        trackEngine: tracks,
        session,
        playback,
        playbackState: "paused",
      },
    });
    flushSync();
    const play = target.querySelector<HTMLButtonElement>(
      `button[aria-label="Play ${song.title}"]`,
    )!;
    expect(play).not.toBeNull();
    expect(play.disabled).toBe(false);
    expect(target.textContent).not.toContain("Unavailable offline");
    const requests = fetcher.mock.calls.length;
    play.click();
    await vi.waitFor(() => expect(audio.paused).toBe(false));
    expect(audio.src).toBe("blob:cached-mp3");
    expect(cache.queue.tracks).toEqual([song.id]);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    // Classification comes from the acquired source, not the pending raw transfer.
    playback.suspendNetwork();
    expect(audio.paused).toBe(false);
    expect(tracks.getStatus(song.id)).toBe("queued");
  } finally {
    if (app) await unmount(app);
    target.remove();
    session.destroy();
    await playback.destroy();
    transport.dispose();
    tracks.destroy();
    covers.destroy();
    pending.resolve(new Response("aborted raw"));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

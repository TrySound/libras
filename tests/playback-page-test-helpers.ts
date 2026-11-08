import { afterEach, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { fromStore, writable } from "svelte/store";
import Harness from "./playback-page-test-app.svelte";
import { AudioStub } from "./audio-test-helpers";
import { installDisk } from "./cache-test-helpers";
import { getAccountKey } from "../src/auth";
import { Cache } from "../src/cache.svelte";
import { Covers } from "../src/covers.svelte";
import { TrackEngine, type TrackSource } from "../src/track.svelte";
import { Playback } from "../src/playback.svelte";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export async function setupPlaybackPage(library: Parameters<Cache["replaceLibrary"]>[0]) {
  installDisk();
  const audio = new AudioStub();
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) =>
        handlers.set(action, handler),
      setPositionState: vi.fn(),
    },
  });
  const cache = new Cache(
    getAccountKey({ host: "https://music.example.test", username: "listener" }),
  );
  await cache.replaceLibrary(library);
  const selection = { cache };
  const covers = new Covers(selection);
  vi.spyOn(covers, "ensureCover").mockReturnValue({
    pending: false,
    source: undefined,
    load: vi.fn(),
  });
  const tracks = new TrackEngine({ selection });
  const getSource = vi
    .spyOn(tracks, "getSource")
    .mockImplementation(async (track): Promise<TrackSource> => ({
      url: `blob:${track.id}`,
      cached: false,
      nativeSeeking: false,
      release: vi.fn(),
    }));
  const offline = writable(false);
  const offlineState = fromStore(offline);
  const playback = new Playback({
    selection,
    tracks,
    covers,
    isAvailable: (id) => !offlineState.current || tracks.getStatus(id) === "downloaded",
  });
  const replace = vi.spyOn(playback, "replaceQueueAndPlay");
  const target = document.createElement("div");
  document.body.append(target);
  const props = {
    cache,
    covers,
    trackEngine: tracks,
    playback,
    session: {
      localReady: true,
      get offlineMode() {
        return offlineState.current;
      },
    },
  } as ComponentProps<typeof Harness>["props"];
  const app = mount(Harness, { target, props: { props } });
  flushSync();
  cleanups.push(async () => {
    await unmount(app);
    await playback.destroy();
    covers.destroy();
    tracks.destroy();
    target.remove();
  });
  return { audio, handlers, cache, tracks, getSource, offline, playback, replace, target, app };
}

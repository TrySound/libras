// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import Harness from "./album-test-app.svelte";
import { fromStore, writable } from "svelte/store";
import { AudioStub } from "./audio-test-helpers";
import { Cache } from "../src/cache.svelte";
import { Covers } from "../src/covers.svelte";
import { TrackEngine, type TrackSource } from "../src/track.svelte";
import { Playback } from "../src/playback.svelte";
import { installDisk } from "./cache-test-helpers";
import { getAccountKey } from "../src/auth";
import { Network } from "../src/network.svelte";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const source = (id = "track"): TrackSource => ({
  url: `blob:${id}`,
  cached: false,
  nativeSeeking: false,
  release: vi.fn(),
});
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}
async function setup() {
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
  await cache.replaceLibrary({
    lastModified: 1,
    savedAt: 1,
    artists: [{ id: "artist", name: "Artist" }],
    albums: ["album", "other"].map((id) => ({
      id,
      title: id === "album" ? "Album" : "Other",
      artistIds: ["artist"],
      genres: [],
    })),
    tracks: ["first", "second", "unrelated"].map((id) => ({
      id,
      title: id,
      albumId: id === "unrelated" ? "other" : "album",
      artistIds: ["artist"],
      genres: [],
      duration: 120,
    })),
  });
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
    .mockImplementation(async (track) => source(track.id));
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
  const button = () =>
    target.querySelector<HTMLButtonElement>(
      '[aria-label="Album details"] button[data-variant="primary"]',
    )!;
  function state(expected?: string) {
    flushSync();
    const active = expected === "Playing" || expected === "Loading playback…";
    expect(button().getAttribute("aria-label")).toBe(`${active ? "Pause" : "Play"} Album`);
    expect(button().hasAttribute("aria-describedby")).toBe(false);
    if (expected !== "Loading playback…") {
      expect(button().querySelector("use")?.getAttribute("href")).toBe(
        `#icon-${active ? "pause" : "play"}`,
      );
    }
    expect(button().hasAttribute("aria-pressed")).toBe(false);
    expect(button().getAttribute("aria-busy")).toBe(String(expected === "Loading playback…"));
    expect(target.querySelector('[aria-label="Album details"]')?.textContent).not.toContain(
      "Playback paused",
    );
  }
  return {
    audio,
    offline,
    handlers,
    cache,
    tracks,
    getSource,
    playback,
    replace,
    target,
    app,
    button,
    state,
  };
}

it("reacquires real streaming sources after header cancellation and selection changes", async () => {
  const { button, state, tracks, getSource, playback, audio } = await setup();
  getSource.mockRestore();
  const network = new Network();
  const auth = {
    host: "https://music.example.test",
    username: "listener",
    credentials: { method: "token" as const, username: "listener", token: "test", salt: "test" },
  };
  tracks.setPlaybackConnection(network.accept(network.prepare(auth)).audio);
  const playing = () => vi.waitFor(() => state("Playing"));
  const nativePlay = deferred<void>();
  audio.play.mockImplementationOnce(() => nativePlay.promise);
  button().click();
  state("Loading playback…");
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  // Native currentSrc can retain the cancelled resource until selection runs again.
  const retiredUrl = audio.src;
  Object.defineProperty(audio, "currentSrc", { get: () => retiredUrl });
  button().click();
  state("Playback paused");
  expect(audio.src).toBe("");
  button().click();
  await playing();
  expect(audio.src).not.toBe("");
  nativePlay.reject(new DOMException("The play request was interrupted.", "AbortError"));
  await settle();
  state("Playing");
  button().click();
  state("Playback paused");
  button().click();
  await playing();
  await playback.replaceQueueAndPlay(["unrelated"]);
  state();
  button().click();
  await playing();
});

it("immediately exposes startup, then actual playing, paused, resumed, buffering and seeking state", async () => {
  const { button, state, audio, playback, getSource, cache, replace } = await setup();
  state();
  const pending = deferred<TrackSource>();
  getSource.mockReturnValueOnce(pending.promise);
  button().focus();
  button().click();
  state("Loading playback…");
  expect(document.activeElement).toBe(button());
  expect(replace).toHaveBeenCalledExactlyOnceWith(["first", "second"]);
  expect(cache.queue).toMatchObject({ tracks: ["first", "second"], index: 0, position: 0 });
  pending.resolve(source());
  await settle();
  state("Playing");
  playback.pause();
  state("Playback paused");
  await playback.play();
  state("Playing");
  audio.dispatchEvent(new Event("waiting"));
  state("Loading playback…");
  audio.dispatchEvent(new Event("canplay"));
  state("Playing");
  const seeking = deferred<TrackSource>();
  getSource.mockReturnValueOnce(seeking.promise);
  const seek = playback.seek(30);
  state("Loading playback…");
  seeking.resolve(source());
  await seek;
  state("Playing");
  playback.pause();
  await playback.seek(40);
  state("Playback paused");
});

it.each([
  { initiallyPlaying: true, completion: "resolve" },
  { initiallyPlaying: true, completion: "reject" },
  { initiallyPlaying: false, completion: "resolve" },
  { initiallyPlaying: false, completion: "reject" },
])(
  "cancels a pending seek from playing=$initiallyPlaying before late $completion",
  async ({ initiallyPlaying, completion }) => {
    const { button, state, playback, getSource, cache, audio, replace } = await setup();
    const tracks = ["second", "unrelated", "second", "first"];
    await playback.replaceQueueAndPlay(tracks, 2);
    if (!initiallyPlaying) playback.pause();
    state(initiallyPlaying ? "Playing" : "Playback paused");
    replace.mockClear();
    audio.play.mockClear();
    const pending = deferred<TrackSource>();
    getSource.mockReturnValueOnce(pending.promise);
    const seek = playback.seek(30);
    state("Loading playback…");
    expect(button().disabled).toBe(false);
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });

    button().click();
    // Cancellation must be visible before the source request settles.
    state("Playback paused");
    expect(audio.paused).toBe(true);
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });
    expect(replace).not.toHaveBeenCalled();

    const late = source();
    if (completion === "resolve") pending.resolve(late);
    else pending.reject(new Error("Cancelled seek"));
    await seek;
    await settle();
    state("Playback paused");
    expect(audio.paused).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });
    if (completion === "resolve") expect(late.release).toHaveBeenCalledOnce();

    button().click();
    await settle();
    state("Playing");
    expect(audio.currentTime).toBe(30);
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });
    expect(replace).not.toHaveBeenCalled();
  },
);

it("pauses buffering through the header without losing selection or reviving on canplay", async () => {
  const { button, state, playback, cache, audio, replace } = await setup();
  const tracks = ["unrelated", "second", "second"];
  await playback.replaceQueueAndPlay(tracks, 2);
  playback.setPosition(25);
  replace.mockClear();
  audio.play.mockClear();
  audio.dispatchEvent(new Event("waiting"));
  state("Loading playback…");
  expect(button().disabled).toBe(false);
  button().click();
  state("Playback paused");
  expect(audio.paused).toBe(true);
  audio.dispatchEvent(new Event("canplay"));
  state("Playback paused");
  expect(audio.play).not.toHaveBeenCalled();
  expect(cache.queue).toMatchObject({ tracks, index: 2, position: 25 });
  expect(replace).not.toHaveBeenCalled();
});

it("clears failed and cancelled startup, even when cancelled requests resolve or reject late", async () => {
  const { button, state, playback, getSource } = await setup();
  const failed = deferred<TrackSource>();
  getSource.mockReturnValueOnce(failed.promise);
  button().click();
  state("Loading playback…");
  failed.reject(new Error("Source unavailable"));
  await settle();
  state("Playback paused");
  const cancelled = deferred<TrackSource>();
  getSource.mockReturnValueOnce(cancelled.promise);
  button().click();
  state("Loading playback…");
  button().click();
  state("Playback paused");
  const late = source();
  cancelled.resolve(late);
  await settle();
  state("Playback paused");
  expect(late.release).toHaveBeenCalledOnce();
  const rejected = deferred<TrackSource>();
  getSource.mockReturnValueOnce(rejected.promise);
  button().click();
  state("Loading playback…");
  button().click();
  state("Playback paused");
  rejected.reject(new Error("Cancelled"));
  await settle();
  state("Playback paused");
});

it("keeps rapid replacements and navigation tied to the current selected album, not stale completion", async () => {
  const { button, state, playback, getSource, app, target } = await setup();
  const stale = deferred<TrackSource>();
  const current = deferred<TrackSource>();
  getSource.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
  button().click();
  button().click();
  state("Playback paused");
  button().click();
  state("Loading playback…");
  stale.reject(new Error("Old failure"));
  await settle();
  state("Loading playback…");
  app.navigate();
  flushSync();
  expect(target.querySelector('button[aria-label="Play Album"]')).toBeNull();
  current.resolve(source());
  await settle();
  app.navigate("album");
  state("Playing");
  const superseded = deferred<TrackSource>();
  getSource.mockReturnValueOnce(superseded.promise);
  playback.suspend();
  button().click();
  state("Loading playback…");
  await playback.replaceQueueAndPlay(["unrelated"]);
  state();
  const late = source();
  superseded.resolve(late);
  await settle();
  state();
  expect(late.release).toHaveBeenCalledOnce();
  app.navigate("other");
  flushSync();
  expect(target.querySelector('button[aria-label="Pause Other"]')).not.toBeNull();
  app.navigate("album");
  state();
});

it("uses selected-track membership for external mixed queues, rows, next/previous and Media Session", async () => {
  const { state, playback, handlers, cache, target, app } = await setup();
  await playback.replaceQueueAndPlay(["unrelated", "second", "first"], 1);
  state("Playing");
  expect(cache.queue.index).toBe(1);
  handlers.get("pause")?.({ action: "pause" });
  state("Playback paused");
  handlers.get("play")?.({ action: "play" });
  await settle();
  state("Playing");
  handlers.get("previoustrack")?.({ action: "previoustrack" });
  await settle();
  state();
  handlers.get("nexttrack")?.({ action: "nexttrack" });
  await settle();
  state("Playing");
  await playback.next();
  state("Playing");
  await playback.previous();
  state("Playing");
  await playback.replaceQueueAndPlay(["unrelated"]);
  state();
  target.querySelector<HTMLButtonElement>('button[aria-label="Play second"]')!.click();
  await settle();
  state("Playing");
  expect(cache.queue).toMatchObject({ tracks: ["first", "second"], index: 1 });
  app.navigate();
  flushSync();
  playback.pause();
  app.navigate("album");
  state("Playback paused");
  playback.clearQueue();
  state();
});

it("toggles the selected duplicate occurrence without replacing a mixed queue or losing position", async () => {
  const { button, state, playback, replace, cache, getSource } = await setup();
  const tracks = ["second", "unrelated", "second", "first"];
  await playback.replaceQueueAndPlay(tracks, 2);
  await playback.seek(25);
  replace.mockClear();
  const requests = getSource.mock.calls.length;
  button().click();
  state("Playback paused");
  expect(cache.queue).toMatchObject({ tracks, index: 2, position: 25 });
  button().click();
  await settle();
  state("Playing");
  expect(cache.queue).toMatchObject({ tracks, index: 2, position: 25 });
  expect(replace).not.toHaveBeenCalled();
  expect(getSource).toHaveBeenCalledTimes(requests);
});

it("keeps pause/cancel available offline but never substitutes another track for an unavailable selection", async () => {
  const { button, state, playback, tracks, offline, cache, replace, getSource } = await setup();
  vi.spyOn(tracks, "getStatus").mockImplementation((id) =>
    id === "first" ? "downloaded" : "idle",
  );
  await playback.replaceQueueAndPlay(["unrelated", "second", "second"], 2);
  await playback.seek(25);
  replace.mockClear();
  offline.set(true);
  state("Playing");
  expect(button().disabled).toBe(false);
  button().click();
  state("Playback paused");
  expect(button().disabled).toBe(true);
  button().click();
  expect(cache.queue).toMatchObject({
    tracks: ["unrelated", "second", "second"],
    index: 2,
    position: 25,
  });
  expect(replace).not.toHaveBeenCalled();
  offline.set(false);
  flushSync();
  playback.suspend();
  const pending = deferred<TrackSource>();
  getSource.mockReturnValueOnce(pending.promise);
  button().click();
  offline.set(true);
  state("Loading playback…");
  expect(button().disabled).toBe(false);
  button().click();
  state("Playback paused");
  expect(button().disabled).toBe(true);
  pending.resolve(source());
  await settle();
  state("Playback paused");
  playback.clearQueue();
  state();
  expect(button().disabled).toBe(false);
  button().click();
  await settle();
  state("Playing");
  expect(replace).toHaveBeenCalledExactlyOnceWith(["first"]);
});

it("uses decorative action cues for album and selected queue occurrence and labels pending transports Pause", async () => {
  const { button, state, playback, target, getSource } = await setup();
  const pending = deferred<TrackSource>();
  getSource.mockReturnValueOnce(pending.promise);
  const playing = playback.replaceQueueAndPlay(["second", "unrelated", "second"], 2);
  state("Loading playback…");
  const row = (scope: string) => target.querySelector(`${scope} [aria-current="true"]`)!;
  const albumScope = '[aria-label="Album details"]';
  const queueScope = "#player-dialog";
  for (const scope of [albumScope, queueScope]) {
    expect(row(scope).querySelector('button[aria-label="Pause second"]')).not.toBeNull();
    expect(row(scope).querySelector('[aria-label="Loading playback"]')).toBeNull();
    expect(row(scope).querySelector('[aria-hidden="true"]')).not.toBeNull();
  }
  const transportButtons = () =>
    Array.from(target.querySelectorAll<HTMLButtonElement>("button[aria-busy]"));
  expect(transportButtons()).toHaveLength(3);
  expect(
    transportButtons().every(
      (control) =>
        control.getAttribute("aria-label")?.startsWith("Pause") &&
        control.getAttribute("aria-busy") === "true",
    ),
  ).toBe(true);
  pending.resolve(source());
  await playing;
  state("Playing");
  for (const scope of [albumScope, queueScope]) {
    expect(row(scope).querySelector('use[href="#icon-pause"]')).not.toBeNull();
    expect(row(scope).querySelector('[role="img"]')).toBeNull();
  }
  const queueRows = target.querySelectorAll("#player-dialog .track-row");
  expect(queueRows[0].hasAttribute("aria-current")).toBe(false);
  expect(queueRows[0].querySelector('button[aria-label="Play second"]')).not.toBeNull();
  expect(queueRows[2].getAttribute("aria-current")).toBe("true");
  button().click();
  state("Playback paused");
  for (const scope of [albumScope, queueScope]) {
    expect(row(scope).querySelector('use[href="#icon-play"]')).not.toBeNull();
    expect(row(scope).querySelector('button[aria-label="Play second"]')).not.toBeNull();
  }
});

it("leaves native header Space and Enter activation to the button, not the global pause shortcut", async () => {
  const { button, state, replace, playback } = await setup();
  await playback.replaceQueueAndPlay(["second"]);
  replace.mockClear();
  button().focus();
  for (const [index, key] of [" ", "Enter"].entries()) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    button().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    state(index === 0 ? "Playing" : "Playback paused");
    // DOM emulation does not synthesize native keyboard clicks; browser validation does.
    button().click();
    await settle();
  }
  expect(replace).not.toHaveBeenCalled();
  state("Playing");
});

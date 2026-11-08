// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import Harness from "./album-test-app.svelte";
import { AudioStub } from "./audio-test-helpers";
import { Cache } from "../src/cache.svelte";
import { Covers } from "../src/covers.svelte";
import { TrackEngine, type TrackSource } from "../src/track.svelte";
import { Playback } from "../src/playback.svelte";
import { installDisk } from "./cache-test-helpers";

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
  const cache = new Cache("album-header-tests");
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
  const playback = new Playback({ selection, tracks, covers });
  const replace = vi.spyOn(playback, "replaceQueueAndPlay");
  const target = document.createElement("div");
  document.body.append(target);
  const props = {
    cache,
    covers,
    trackEngine: tracks,
    playback,
    session: { localReady: true, offlineMode: false },
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
  const button = () => target.querySelector<HTMLButtonElement>('button[aria-label="Play Album"]')!;
  const description = () => {
    const id = button().getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent?.trim() : undefined;
  };
  function state(expected?: string) {
    flushSync();
    expect(button().getAttribute("aria-label")).toBe("Play Album");
    expect(button().hasAttribute("aria-pressed")).toBe(false);
    expect(button().getAttribute("aria-busy")).toBe(String(expected === "Loading playback…"));
    expect(description()).toBe(expected);
    if (expected) expect(target.textContent).toContain(expected);
  }
  return {
    audio,
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
  playback.pause();
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
  playback.suspend();
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
  const other = target.querySelector('button[aria-label="Play Other"]')!;
  expect(
    document.getElementById(other.getAttribute("aria-describedby")!)?.textContent?.trim(),
  ).toBe("Playing");
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

it("always replaces from the beginning rather than pausing or resuming, including when already playing", async () => {
  const { button, state, playback, replace, cache, getSource } = await setup();
  await playback.replaceQueueAndPlay(["unrelated", "second"], 1);
  await playback.seek(25);
  replace.mockClear();
  button().click();
  await settle();
  state("Playing");
  expect(replace).toHaveBeenCalledExactlyOnceWith(["first", "second"]);
  expect(cache.queue).toMatchObject({ tracks: ["first", "second"], index: 0, position: 0 });
  button().click();
  await settle();
  state("Playing");
  playback.pause();
  state("Playback paused");
  button().click();
  await settle();
  state("Playing");
  expect(replace).toHaveBeenCalledTimes(3);
  expect(getSource).toHaveBeenCalledTimes(5);
});

it("leaves native header Space and Enter activation to the button, not the global pause shortcut", async () => {
  const { button, state, replace, playback } = await setup();
  await playback.replaceQueueAndPlay(["second"]);
  replace.mockClear();
  button().focus();
  for (const key of [" ", "Enter"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    button().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    state("Playing");
    // DOM emulation does not synthesize native keyboard clicks; browser validation does.
    button().click();
    await settle();
  }
  expect(replace).toHaveBeenCalledTimes(2);
});

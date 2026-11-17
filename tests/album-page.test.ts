// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { setupPlaybackPage } from "./playback-page-test-helpers";
import type { TrackSource } from "../src/track.svelte";
import { Network } from "../src/network.svelte";
function deferred<T>() {
  return Promise.withResolvers<T>();
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
  const fixture = await setupPlaybackPage({
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
  const { target } = fixture;
  const button = () =>
    target.querySelector<HTMLButtonElement>(
      '[aria-label="Album details"] button[data-variant="primary"]',
    )!;
  function state(expected?: "loading" | "playing" | "paused") {
    flushSync();
    const active = expected === "playing" || expected === "loading";
    expect(button().getAttribute("aria-label")).toBe(`${active ? "Pause" : "Play"} Album`);
    if (expected !== "loading") {
      expect(button().querySelector("use")?.getAttribute("href")).toBe(
        `#icon-${active ? "pause" : "play"}`,
      );
    }
    expect(button().getAttribute("aria-busy")).toBe(String(expected === "loading"));
  }
  return { ...fixture, button, state };
}

it("presents header playback through its action, icon and busy state without redundant status text", async () => {
  const { button, playback, target, state } = await setup();
  for (const playing of [false, true]) {
    if (playing) await playback.replaceQueueAndPlay(["first"]);
    state(playing ? "playing" : "paused");
    expect(button().hasAttribute("aria-describedby")).toBe(false);
    expect(button().hasAttribute("aria-pressed")).toBe(false);
    const details = target.querySelector('[aria-label="Album details"]')!;
    for (const text of ["Loading playback…", "Playback paused", "Playing"])
      expect(details.textContent).not.toContain(text);
  }
});

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
  const playing = () => vi.waitFor(() => state("playing"));
  const nativePlay = deferred<void>();
  audio.play.mockImplementationOnce(() => nativePlay.promise);
  button().click();
  state("loading");
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  // Native currentSrc can retain the cancelled resource until selection runs again.
  const retiredUrl = audio.src;
  Object.defineProperty(audio, "currentSrc", { get: () => retiredUrl });
  button().click();
  state("paused");
  expect(audio.src).toBe("");
  button().click();
  await playing();
  expect(audio.src).not.toBe("");
  nativePlay.reject(new DOMException("The play request was interrupted.", "AbortError"));
  await settle();
  state("playing");
  button().click();
  state("paused");
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
  state("loading");
  expect(document.activeElement).toBe(button());
  expect(replace).toHaveBeenCalledExactlyOnceWith(["first", "second"]);
  expect(cache.queue).toMatchObject({ tracks: ["first", "second"], index: 0, position: 0 });
  pending.resolve(source());
  await settle();
  state("playing");
  playback.pause();
  state("paused");
  await playback.play();
  state("playing");
  audio.dispatchEvent(new Event("waiting"));
  state("loading");
  audio.dispatchEvent(new Event("canplay"));
  state("playing");
  const seeking = deferred<TrackSource>();
  getSource.mockReturnValueOnce(seeking.promise);
  const seek = playback.seek(30);
  state("loading");
  seeking.resolve(source());
  await seek;
  state("playing");
  playback.pause();
  await playback.seek(40);
  state("paused");
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
    state(initiallyPlaying ? "playing" : "paused");
    replace.mockClear();
    audio.play.mockClear();
    const pending = deferred<TrackSource>();
    getSource.mockReturnValueOnce(pending.promise);
    const seek = playback.seek(30);
    state("loading");
    expect(button().disabled).toBe(false);
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });

    button().click();
    // Cancellation must be visible before the source request settles.
    state("paused");
    expect(audio.paused).toBe(true);
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });
    expect(replace).not.toHaveBeenCalled();

    const late = source();
    if (completion === "resolve") pending.resolve(late);
    else pending.reject(new Error("Cancelled seek"));
    await seek;
    await settle();
    state("paused");
    expect(audio.paused).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
    expect(cache.queue).toMatchObject({ tracks, index: 2, position: 30 });
    if (completion === "resolve") expect(late.release).toHaveBeenCalledOnce();

    button().click();
    await settle();
    state("playing");
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
  state("loading");
  expect(button().disabled).toBe(false);
  button().click();
  state("paused");
  expect(audio.paused).toBe(true);
  audio.dispatchEvent(new Event("canplay"));
  state("paused");
  expect(audio.play).not.toHaveBeenCalled();
  expect(cache.queue).toMatchObject({ tracks, index: 2, position: 25 });
  expect(replace).not.toHaveBeenCalled();
});

it("clears failed and cancelled startup, even when cancelled requests resolve or reject late", async () => {
  const { button, state, playback, getSource } = await setup();
  const failed = deferred<TrackSource>();
  getSource.mockReturnValueOnce(failed.promise);
  button().click();
  state("loading");
  failed.reject(new Error("Source unavailable"));
  await settle();
  state("paused");
  const cancelled = deferred<TrackSource>();
  getSource.mockReturnValueOnce(cancelled.promise);
  button().click();
  state("loading");
  button().click();
  state("paused");
  const late = source();
  cancelled.resolve(late);
  await settle();
  state("paused");
  expect(late.release).toHaveBeenCalledOnce();
  const rejected = deferred<TrackSource>();
  getSource.mockReturnValueOnce(rejected.promise);
  button().click();
  state("loading");
  button().click();
  state("paused");
  rejected.reject(new Error("Cancelled"));
  await settle();
  state("paused");
});

it("keeps rapid replacements and navigation tied to the current selected album, not stale completion", async () => {
  const { button, state, playback, getSource, app, target } = await setup();
  const stale = deferred<TrackSource>();
  const current = deferred<TrackSource>();
  getSource.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
  button().click();
  button().click();
  state("paused");
  button().click();
  state("loading");
  stale.reject(new Error("Old failure"));
  await settle();
  state("loading");
  app.navigate();
  flushSync();
  expect(target.querySelector('button[aria-label="Play Album"]')).toBeNull();
  current.resolve(source());
  await settle();
  app.navigate("album");
  state("playing");
  const superseded = deferred<TrackSource>();
  getSource.mockReturnValueOnce(superseded.promise);
  playback.suspend();
  button().click();
  state("loading");
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
  state("playing");
  expect(cache.queue.index).toBe(1);
  handlers.get("pause")?.({ action: "pause" });
  state("paused");
  handlers.get("play")?.({ action: "play" });
  await settle();
  state("playing");
  handlers.get("previoustrack")?.({ action: "previoustrack" });
  await settle();
  state();
  handlers.get("nexttrack")?.({ action: "nexttrack" });
  await settle();
  state("playing");
  await playback.next();
  state("playing");
  await playback.previous();
  state("playing");
  await playback.replaceQueueAndPlay(["unrelated"]);
  state();
  target.querySelector<HTMLButtonElement>('button[aria-label="Play second"]')!.click();
  await settle();
  state("playing");
  expect(cache.queue).toMatchObject({ tracks: ["first", "second"], index: 1 });
  app.navigate();
  flushSync();
  playback.pause();
  app.navigate("album");
  state("paused");
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
  state("paused");
  expect(cache.queue).toMatchObject({ tracks, index: 2, position: 25 });
  button().click();
  await settle();
  state("playing");
  expect(cache.queue).toMatchObject({ tracks, index: 2, position: 25 });
  expect(replace).not.toHaveBeenCalled();
  expect(getSource).toHaveBeenCalledTimes(requests);
});

it("keeps pause/cancel available offline but never substitutes another track for an unavailable selection", async () => {
  const { button, state, playback, tracks, offline, cache, replace, getSource, audio } =
    await setup();
  vi.spyOn(tracks, "getStatus").mockImplementation((id) =>
    id === "first" ? "downloaded" : "idle",
  );
  await playback.replaceQueueAndPlay(["unrelated", "second", "second"], 2);
  await playback.seek(25);
  replace.mockClear();
  getSource.mockClear();
  audio.play.mockClear();
  offline.set(true);
  state("playing");
  expect(button().disabled).toBe(false);
  button().click();
  state("paused");
  expect(button().disabled).toBe(false);
  button().click();
  await settle();
  state("paused");
  expect(getSource).not.toHaveBeenCalled();
  expect(audio.play).not.toHaveBeenCalled();
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
  state("loading");
  expect(button().disabled).toBe(false);
  button().click();
  state("paused");
  expect(button().disabled).toBe(false);
  pending.resolve(source());
  await settle();
  button().click();
  await settle();
  state("paused");
  expect(getSource).toHaveBeenCalledOnce();
  expect(audio.play).not.toHaveBeenCalled();
  expect(cache.queue).toMatchObject({
    tracks: ["unrelated", "second", "second"],
    index: 2,
    position: 25,
  });
  expect(replace).not.toHaveBeenCalled();
  playback.clearQueue();
  state();
  expect(button().disabled).toBe(false);
  button().click();
  await settle();
  state("playing");
  expect(replace).toHaveBeenCalledExactlyOnceWith(["first"]);
});

it("shows playing indicators only on selected track rows and labels pending transports Pause", async () => {
  const { button, state, playback, target, getSource } = await setup();
  const pending = deferred<TrackSource>();
  getSource.mockReturnValueOnce(pending.promise);
  const playing = playback.replaceQueueAndPlay(["second", "unrelated", "second"], 2);
  state("loading");
  const row = (scope: string) => target.querySelector(`${scope} [aria-current="true"]`)!;
  const albumScope = '[aria-label="Album details"]';
  const queueScope = "#player-dialog";
  for (const scope of [albumScope, queueScope]) {
    expect(row(scope).querySelector('button[aria-label="Pause second"]')).not.toBeNull();
    expect(row(scope).querySelector('[aria-label="Loading playback"]')).toBeNull();
    expect(row(scope).querySelector('use[href="#icon-sound-bars"]')).toBeNull();
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
  state("playing");
  for (const scope of [albumScope, queueScope]) {
    expect(row(scope).querySelector('use[href="#icon-sound-bars"]')).not.toBeNull();
    expect(row(scope).querySelector('button[aria-label="Pause second"]')).not.toBeNull();
    expect(row(scope).querySelector('[role="img"]')).toBeNull();
  }
  const queueRows = target.querySelectorAll("#player-dialog .track-row");
  expect(queueRows[0].hasAttribute("aria-current")).toBe(false);
  expect(queueRows[0].querySelector('use[href="#icon-sound-bars"]')).toBeNull();
  expect(queueRows[0].querySelector('button[aria-label="Play second"]')).not.toBeNull();
  expect(queueRows[2].getAttribute("aria-current")).toBe("true");
  button().click();
  state("paused");
  for (const scope of [albumScope, queueScope]) {
    expect(row(scope).querySelector('use[href="#icon-play"]')).not.toBeNull();
    expect(row(scope).querySelector('use[href="#icon-sound-bars"]')).toBeNull();
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
    state(index === 0 ? "playing" : "paused");
    // DOM emulation does not synthesize native keyboard clicks; browser validation does.
    button().click();
    await settle();
  }
  expect(replace).not.toHaveBeenCalled();
  state("playing");
});

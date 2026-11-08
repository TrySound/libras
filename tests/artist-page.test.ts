// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { fromStore, writable } from "svelte/store";
import Harness from "./album-test-app.svelte";
import { AudioStub } from "./audio-test-helpers";
import { installDisk } from "./cache-test-helpers";
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
function deferred<T>() {
  return Promise.withResolvers<T>();
}
const source = (): TrackSource => ({
  url: "blob:track",
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
  const cache = new Cache("artist-header-tests");
  await cache.replaceLibrary({
    lastModified: 1,
    savedAt: 1,
    artists: [
      { id: "artist", name: "Artist" },
      { id: "co", name: "Coartist" },
      { id: "guest", name: "Guest" },
      { id: "other", name: "Other" },
      { id: "empty", name: "Empty" },
    ],
    albums: [
      { id: "late", title: "Later", year: 2000, artistIds: ["artist"], genres: [] },
      { id: "early", title: "Earlier", year: 1980, artistIds: ["artist", "co"], genres: [] },
      { id: "outside", title: "Outside", artistIds: ["other"], genres: [] },
    ],
    tracks: [
      { id: "cameo", albumId: "late", number: 2, artistIds: ["artist", "guest"] },
      { id: "later", albumId: "late", number: 1, artistIds: ["artist"] },
      { id: "second", albumId: "early", number: 2, artistIds: ["co"] },
      { id: "first", albumId: "early", number: 1, artistIds: ["artist"] },
      { id: "unrelated", albumId: "outside", number: 1, artistIds: ["other"] },
    ].map((track) => ({ ...track, title: track.id, duration: 120, genres: [] })),
  });
  const selection = { cache };
  const covers = new Covers(selection);
  vi.spyOn(covers, "ensureCover").mockReturnValue({
    pending: false,
    source: undefined,
    load: vi.fn(),
  });
  const tracks = new TrackEngine({ selection });
  const getSource = vi.spyOn(tracks, "getSource").mockImplementation(async () => source());
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
  app.navigateArtist("artist");
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
      '[aria-label="Artist details"] button[data-variant="primary"]',
    )!;
  function state(expected: "playing" | "paused" | "loading", name = "Artist") {
    flushSync();
    expect(button().getAttribute("aria-label")).toBe(
      `${expected === "paused" ? "Play" : "Pause"} ${name}`,
    );
    expect(button().getAttribute("aria-busy")).toBe(String(expected === "loading"));
    expect(button().hasAttribute("aria-pressed")).toBe(false);
    expect(button().hasAttribute("aria-describedby")).toBe(false);
    if (expected !== "loading")
      expect(button().querySelector("use")?.getAttribute("href")).toBe(
        `#icon-${expected === "playing" ? "pause" : "play"}`,
      );
  }
  return {
    audio,
    cache,
    tracks,
    getSource,
    offline,
    playback,
    replace,
    target,
    app,
    button,
    state,
  };
}

it("marks only the selected playing album across external queues, transport states and navigation", async () => {
  const { playback, target, app, audio, getSource } = await setup();
  const indicators = () =>
    target.querySelectorAll('[aria-label="Artist details"] [role="img"][aria-label="Playing"]');
  const expectAlbum = (title?: string) => {
    flushSync();
    expect(indicators()).toHaveLength(title ? 1 : 0);
    if (!title) return;
    const indicator = indicators()[0];
    expect(indicator.querySelector('use[href="#icon-sound-bars"]')).not.toBeNull();
    const link = indicator.closest("article")?.querySelector(`a[aria-label="Open ${title}"]`);
    expect(link).not.toBeNull();
    expect(link?.hasAttribute("aria-current")).toBe(false);
  };
  expectAlbum();
  await playback.replaceQueueAndPlay(["first", "unrelated", "later", "later"], 3);
  expectAlbum("Later");
  playback.pause();
  expectAlbum();
  await playback.play();
  expectAlbum("Later");
  audio.dispatchEvent(new Event("waiting"));
  expectAlbum();
  audio.dispatchEvent(new Event("canplay"));
  expectAlbum("Later");
  const pending = deferred<TrackSource>();
  getSource.mockReturnValueOnce(pending.promise);
  const seek = playback.seek(30);
  expectAlbum();
  pending.resolve(source());
  await seek;
  expectAlbum("Later");
  await playback.playIndex(0);
  expectAlbum("Earlier");
  await playback.playIndex(1);
  expectAlbum();
  await playback.playIndex(3);
  expectAlbum("Later");
  app.navigateArtist("co");
  expectAlbum();
  app.navigateArtist("guest");
  expectAlbum("Later");
  app.navigateArtist("artist");
  expectAlbum("Later");
  playback.clearQueue();
  expectAlbum();
});

it("starts the whole catalog in existing album/track order and leaves album links and explicit menu Play intact", async () => {
  const { button, state, cache, replace, target } = await setup();
  state("paused");
  button().click();
  state("loading");
  await settle();
  state("playing");
  const ids = ["first", "second", "later", "cameo"];
  expect(replace).toHaveBeenCalledExactlyOnceWith(ids);
  expect(cache.queue).toMatchObject({ tracks: ids, index: 0, position: 0 });
  expect(target.querySelector('a[aria-label="Open Later"]')?.getAttribute("href")).toBe(
    "?/library/album/late",
  );
  const menu = target.querySelector<HTMLElement>("#artist-detail-menu-popover")!;
  menu.hidePopover = vi.fn();
  const sheet = target.querySelector<HTMLDialogElement>("#artist-detail-menu")!;
  sheet.close = vi.fn();
  const play = Array.from(menu.querySelectorAll("button")).find(
    (control) => control.textContent?.trim() === "Play",
  )!;
  play.click();
  await settle();
  expect(replace).toHaveBeenCalledTimes(2);
  expect(cache.queue).toMatchObject({ tracks: ids, index: 0, position: 0 });
});

it("toggles an externally selected later-album duplicate without replacing its mixed queue or position", async () => {
  const { button, state, playback, cache, replace, getSource } = await setup();
  const ids = ["later", "unrelated", "later", "first"];
  await playback.replaceQueueAndPlay(ids, 2);
  await playback.seek(25);
  replace.mockClear();
  const requests = getSource.mock.calls.length;
  state("playing");
  button().click();
  state("paused");
  expect(cache.queue).toMatchObject({ tracks: ids, index: 2, position: 25 });
  button().click();
  await settle();
  state("playing");
  expect(cache.queue).toMatchObject({ tracks: ids, index: 2, position: 25 });
  expect(replace).not.toHaveBeenCalled();
  expect(getSource).toHaveBeenCalledTimes(requests);
});

it.each([
  { artist: "co", name: "Coartist", selected: "first", catalog: ["first", "second"] },
  { artist: "guest", name: "Guest", selected: "later", catalog: ["later", "cameo"] },
])(
  "recognizes the full appearance catalog for $name, not just direct track credits",
  async ({ artist, name, selected, catalog }) => {
    const { app, button, state, playback, cache, replace } = await setup();
    app.navigateArtist(artist);
    state("paused", name);
    button().click();
    await settle();
    expect(replace).toHaveBeenLastCalledWith(catalog);
    await playback.replaceQueueAndPlay(["unrelated", selected, selected], 2);
    await playback.seek(19);
    replace.mockClear();
    state("playing", name);
    button().click();
    state("paused", name);
    button().click();
    await settle();
    state("playing", name);
    expect(cache.queue).toMatchObject({
      tracks: ["unrelated", selected, selected],
      index: 2,
      position: 19,
    });
    expect(replace).not.toHaveBeenCalled();
  },
);

it.each(["resolve", "reject"])(
  "cancels pending header playback before late %s and retries without replacing selection",
  async (completion) => {
    const { button, state, playback, getSource, replace, cache, audio, app } = await setup();
    const pending = deferred<TrackSource>();
    getSource.mockReturnValueOnce(pending.promise);
    button().click();
    state("loading");
    expect(button().disabled).toBe(false);
    button().click();
    state("paused");
    app.navigateArtist("other");
    state("paused", "Other");
    const late = source();
    if (completion === "resolve") pending.resolve(late);
    else pending.reject(new Error("Cancelled"));
    await settle();
    app.navigateArtist("artist");
    state("paused");
    expect(audio.play).not.toHaveBeenCalled();
    if (completion === "resolve") expect(late.release).toHaveBeenCalledOnce();
    button().click();
    await settle();
    state("playing");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(cache.queue).toMatchObject({ tracks: ["first", "second", "later", "cameo"], index: 0 });
    await playback.replaceQueueAndPlay(["unrelated"]);
    state("paused");
  },
);

it("clears failure and retries the selected track, and reflects external playback/navigation", async () => {
  const { button, state, getSource, playback, replace, app } = await setup();
  getSource.mockRejectedValueOnce(new Error("Source unavailable"));
  button().click();
  await settle();
  state("paused");
  button().click();
  await settle();
  state("playing");
  expect(getSource).toHaveBeenCalledTimes(2);
  expect(replace).toHaveBeenCalledTimes(1);
  app.navigateArtist("other");
  state("paused", "Other");
  await playback.replaceQueueAndPlay(["unrelated"]);
  state("playing", "Other");
  app.navigateArtist("artist");
  state("paused");
  await playback.replaceQueueAndPlay(["later"]);
  state("playing");
  app.navigateArtist();
  flushSync();
  playback.pause();
  app.navigateArtist("artist");
  state("paused");
  await playback.play();
  state("playing");
  playback.clearQueue();
  state("paused");
  app.navigateArtist("empty");
  state("paused", "Empty");
  expect(button().disabled).toBe(true);
});

it.each([true, false])(
  "cancels pending seeking from playing=%s and pauses buffering",
  async (playing) => {
    const { button, state, playback, getSource, audio, cache } = await setup();
    await playback.replaceQueueAndPlay(["unrelated", "later", "later"], 2);
    if (!playing) playback.pause();
    const pending = deferred<TrackSource>();
    getSource.mockReturnValueOnce(pending.promise);
    const seek = playback.seek(30);
    state("loading");
    button().click();
    state("paused");
    const late = source();
    pending.resolve(late);
    await seek;
    await settle();
    state("paused");
    expect(late.release).toHaveBeenCalledOnce();
    expect(cache.queue).toMatchObject({
      tracks: ["unrelated", "later", "later"],
      index: 2,
      position: 30,
    });
    button().click();
    await settle();
    state("playing");
    audio.dispatchEvent(new Event("waiting"));
    state("loading");
    button().click();
    state("paused");
    audio.dispatchEvent(new Event("canplay"));
    state("paused");
  },
);

it("uses unfiltered membership offline, allowing pause/cancel but never substituting an available track", async () => {
  const { button, state, offline, playback, tracks, cache, replace, getSource } = await setup();
  vi.spyOn(tracks, "getStatus").mockImplementation((id) =>
    id === "first" ? "downloaded" : "idle",
  );
  await playback.replaceQueueAndPlay(["unrelated", "later", "later"], 2);
  await playback.seek(25);
  replace.mockClear();
  offline.set(true);
  state("playing");
  expect(button().disabled).toBe(false);
  button().click();
  state("paused");
  expect(button().disabled).toBe(true);
  button().click();
  expect(cache.queue).toMatchObject({
    tracks: ["unrelated", "later", "later"],
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
  expect(button().disabled).toBe(true);
  pending.resolve(source());
  await settle();
  state("paused");
  playback.clearQueue();
  state("paused");
  expect(button().disabled).toBe(false);
  button().click();
  await settle();
  state("playing");
  expect(replace).toHaveBeenCalledExactlyOnceWith(["first"]);
});

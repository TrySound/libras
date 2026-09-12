// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/app.svelte";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { TrackEngine } from "../src/track.svelte";

const mocks = vi.hoisted(() => ({
  cache: undefined as import("../src/cache.svelte").Cache | undefined,
  route: "/library",
  params: {} as Record<string, string>,
  navigate: vi.fn(),
  options: undefined as
    | ConstructorParameters<typeof import("../src/session.svelte").Session>[0]
    | undefined,
}));

// Exercise the real app, metadata engine and cache; session workflows have their own tests.
vi.mock("../src/session.svelte", () => ({
  Session: class {
    offlineMode = false;
    localReady = true;
    constructor(options: NonNullable<typeof mocks.options>) {
      mocks.options = options;
    }
    start() {
      mocks.options!.selection.cache = mocks.cache!;
      mocks.options!.covers.activate();
      mocks.options!.tracks.activate();
      return null;
    }
    destroy() {}
  },
}));
vi.mock("../src/router-engine", () => ({
  RouterEngine: class {
    match;
    constructor(routes: { pattern: string }[]) {
      this.match = {
        route: routes.find((route) => route.pattern === mocks.route),
        params: mocks.params,
      };
    }
    start() {}
    destroy() {}
    back() {}
    href(path: string) {
      return `#${path}`;
    }
    navigate(path: string, history?: string) {
      mocks.navigate(path, history);
    }
  },
}));
vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => {} }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  mocks.options = undefined;
  mocks.cache = undefined;
  mocks.route = "/library";
  mocks.params = {};
  mocks.navigate.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function library(name: string, savedAt: number): LibrarySnapshot {
  return {
    artists: [{ id: "artist", name, genres: [] }],
    albums: [],
    tracks: [],
    lastModified: savedAt,
    savedAt,
  };
}

it("uses the empty fallback before account selection and when selection is cleared", async () => {
  const disk = installDisk();
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(mocks.options!.selection.cache).toBeUndefined();
  expect(target.textContent).toContain("Connect your library");
  const brand = target.querySelector(".topbar-brand svg");
  expect(brand?.getAttribute("role")).toBe("img");
  expect(brand?.getAttribute("aria-label")).toBe("Libras");
  expect(brand?.getAttribute("viewBox")).toBe("0 0 256 256");
  expect(brand?.getAttribute("fill")).toBe("currentColor");
  expect(brand?.querySelectorAll("path")).toHaveLength(1);
  expect(target.querySelector(".topbar-brand")?.textContent?.trim()).toBe("");
  for (const link of target.querySelectorAll(".topbar-brand a")) {
    expect(link.getAttribute("href")).toBe("#/library");
    expect(link.getAttribute("aria-label")).toBe("Libras home");
    expect(link.getAttribute("data-variant")).toBe("ghost");
    expect(link.classList.contains("icon-button")).toBe(true);
  }
  const dialog = target.querySelector<HTMLDialogElement>("#player-dialog")!;
  const close = vi.spyOn(dialog, "close");
  const home = dialog.querySelector<HTMLAnchorElement>(".topbar-brand a")!;
  home.addEventListener("click", (event) => event.preventDefault(), { once: true });
  home.click();
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith("/settings", "replace");
  expect(disk.getDirectory).not.toHaveBeenCalled();

  const selected = new Cache({ host: "https://music.example", username: "listener" });
  await selected.replaceLibrary(library("Selected artist", 1));
  mocks.options!.selection.cache = selected;
  mocks.options!.covers.activate();
  mocks.options!.tracks.activate();
  flushSync();
  const tile = target.querySelector(".tiles-grid > a.tile");
  expect(tile?.querySelector(".tile-name")?.textContent).toBe("Selected artist");
  expect(tile?.getAttribute("href")).toBe("#/library/artist/artist");
  expect(tile?.getAttribute("data-longpress")).toBe("show-modal");
  expect(tile?.querySelector("a, button")).toBeNull();
  mocks.options!.selection.cache = undefined;
  mocks.options!.covers.activate();
  mocks.options!.tracks.activate();
  flushSync();
  expect(target.querySelector(".tile-name")).toBeNull();
  expect(target.textContent).toContain("Connect your library");
});

it("restores the large player slider when queue hydration finishes before metadata", async () => {
  installDisk();
  // Happy DOM does not clamp range values like browsers do. Model the native
  // setter so a value assigned while max=0 cannot survive as a hidden 45.5.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  vi.spyOn(HTMLInputElement.prototype, "value", "set").mockImplementation(
    function (this: HTMLInputElement, value) {
      if (this.type === "range") value = String(Math.min(Number(value), Number(this.max || 100)));
      setter.call(this, value);
    },
  );
  const cache = new Cache({ host: "https://music.example", username: "listener" });
  cache.setQueue({ tracks: ["track"], index: 0, position: 45.5 });
  await cache.flush();
  mocks.cache = cache;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const slider = target.querySelector<HTMLInputElement>(".playback-slider")!;
  expect(slider.max).toBe("0");
  expect(slider.valueAsNumber).toBe(0);
  await cache.replaceLibrary({
    ...library("Artist", 1),
    tracks: [
      {
        id: "track",
        title: "Track",
        artistId: "artist",
        albumId: "album",
        duration: 120,
        genres: [],
      },
    ],
  });
  flushSync();
  expect(slider.max).toBe("120");
  expect(slider.valueAsNumber).toBe(45.5);
  expect(target.querySelector(".playback-time")?.textContent).toContain("0:45");
  expect(
    parseFloat(target.querySelector<HTMLElement>(".mini-progress > span")!.style.width),
  ).toBeCloseTo((45.5 / 120) * 100);
  expect(cache.queue.position).toBe(45.5);
});

it.each([
  "/library",
  "/settings",
  "/downloads",
  "/library/artist/:artistId",
  "/library/artist/:artistId/album/:albumId",
])("uses ghost controls in the topbars on %s", (route) => {
  installDisk();
  mocks.route = route;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const controls = target.querySelectorAll(".topbar a, .topbar button");
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.getAttribute("data-variant")).toBe("ghost");
});

it("renders the selected cache, reacts to replacements, and stops observing a previous account", async () => {
  installDisk();
  const first = new Cache({ host: "https://music.example", username: "first" });
  await first.replaceLibrary(library("First artist", 1));
  mocks.cache = first;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const names = () => [...target.querySelectorAll(".tile-name")].map((node) => node.textContent);
  await vi.waitFor(() => expect(names()).toEqual(["First artist"]));
  expect(mocks.options!.selection.cache!.artists).toBe(first.artists);

  await first.replaceLibrary(library("Updated artist", 2));
  flushSync();
  expect(names()).toEqual(["Updated artist"]);

  const second = new Cache({ host: "https://music.example", username: "second" });
  await second.replaceLibrary(library("Second artist", 3));
  mocks.options!.metadata.setConnection(undefined);
  mocks.options!.selection.cache = second;
  mocks.options!.covers.activate();
  flushSync();
  expect(names()).toEqual(["Second artist"]);
  expect(mocks.options!.selection.cache!.artists).toBe(second.artists);

  await first.replaceLibrary(library("Late old account", 4));
  flushSync();
  expect(names()).toEqual(["Second artist"]);
});

it("renders download records and jobs without duplicates and switches account projections", async () => {
  installDisk();
  mocks.route = "/downloads";
  const first = new Cache({ host: "https://music.example", username: "first" });
  const track = { id: "track", title: "First download", artist: "Artist", album: "Album" };
  await first.saveDownload(
    track,
    "mp3",
    "audio/mpeg",
    new Response("audio"),
    new AbortController().signal,
  );
  mocks.cache = first;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(first.tracks.size).toBe(0);
  expect(target.textContent).toContain("First download");
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(1);
  const options = mocks.options!;
  const tracks = options.tracks as import("../src/track.svelte").TrackEngine;
  const connection = options.network.accept(
    options.network.prepare({ ...first.account!, token: "token", salt: "salt" }),
  );
  tracks.setConnection(connection.audio);
  const pending = tracks.cache(track, { forceTranscode: true });
  flushSync();
  expect(target.querySelectorAll('[aria-label="Downloading"]')).toHaveLength(1);
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(0);
  await pending;
  flushSync();
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(1);

  const second = new Cache({ ...first.account!, username: "second" });
  await second.saveDownload(
    { ...track, title: "Second download" },
    "mp3",
    "audio/mpeg",
    new Response("audio"),
    new AbortController().signal,
  );
  options.selection.cache = second;
  options.tracks.activate();
  options.covers.activate();
  flushSync();
  expect(target.textContent).toContain("Second download");
  expect(target.textContent).not.toContain("First download");
  await first.saveDownload(
    { ...track, id: "late", title: "Late download" },
    "mp3",
    "audio/mpeg",
    new Response("audio"),
    new AbortController().signal,
  );
  flushSync();
  expect(target.textContent).not.toContain("Late download");
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(1);
  const loading = second.load();
  flushSync();
  expect(target.textContent).toContain("Reading downloaded files");
  await loading;
  flushSync();
  expect(target.textContent).not.toContain("Reading downloaded files");
});

it.each([
  { route: "/library", ids: ["one", "two", "three"] },
  { route: "/library/artist/:artistId/album/:albumId", ids: ["one", "two"] },
])("downloads the selected collection on $route", async ({ route, ids }) => {
  installDisk();
  const cache = new Cache({ host: "https://music.example", username: "listener" });
  await cache.replaceLibrary({
    ...library("Artist", 1),
    albums: [
      { id: "album", artistId: "artist", title: "Album", genres: [] },
      { id: "other", artistId: "artist", title: "Other", genres: [] },
    ],
    tracks: ["one", "two", "three"].map((id, index) => ({
      id,
      title: id,
      artistId: "artist",
      albumId: index < 2 ? "album" : "other",
      number: index + 1,
      mimeType: "audio/mpeg",
      genres: [],
    })),
  });
  const download = vi
    .spyOn(TrackEngine.prototype, "cache")
    .mockResolvedValue(new File([], "audio"));
  mocks.cache = cache;
  mocks.route = route;
  mocks.params = { artistId: "artist", albumId: "album" };
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const button = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Download",
  );
  expect(button).toBeDefined();
  button!.click();
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(ids.length));
  expect(download.mock.calls.map(([track]) => track.id)).toEqual(ids);
  expect(download).toHaveBeenCalledWith({
    id: "one",
    title: "one",
    artist: "Artist",
    album: "Album",
    contentType: "audio/mpeg",
  });
});

it("renders cached artwork and drops the previous account's object URLs", async () => {
  installDisk();
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:artwork-${++sequence}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const first = new Cache({ host: "https://music.example", username: "first" });
  const data = library("Artist", 1);
  data.artists[0].artworkId = "cover";
  await first.replaceLibrary(data);
  mocks.cache = first;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.querySelector(".tile-image img")).toBeNull();

  await first.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" });
  await mocks.options!.covers.refresh();
  flushSync();
  expect(mocks.options!.selection.cache!.images).toBe(first.images);
  expect(target.querySelector(".tile-image img")?.getAttribute("src")).toBe("blob:artwork-1");

  const second = new Cache({ ...first.account!, username: "second" });
  await second.replaceLibrary(data);
  mocks.options!.selection.cache = second;
  mocks.options!.covers.activate();
  flushSync();
  await mocks.options!.covers.refresh();
  flushSync();
  expect(target.querySelector(".tile-image img")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:artwork-1");
  expect(mocks.options!.selection.cache!.images).toBe(second.images);
  expect(mocks.options!.selection.cache!.images.size).toBe(0);

  await first.saveImage("cover", { blob: new Blob(["late old image"]), type: "image/png" });
  await mocks.options!.covers.refresh();
  flushSync();
  expect(target.querySelector(".tile-image img")).toBeNull();
});

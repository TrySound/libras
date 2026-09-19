import { getAccountKey } from "../src/auth";
// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/app.svelte";
import { installNavigation } from "./router-test-helpers";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { TrackEngine } from "../src/track.svelte";
import { Covers } from "../src/covers.svelte";

const mocks = vi.hoisted(() => ({
  localReady: true,
  isOffline: (): boolean => false,
  cache: undefined as import("../src/cache.svelte").Cache | undefined,
  navigate: vi.fn(),
  options: undefined as
    | ConstructorParameters<typeof import("../src/session.svelte").Session>[0]
    | undefined,
}));

// Exercise the real app and cache; session workflows have their own tests.
vi.mock("../src/session.svelte", () => ({
  Session: class {
    get offlineMode() {
      return mocks.isOffline();
    }
    localReady = mocks.localReady;
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

vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => {} }));

beforeEach(() => {
  mocks.localReady = true;
  mocks.isOffline = () => false;
  installNavigation("/library", mocks.navigate);
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  mocks.options = undefined;
  mocks.cache = undefined;
  mocks.navigate.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function library(name: string, savedAt: number): LibrarySnapshot {
  return {
    artists: [{ id: "artist", name }],
    albums: [],
    tracks: [],
    lastModified: savedAt,
    savedAt,
  };
}

it("uses session restoration state on the downloads page", () => {
  mocks.localReady = false;
  installNavigation("/downloads", mocks.navigate);
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.textContent).toContain("Restoring local library…");
  expect(target.textContent).not.toContain("No downloaded files yet.");
});

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
  expect(brand?.querySelectorAll("path")).toHaveLength(0);
  expect(brand?.querySelector("use")?.getAttribute("href")).toBe("#icon-brand");
  expect(target.querySelector(".topbar-brand")?.textContent?.trim()).toBe("");
  for (const link of target.querySelectorAll(".topbar-brand a")) {
    expect(link.getAttribute("href")).toBe("#/library");
    expect(link.getAttribute("aria-label")).toBe("Libras home");
    expect(link.getAttribute("data-variant")).toBe("ghost");
    expect(link.classList.contains("icon-button")).toBe(true);
  }
  const dialog = target.querySelector<HTMLDialogElement>("#player-dialog")!;
  expect(dialog.querySelector(".topbar-brand")).toBeNull();
  expect(mocks.navigate).toHaveBeenCalledWith("/settings", "replace");
  expect(disk.getDirectory).not.toHaveBeenCalled();

  const selected = new Cache(
    getAccountKey({ host: "https://music.example", username: "listener" }),
  );
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

it("automatically loads another batch each time the new sentinel is nearby", async () => {
  installDisk();
  let callback: IntersectionObserverCallback;
  const observed = new Set<Element>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(node: Element) {
        observed.add(node);
      }
      unobserve(node: Element) {
        observed.delete(node);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  const snapshot: LibrarySnapshot = {
    ...library("Artist", 1),
    artists: Array.from({ length: 100 }, (_, index) => ({
      id: index === 0 ? "artist" : `artist-${index}`,
      name: `Artist ${index}`,
      genres: [],
    })),
  };
  await cache.replaceLibrary(snapshot);
  mocks.cache = cache;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const assertCount = (count: number) => {
    expect(target.querySelectorAll(".tiles-grid > .tile")).toHaveLength(count);
    expect(target.querySelectorAll("#artist-menu")).toHaveLength(1);
  };
  assertCount(48);
  expect(target.textContent).toContain("100 artists");
  expect(target.textContent).not.toContain("Load more");
  const sentinel = () =>
    [...observed].find((node) => node.matches('.library-view [aria-hidden="true"]'));
  for (const count of [96, 100]) {
    const node = sentinel()!;
    expect(node).toBeDefined();
    callback!(
      [{ target: node, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    flushSync();
    assertCount(count);
    expect(observed.has(node)).toBe(false);
  }
  expect(sentinel()).toBeUndefined();

  let currentEntry = { key: "home", index: 0 };
  async function visit(path: string, key: string, index: number, navigationType = "push") {
    Object.assign(window.navigation, { currentEntry });
    let finished: Promise<void> | undefined;
    const event = Object.assign(new Event("navigate"), {
      canIntercept: true,
      navigationType,
      destination: { url: new URL(`#${path}`, window.location.href).href, key, index },
      intercept({ handler }: { handler: () => Promise<void> }) {
        finished = handler();
      },
    });
    window.navigation.dispatchEvent(event);
    await finished;
    flushSync();
    currentEntry = { key, index };
  }
  await visit("/library/artist/artist", "artist", 1);
  await visit("/library", "home", 0, "traverse");
  assertCount(48); // Back navigation also starts fresh.
  await visit("/library/artist/artist", "artist", 1, "traverse");
  await visit("/library", "new-home", 2);
  assertCount(48); // A normal Home link starts fresh.
  callback!(
    [{ target: sentinel()!, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  flushSync();
  assertCount(96);
  await cache.replaceLibrary({ ...snapshot, savedAt: 2 });
  flushSync();
  assertCount(96); // Refresh preserves pagination while the page stays mounted.
  callback!(
    [{ target: sentinel()!, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  flushSync();
  assertCount(100);
  await visit("/library", "replacement", 2, "replace");
  assertCount(100); // Same-route navigation does not remount the page.

  const other = new Cache(getAccountKey({ host: "https://other.example", username: "listener" }));
  await other.replaceLibrary({ ...snapshot, savedAt: 2 });
  mocks.options!.selection.cache = other;
  flushSync();
  assertCount(100); // Changing the cache does not reset local pagination state.
  await visit("/library", "home", 0, "traverse");
  assertCount(100);
});

it("preserves artist pagination when offline eligibility changes", async () => {
  installDisk();
  const flags = new SvelteSet<string>();
  mocks.isOffline = () => flags.has("offline");
  const downloaded = new SvelteSet(Array.from({ length: 100 }, (_, i) => String(i)));
  vi.spyOn(TrackEngine.prototype, "getStatus").mockImplementation((id) =>
    downloaded.has(id) ? "downloaded" : "idle",
  );
  let callback: IntersectionObserverCallback;
  const observed = new Set<Element>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(node: Element) {
        observed.add(node);
      }
      unobserve(node: Element) {
        observed.delete(node);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    ...library("Artist", 1),
    artists: [...downloaded].map((id) => ({ id, name: `Artist ${id}` })),
    albums: [...downloaded].map((id) => ({
      id,
      title: `Album ${id}`,
      artistIds: [id],
      genres: [],
    })),
    tracks: [...downloaded].map((id) => ({
      id,
      title: `Track ${id}`,
      artistIds: [id],
      albumId: id,
      genres: [],
    })),
  });
  mocks.cache = cache;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const count = () => target.querySelectorAll("a.tile").length;
  const load = () => {
    const node = [...observed].find((node) => node.matches('.library-view [aria-hidden="true"]'))!;
    callback!(
      [{ target: node, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    flushSync();
  };
  load();
  expect(count()).toBe(96);
  flags.add("offline");
  flushSync();
  expect(count()).toBe(96);
  downloaded.delete("99");
  flushSync();
  expect(count()).toBe(96);
  expect(target.textContent).toContain("99 artists");
  downloaded.clear();
  flushSync();
  expect(count()).toBe(0);
  expect(target.textContent).toContain("No downloaded artists.");
  flags.clear();
  flushSync();
  expect(count()).toBe(96);
});

it("renders the cache stress fixture with unique tiles and one shared menu", async () => {
  installDisk();
  vi.stubEnv("VITE_STRESS_ARTISTS", "1");
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary(library("Artist", 1));
  mocks.cache = cache;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const tiles = [...target.querySelectorAll<HTMLAnchorElement>("a.tile")];
  expect(tiles).toHaveLength(48);
  for (const tile of tiles) {
    const artwork = tile.querySelector(".artwork")!;
    const label = tile.querySelector(".tile-name")!;
    expect(artwork.parentElement).toBe(tile);
    expect(label.parentElement).toBe(tile);
    expect(artwork.getAttribute("aria-hidden")).toBe("true");
    expect(label.closest('[aria-hidden="true"]')).toBeNull();
  }
  expect(cache.artists.size).toBe(100);
  expect(cache.albums.size).toBe(0);
  expect(cache.tracks.size).toBe(0);
  expect(new Set(tiles.map((tile) => tile.getAttribute("href"))).size).toBe(48);
  expect(
    new Set(
      tiles.map((tile) => tile.querySelector<HTMLElement>(".artwork")!.style.viewTransitionName),
    ).size,
  ).toBe(48);
  expect(target.querySelectorAll("#artist-menu")).toHaveLength(1);
  tiles[47].focus();
  flushSync();
  expect(target.querySelector("#artist-menu-title")?.textContent).toBe("Artist (47)");
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
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
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
        artistIds: ["artist"],
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
  window.history.replaceState(null, "", `#${route}`);
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const topbar = target.querySelector(".app-shell > .topbar")!;
  expect(target.querySelectorAll(".app-shell > .topbar")).toHaveLength(1);
  const links = topbar.querySelectorAll("a");
  expect([...links].map((link) => link.getAttribute("href"))).toEqual(["#/library", "#/settings"]);
  expect(target.querySelector("#player-dialog .topbar-brand")).toBeNull();
  expect(target.querySelector(".player-queue")!.closest(".view")).toBeNull();
  expect(target.querySelector(".player-main")!.classList.contains("view")).toBe(false);
  expect(target.querySelector(".player-main > .artwork")!.closest(".view")).toBeNull();
  expect(target.querySelector(".player-main > .player-content.view .controls")).not.toBeNull();
  expect(target.querySelector(".player-content .playback-slider")).not.toBeNull();
  expect(target.querySelector(".player-queue > .section-heading")!.classList.contains("view")).toBe(
    true,
  );
  const controls = target.querySelectorAll(".topbar a, .topbar button");
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.getAttribute("data-variant")).toBe("ghost");
});

it.each([
  { route: "/library", selector: ".tile", menu: "artist-menu" },
  { route: "/library/artist/artist", selector: "a.linkarea", menu: "album-menu-0" },
  {
    route: "/library/artist/artist/album/album",
    selector: "button.linkarea",
    menu: "album-track-menu-0",
  },
])(
  "keeps available content and menus usable during restoration on $route",
  async ({ route, selector, menu }) => {
    installDisk();
    const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
    await cache.replaceLibrary({
      ...library("Artist", 1),
      albums: [{ id: "album", artistIds: ["artist"], title: "Album", genres: [] }],
      tracks: [
        {
          id: "track",
          albumId: "album",
          artistIds: ["artist"],
          title: "Track",
          mimeType: "audio/mpeg",
          genres: [],
        },
      ],
    });
    mocks.cache = cache;
    mocks.localReady = false;
    installNavigation(route, mocks.navigate);
    const target = document.createElement("main");
    document.body.append(target);
    const component = mount(App, { target });
    cleanups.push(() => unmount(component));
    flushSync();
    expect(target.textContent).toContain("Restoring local library…");
    expect(target.querySelector(selector)).not.toBeNull();
    if (route !== "/library") {
      expect(target.querySelector(selector)!.closest(".view")).toBeNull();
      expect(target.querySelector(".collection-heading")?.closest(".view")).not.toBeNull();
    }
    target.querySelector<HTMLElement>(selector)!.focus();
    flushSync();
    const dialog = target.querySelector(`#${menu}`);
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".wings-item")?.hasAttribute("disabled")).toBe(false);
    for (const menu of target.querySelectorAll<HTMLDialogElement>(".action-menu")) {
      const wings = menu.querySelector(":scope > .wings")!;
      expect(wings.querySelector(":scope > .topbar.wings-item")).not.toBeNull();
      expect(wings.querySelectorAll(":scope > button.wings-item")).toHaveLength(4);
      const close = wings.querySelector<HTMLButtonElement>(".topbar button")!;
      expect(close.hasAttribute("commandfor")).toBe(false);
      expect(close.hasAttribute("command")).toBe(false);
      expect(close.getAttribute("title")).toBe("Close menu");
      expect(close.getAttribute("data-variant")).toBe("ghost");
      expect(close.querySelector("use")?.getAttribute("href")).toBe("#icon-chevron-down");
      expect(menu.querySelector(".topbar .type-title")?.id).toBe(
        menu.getAttribute("aria-labelledby"),
      );
      expect(menu.textContent).not.toContain("Cancel");
      menu.showModal();
      close.click();
      expect(menu.open).toBe(false);
    }
  },
);

it("reuses one library menu for the long-pressed artist", async () => {
  installDisk();
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    artists: ["one", "two"].map((id) => ({ id, name: `Artist ${id}` })),
    albums: ["one", "two"].map((id) => ({ id, artistIds: [id], title: id, genres: [] })),
    tracks: ["one", "two"].map((id) => ({
      id,
      artistIds: [id],
      albumId: id,
      title: id,
      genres: [],
    })),
    lastModified: 1,
    savedAt: 1,
  });
  mocks.cache = cache;
  const download = vi
    .spyOn(TrackEngine.prototype, "download")
    .mockResolvedValue(new File([], "audio"));
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.querySelectorAll(".action-menu")).toHaveLength(1);
  const menu = target.querySelector<HTMLDialogElement>("#artist-menu")!;
  const tiles = target.querySelectorAll<HTMLElement>(".tile");
  for (const [index, id] of ["one", "two"].entries()) {
    expect(tiles[index].dataset.longpressfor).toBe(menu.id);
    const down = new Event("pointerdown", { bubbles: true });
    Object.assign(down, { isPrimary: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    tiles[index].dispatchEvent(down);
    await vi.waitFor(() => expect(menu.open).toBe(true));
    flushSync();
    expect(menu.querySelector("header")?.textContent?.trim()).toBe(`Artist ${id}`);
    const button = [...menu.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Download",
    )!;
    button.click();
    expect(download).toHaveBeenLastCalledWith(id);
    expect(menu.open).toBe(false);
    expect(target.querySelectorAll(".action-menu")).toHaveLength(1);
  }
  expect(download).toHaveBeenCalledTimes(2);
});

it("derives artist genres from albums and reacts to library updates", async () => {
  installDisk();
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  const snapshot = {
    ...library("Artist", 1),
    albums: [
      { id: "album", artistIds: ["artist"], title: "Album", genres: ["Rock", "Jazz"] },
      { id: "second", artistIds: ["artist"], title: "Second", genres: ["Jazz", "Soul"] },
    ],
    tracks: [
      {
        id: "track",
        albumId: "album",
        artistIds: ["artist"],
        title: "Track",
        genres: ["Track-only genre"],
      },
    ],
  };
  await cache.replaceLibrary(snapshot);
  mocks.cache = cache;
  installNavigation("/library/artist/artist", mocks.navigate);
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const labels = () =>
    [...target.querySelectorAll(".genre-list > *")].map((node) => node.textContent?.trim());
  expect(labels()).toEqual(["Rock", "Jazz", "Soul"]);
  expect(cache.artists.get("artist")).not.toHaveProperty("genres");

  await cache.replaceLibrary({
    ...snapshot,
    albums: [{ ...snapshot.albums[0], genres: ["Blues"] }],
  });
  flushSync();
  expect(labels()).toEqual(["Blues"]);

  await cache.replaceLibrary({ ...snapshot, albums: [{ ...snapshot.albums[0], genres: [] }] });
  flushSync();
  expect(target.querySelector(".genre-list")).toBeNull();
});

it.each([
  { displayArtist: "Lead feat. Guest", expected: "Lead feat. Guest" },
  { displayArtist: undefined, expected: "Lead" },
])("shows displayArtist=$displayArtist in both players", async ({ displayArtist, expected }) => {
  installDisk();
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    ...library("Lead", 1),
    albums: [{ id: "album", artistIds: ["artist"], title: "Album", genres: [] }],
    tracks: [
      {
        id: "track",
        albumId: "album",
        artistIds: ["artist"],
        title: "Track",
        displayArtist,
        genres: [],
      },
    ],
  });
  cache.setQueue({ tracks: ["track"], index: 0, position: 0 });
  mocks.cache = cache;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.querySelector(".mini-copy small")?.textContent?.trim()).toBe(expected);
  const artistLink = target.querySelector("#player-dialog .player-content a");
  expect(artistLink?.textContent?.trim()).toBe(expected);
  expect(artistLink?.getAttribute("href")).toBe("#/library/artist/artist");
});

it("shows current track genres in the player without album fallbacks", async () => {
  installDisk();
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    ...library("Artist", 1),
    albums: [{ id: "album", artistIds: ["artist"], title: "Album", genres: ["Album-only genre"] }],
    tracks: [
      {
        id: "first",
        albumId: "album",
        artistIds: ["artist"],
        title: "First",
        genres: ["Soul", "Jazz|Fusion"],
      },
      { id: "second", albumId: "album", artistIds: ["artist"], title: "Second", genres: ["Rock"] },
      { id: "third", albumId: "album", artistIds: ["artist"], title: "Third", genres: [] },
    ],
  });
  const tracks = ["first", "second", "third"];
  cache.setQueue({ tracks, index: 0, position: 0 });
  mocks.cache = cache;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const labels = () =>
    [...target.querySelectorAll("#player-dialog .genre-list span")].map((node) =>
      node.textContent?.trim(),
    );
  expect(labels()).toEqual(["Soul", "Jazz|Fusion"]);

  cache.setQueue({ tracks, index: 1, position: 0 });
  flushSync();
  expect(labels()).toEqual(["Rock"]);

  cache.setQueue({ tracks, index: 2, position: 0 });
  flushSync();
  expect(target.querySelector("#player-dialog .genre-list")).toBeNull();

  cache.setQueue({ tracks: [], index: 0, position: 0 });
  flushSync();
  expect(target.querySelector("#player-dialog .genre-list")).toBeNull();
});

it("shows only album genres on the album route", async () => {
  installDisk();
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    ...library("Artist", 1),
    albums: [{ id: "album", artistIds: ["artist"], title: "Album", genres: ["Jazz"] }],
    tracks: [
      {
        id: "track",
        albumId: "album",
        artistIds: ["artist"],
        title: "Track",
        genres: ["Track-only genre"],
      },
    ],
  });
  mocks.cache = cache;
  installNavigation("/library/artist/artist/album/album", mocks.navigate);
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.querySelector(".genre-list")?.textContent?.trim()).toBe("Jazz");
  expect(target.querySelector(".collection-heading a")?.getAttribute("href")).toBe(
    "#/library/artist/artist",
  );
});

it("renders the selected cache, reacts to replacements, and stops observing a previous account", async () => {
  installDisk();
  const first = new Cache(getAccountKey({ host: "https://music.example", username: "first" }));
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

  const second = new Cache(getAccountKey({ host: "https://music.example", username: "second" }));
  await second.replaceLibrary(library("Second artist", 3));
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
  window.history.replaceState(null, "", "#/downloads");
  const first = new Cache(getAccountKey({ host: "https://music.example", username: "first" }));
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
    options.network.prepare({
      host: "https://music.example",
      username: "first",
      token: "token",
      salt: "salt",
    }),
  );
  tracks.setConnection(connection.audio);
  const pending = tracks.download(track.id, { forceTranscode: true });
  flushSync();
  expect(target.querySelectorAll('[aria-label="Downloading"]')).toHaveLength(1);
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(0);
  await pending;
  flushSync();
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(1);

  const second = new Cache(getAccountKey({ host: "https://music.example", username: "second" }));
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
  expect(target.textContent).not.toContain("Restoring local library…");
  await loading;
  flushSync();
  expect(target.textContent).toContain("Second download");
});

it.each([
  { route: "/library", ids: ["one", "two", "three"] },
  { route: "/library/artist/:artistId", ids: ["one", "two", "three"] },
  { route: "/library/artist/:artistId/album/:albumId", ids: ["one", "two"] },
])("downloads the selected collection on $route", async ({ route, ids }) => {
  installDisk();
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    ...library("Artist", 1),
    albums: [
      { id: "album", artistIds: ["artist"], title: "Album", genres: [] },
      { id: "other", artistIds: ["artist"], title: "Other", genres: [] },
    ],
    tracks: ["one", "two", "three"].map((id, index) => ({
      id,
      title: id,
      artistIds: ["artist"],
      albumId: index < 2 ? "album" : "other",
      number: index + 1,
      mimeType: "audio/mpeg",
      genres: [],
    })),
  });
  const download = vi
    .spyOn(TrackEngine.prototype, "download")
    .mockResolvedValue(new File([], "audio"));
  mocks.cache = cache;
  window.history.replaceState(
    null,
    "",
    `#${route.replace(":artistId", "artist").replace(":albumId", "album")}`,
  );
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  target.querySelector<HTMLElement>(".tile")?.focus();
  flushSync();
  const button = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Download",
  );
  expect(button).toBeDefined();
  button!.click();
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(ids.length));
  expect(download.mock.calls.map(([trackId]) => trackId)).toEqual(ids);
});

it.each([
  { route: "/library/artist/artist", selector: "a.linkarea", observesArtwork: true },
  {
    route: "/library/artist/artist/album/album",
    selector: "button.linkarea",
    observesArtwork: false,
  },
])("keeps row controls accessible on $route", async ({ route, selector, observesArtwork }) => {
  installDisk();
  const load = vi.fn();
  vi.spyOn(Covers.prototype, "ensureCover").mockImplementation((id) => ({
    source: undefined,
    load: id === "album-cover" ? load : () => {},
  }));
  const observers = new Map<Element, (visible: boolean) => void>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observers.set(target, (isIntersecting) =>
          this.callback(
            [{ target, isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve(target: Element) {
        observers.delete(target);
      }
      disconnect() {
        observers.clear();
      }
    },
  );
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  await cache.replaceLibrary({
    ...library("Artist", 1),
    albums: [
      { id: "album", artistIds: ["artist"], title: "Album", artworkId: "album-cover", genres: [] },
    ],
    tracks: [{ id: "track", albumId: "album", artistIds: ["artist"], title: "Track", genres: [] }],
  });
  mocks.cache = cache;
  window.history.replaceState(null, "", `#${route}`);
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const control = target.querySelector<HTMLElement>(selector)!;
  expect(control).not.toBeNull();
  const row = control.parentElement!;
  expect(row.hasAttribute("tabindex")).toBe(false);
  expect(row.hasAttribute("data-viewport-hidden")).toBe(false);
  control.focus();
  expect(document.activeElement).toBe(control);
  expect(observers.size).toBe(observesArtwork ? 1 : 0);
  if (observesArtwork) {
    expect(load).not.toHaveBeenCalled();
    observers.get(row.querySelector(".artwork")!)!(false);
    expect(load).not.toHaveBeenCalled();
    observers.get(row.querySelector(".artwork")!)!(true);
    expect(load).toHaveBeenCalledOnce();
    observers.get(row.querySelector(".artwork")!)!(false);
    expect(row.hasAttribute("data-viewport-hidden")).toBe(false);
  }
});

it("renders cached artwork only near the viewport and drops the previous account's object URLs", async () => {
  installDisk();
  const intersections: ((visible: boolean) => void)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        expect(target.matches(".artwork")).toBe(true);
        intersections.push((visible) =>
          this.callback(
            [{ target, isIntersecting: visible } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:artwork-${++sequence}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const first = new Cache(getAccountKey({ host: "https://music.example", username: "first" }));
  const data = library("Artist", 1);
  data.artists[0].artworkId = "cover";
  await first.replaceLibrary(data);
  mocks.cache = first;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.querySelector(".artwork img")).toBeNull();

  await first.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" });
  await mocks.options!.covers.refresh();
  flushSync();
  expect(mocks.options!.selection.cache!.images).toBe(first.images);
  expect(target.querySelector(".artwork img")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  const tile = target.querySelector("a.tile")!;
  expect(tile.getAttribute("aria-label")).toBe("Artist");
  expect(tile.hasAttribute("data-viewport-hidden")).toBe(false);
  intersections[0](true);
  expect(tile.hasAttribute("data-viewport-hidden")).toBe(false);
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".artwork img")?.getAttribute("src")).toBe("blob:artwork-1");
  });
  intersections[0](false);
  expect(tile.hasAttribute("data-viewport-hidden")).toBe(false);
  intersections[0](true);
  await mocks.options!.covers.refresh();
  expect(tile.hasAttribute("data-viewport-hidden")).toBe(false);
  expect(URL.createObjectURL).toHaveBeenCalledOnce();

  const second = new Cache(getAccountKey({ host: "https://music.example", username: "second" }));
  await second.replaceLibrary(data);
  mocks.options!.selection.cache = second;
  mocks.options!.covers.activate();
  flushSync();
  await mocks.options!.covers.refresh();
  flushSync();
  expect(target.querySelector(".artwork img")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:artwork-1");
  expect(mocks.options!.selection.cache!.images).toBe(second.images);
  expect(mocks.options!.selection.cache!.images.size).toBe(0);

  await first.saveImage("cover", { blob: new Blob(["late old image"]), type: "image/png" });
  await mocks.options!.covers.refresh();
  flushSync();
  expect(target.querySelector(".artwork img")).toBeNull();
});

it("follows normalized album artwork IDs without publishing a late old image", async () => {
  installDisk();
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:reference-${++sequence}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const cache = new Cache(getAccountKey({ host: "https://music.example", username: "listener" }));
  const data = {
    ...library("Artist", 1),
    artists: [{ id: "artist", name: "Artist", artworkId: "artist-cover" }],
    albums: [
      { id: "album", artistIds: ["artist"], title: "Album", artworkId: "old-cover", genres: [] },
    ],
  };
  await cache.replaceLibrary(data);
  for (const id of ["old-cover", "new-cover", "artist-cover"]) {
    await cache.saveImage(id, { blob: new Blob([id]), type: "image/png" });
  }
  const opened = await cache.readImage("old-cover");
  let completeOld!: (value: typeof opened) => void;
  const pending = new Promise<typeof opened>((resolve) => {
    completeOld = resolve;
  });
  const readImage = cache.readImage.bind(cache);
  const read = vi
    .spyOn(cache, "readImage")
    .mockImplementation((id, signal) => (id === "old-cover" ? pending : readImage(id, signal)));
  mocks.cache = cache;
  window.history.replaceState(null, "", "#/library/artist/artist/album/album");
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith("old-cover", expect.any(AbortSignal)));
  await cache.replaceLibrary({
    ...data,
    savedAt: 2,
    albums: [{ ...data.albums[0], artworkId: "new-cover" }],
  });
  const image = () => target.querySelector(".collection-view .artwork img")?.getAttribute("src");
  await vi.waitFor(() => {
    flushSync();
    expect(image()).toBe("blob:reference-1");
  });
  completeOld(opened);
  await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
  flushSync();
  expect(image()).toBe("blob:reference-1");
  await cache.replaceLibrary({
    ...data,
    savedAt: 3,
    albums: [{ ...data.albums[0], artworkId: "artist-cover" }],
  });
  await vi.waitFor(() => {
    flushSync();
    expect(image()).toBe("blob:reference-3");
  });
  await cache.replaceLibrary({
    ...data,
    savedAt: 4,
    albums: [{ ...data.albums[0], artworkId: undefined }],
    artists: [{ ...data.artists[0], artworkId: undefined }],
  });
  flushSync();
  expect(image()).toBeUndefined();
  expect(target.querySelector(".collection-view .artwork svg")).not.toBeNull();
});

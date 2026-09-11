// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "./app.svelte";
import { Cache, type LibrarySnapshot } from "./cache.svelte";
import { OpfsJsonStore } from "./json-store";
import { installDisk } from "./cache-test-helpers";

const mocks = vi.hoisted(() => ({
  cache: undefined as import("./cache.svelte").Cache | undefined,
  options: undefined as
    | ConstructorParameters<typeof import("./session.svelte").Session>[0]
    | undefined,
}));

// Exercise the real app, metadata engine and cache; session workflows have their own tests.
vi.mock("./session.svelte", () => ({
  Session: class {
    offlineMode = false;
    localReady = true;
    constructor(options: NonNullable<typeof mocks.options>) {
      mocks.options = options;
    }
    start() {
      mocks.options!.memory.account = mocks.cache!.account;
      mocks.options!.memory.cache = mocks.cache!;
      mocks.options!.covers.activate();
      return null;
    }
    destroy() {}
  },
}));
vi.mock("./router-engine", () => ({
  RouterEngine: class {
    match;
    constructor(routes: { pattern: string }[]) {
      this.match = { route: routes.find((route) => route.pattern === "/library"), params: {} };
    }
    start() {}
    destroy() {}
    back() {}
    href(path: string) {
      return `#${path}`;
    }
    navigate() {}
  },
}));
vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => {} }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  mocks.options = undefined;
  mocks.cache = undefined;
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

it("renders the cache through Memory, reacts to replacements, and stops observing a previous account", async () => {
  // File durability is covered by cache tests; commit immediately here.
  vi.spyOn(OpfsJsonStore.prototype, "update").mockImplementation(async (change) => ({
    written: true,
    value: change(null) ?? null,
  }));
  const first = new Cache({ host: "https://music.example", username: "first" });
  await first.replaceLibrary(library("First artist", 1));
  mocks.cache = first;
  const target = document.createElement("main");
  document.body.append(target);
  const component = mount(App, { target });
  cleanups.push(() => unmount(component));
  flushSync();
  const names = () => [...target.querySelectorAll(".artist-name")].map((node) => node.textContent);
  await vi.waitFor(() => expect(names()).toEqual(["First artist"]));
  expect(mocks.options!.memory.artists).toBe(first.artists);

  await first.replaceLibrary(library("Updated artist", 2));
  flushSync();
  expect(names()).toEqual(["Updated artist"]);

  const second = new Cache({ host: "https://music.example", username: "second" });
  await second.replaceLibrary(library("Second artist", 3));
  mocks.options!.memory.account = second.account;
  mocks.options!.metadata.setConnection(undefined);
  mocks.options!.memory.cache = second;
  mocks.options!.covers.activate();
  flushSync();
  expect(names()).toEqual(["Second artist"]);
  expect(mocks.options!.memory.artists).toBe(second.artists);

  await first.replaceLibrary(library("Late old account", 4));
  flushSync();
  expect(names()).toEqual(["Second artist"]);
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
  expect(target.querySelector(".artist-cover img")).toBeNull();

  await first.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" });
  await mocks.options!.covers.refresh();
  flushSync();
  expect(mocks.options!.memory.images).toBe(first.images);
  expect(target.querySelector(".artist-cover img")?.getAttribute("src")).toBe("blob:artwork-1");

  const second = new Cache({ ...first.account, username: "second" });
  await second.replaceLibrary(data);
  mocks.options!.memory.account = second.account;
  mocks.options!.memory.cache = second;
  mocks.options!.covers.activate();
  flushSync();
  await mocks.options!.covers.refresh();
  flushSync();
  expect(target.querySelector(".artist-cover img")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:artwork-1");
  expect(mocks.options!.memory.images).toBe(second.images);
  expect(mocks.options!.memory.images.size).toBe(0);

  await first.saveImage("cover", { blob: new Blob(["late old image"]), type: "image/png" });
  await mocks.options!.covers.refresh();
  flushSync();
  expect(target.querySelector(".artist-cover img")).toBeNull();
});

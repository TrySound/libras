// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "./app.svelte";
import { Cache, type LibrarySnapshot } from "./cache.svelte";
import { OpfsJsonStore } from "./json-store";

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
      void mocks.options!.metadata.restore(mocks.cache!);
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
  vi.spyOn(first, "load").mockResolvedValue();
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
  mocks.options!.metadata.acceptConnection(second);
  flushSync();
  expect(names()).toEqual(["Second artist"]);
  expect(mocks.options!.memory.artists).toBe(second.artists);

  await first.replaceLibrary(library("Late old account", 4));
  flushSync();
  expect(names()).toEqual(["Second artist"]);
});

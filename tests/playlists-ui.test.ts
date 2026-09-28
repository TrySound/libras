// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import Library from "../src/_library.svelte";
import PlaylistRoute from "../src/_playlist.svelte";
import PlaylistPicker from "../src/playlist-picker.svelte";
import { PlaylistConflictError } from "../src/playlists.svelte";
import { installNavigation } from "./router-test-helpers";
import type { ComponentProps } from "svelte";

const cover = { load: vi.fn(), source: undefined };
const covers = { ensureCover: () => cover };
const summary = { id: "p/1", name: "Mix", owner: "user" };
const entries = [
  { id: "lost", title: "Unavailable" },
  { id: "a", title: "Known" },
  { id: "a", title: "Known" },
];
const detail = { summary, entries, fetchedAt: 12 };

function cache() {
  return {
    key: "account",
    savedAt: undefined,
    playlists: { listedAt: 1, summaries: [summary], details: [detail] },
    tracks: new Map([["a", { id: "a", title: "Known", albumId: "album", artistIds: ["artist"] }]]),
    artists: new Map(),
    albums: new Map(),
    artistAlbums: new Map(),
    albumTracks: new Map(),
    queue: { tracks: [], index: -1, position: 0 },
  };
}

function render(component: typeof Library | typeof PlaylistRoute, props: object) {
  const target = document.createElement("div");
  document.body.append(target);
  const instance = mount(component as typeof Library, {
    target,
    props: props as ComponentProps<typeof Library>,
  });
  flushSync();
  return {
    target,
    async cleanup() {
      await unmount(instance);
      target.remove();
    },
  };
}

describe("playlist UI", () => {
  it("creates with the + control, navigates only on success and reports failures", async () => {
    const navigation = installNavigation();
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: "new/id", name: "Generated" })
      .mockRejectedValueOnce(new Error("No permission"));
    const { target, cleanup } = render(Library, {
      cache: cache(),
      covers,
      session: { localReady: true, offlineMode: false },
      trackEngine: { getStatus: () => "idle" },
      playback: {},
      playlists: { create },
    });
    try {
      const button = target.querySelector<HTMLButtonElement>('[aria-label="Create playlist"]')!;
      button.click();
      await vi.waitFor(() =>
        expect(navigation.navigate).toHaveBeenCalledWith("#/library/playlist/new%2Fid", {
          history: "push",
        }),
      );
      button.click();
      await vi.waitFor(() =>
        expect(target.querySelector('[role="alert"]')?.textContent).toContain("No permission"),
      );
      expect(navigation.navigate).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("adds duplicate occurrences using a fresh detail baseline", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const open = vi.fn(async () => detail);
    const apply = vi.fn(async () => detail);
    const instance = mount(PlaylistPicker, {
      target,
      props: {
        cache: cache() as never,
        playlists: { open, apply } as never,
        session: { offlineMode: false, auth: { username: "user" } } as never,
      },
    });
    try {
      flushSync();
      instance.open(["a", "a"]);
      target.querySelector<HTMLButtonElement>(".playlist-picker button.row-button")!.click();
      await vi.waitFor(() =>
        expect(apply).toHaveBeenCalledWith({
          kind: "append",
          id: "p/1",
          expected: ["lost", "a", "a"],
          ids: ["a", "a"],
        }),
      );
    } finally {
      await unmount(instance);
      target.remove();
    }
  });

  it("lists cached playlists above artists without a library snapshot while offline", async () => {
    const { target, cleanup } = render(Library, {
      cache: cache(),
      covers,
      session: { localReady: true, offlineMode: true },
      trackEngine: { getStatus: () => "idle" },
      playback: {},
      playlists: {},
    });
    try {
      expect(target.textContent).toContain("Playlists");
      expect(
        target.querySelector<HTMLAnchorElement>('a[href="#/library/playlist/p%2F1"]')?.textContent,
      ).toContain("Mix");
      expect(
        target.querySelector<HTMLButtonElement>('[aria-label="Create playlist"]')?.disabled,
      ).toBe(true);
      expect(target.textContent).toContain("Connect your library");
    } finally {
      await cleanup();
    }
  });

  it("renames from the playlist page using its ordered baseline", async () => {
    const apply = vi.fn(async () => detail);
    const { target, cleanup } = render(PlaylistRoute, {
      params: { playlistId: "p/1" },
      cache: cache(),
      covers,
      playlists: { open: vi.fn(async () => detail), apply },
      session: { localReady: true, offlineMode: false, auth: { username: "user" } },
      trackEngine: { getStatus: () => "downloaded" },
      playback: {},
    });
    try {
      const input = target.querySelector<HTMLInputElement>('[aria-label="Playlist name"]')!;
      input.value = "New name";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      target
        .querySelector<HTMLFormElement>("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() =>
        expect(apply).toHaveBeenCalledWith({
          kind: "rename",
          id: "p/1",
          name: "New name",
          expected: ["lost", "a", "a"],
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("offers reload or explicit overwrite when remote ordering conflicts", async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new PlaylistConflictError())
      .mockResolvedValue(detail);
    const open = vi.fn(async () => detail);
    const { target, cleanup } = render(PlaylistRoute, {
      params: { playlistId: "p/1" },
      cache: cache(),
      covers,
      playlists: { open, apply },
      session: { localReady: true, offlineMode: false, auth: { username: "user" } },
      trackEngine: { getStatus: () => "downloaded" },
      playback: {},
    });
    try {
      target
        .querySelector<HTMLButtonElement>('[aria-label="Move Known up from position 2"]')!
        .click();
      await vi.waitFor(() => expect(target.textContent).toContain("Overwrite remote changes"));
      const overwrite = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Overwrite remote changes"),
      )!;
      overwrite.click();
      await vi.waitFor(() =>
        expect(apply).toHaveBeenLastCalledWith({
          kind: "replace",
          id: "p/1",
          expected: ["lost", "a", "a"],
          ids: ["a", "lost", "a"],
          overwrite: true,
        }),
      );
    } finally {
      await cleanup();
    }
  });

  it("shows missing occurrences and dispatches an ordered replacement without dropping IDs", async () => {
    const apply = vi.fn(async () => detail);
    const { target, cleanup } = render(PlaylistRoute, {
      params: { playlistId: "p/1" },
      cache: cache(),
      covers,
      playlists: { open: vi.fn(async () => detail), apply },
      session: { localReady: true, offlineMode: false, auth: { username: "user" } },
      trackEngine: { getStatus: () => "downloaded" },
      playback: {},
    });
    try {
      expect(target.textContent).toContain("Unavailable");
      expect(target.querySelectorAll('[aria-label^="Remove Known"]')).toHaveLength(2);
      target
        .querySelector<HTMLButtonElement>('[aria-label="Move Known up from position 2"]')!
        .click();
      await vi.waitFor(() =>
        expect(apply).toHaveBeenCalledWith({
          kind: "replace",
          id: "p/1",
          expected: ["lost", "a", "a"],
          ids: ["a", "lost", "a"],
        }),
      );
    } finally {
      await cleanup();
    }
  });
});

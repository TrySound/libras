// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import fuzzysort from "fuzzysort";
import { expect, it, vi } from "vitest";
import Harness from "./search-test-app.svelte";
import type Search from "../src/_search.svelte";
import type { ComponentProps } from "svelte";

it("focuses the input, expands results, retains route state, and uses album playback", async () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    title: "Song",
    albumId: "album",
    artistIds: ["artist"],
    genres: [],
  }));
  const match = vi.spyOn(fuzzysort, "go");
  const playback = { replaceQueueAndPlay: vi.fn(), enqueue: vi.fn() };
  const cover = { load: vi.fn(), source: undefined };
  const downloadMany = vi.fn();
  const props = {
    cache: {
      savedAt: 1,
      queue: { tracks: ["0"], index: 0 },
      artists: new Map([["artist", { id: "artist", name: "Artist" }]]),
      albums: new Map([
        ["album", { id: "album", title: "Album", artistIds: ["artist"], genres: [] }],
      ]),
      tracks: new Map(tracks.map((t) => [t.id, t])),
      albumTracks: new Map([["album", tracks]]),
      artistAlbums: new Map([["artist", [{ id: "album" }]]]),
    },
    session: { localReady: true, offlineMode: false, refreshError: "Synchronization failed." },
    playbackState: "playing",
    trackEngine: { getStatus: () => "downloaded", downloadMany },
    covers: {
      ensureCover: () => cover,
    },
    playback,
  } as unknown as Omit<ComponentProps<typeof Search>, "state">;
  const target = document.createElement("div");
  document.body.append(target);
  const app = mount(Harness, { target, props: { props } });
  flushSync();
  const button = (label: string) =>
    [...target.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label,
    )!;
  try {
    let input = target.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(target.textContent).toContain("Type to find music");
    expect(target.textContent).toContain("Synchronization failed.");
    input.value = "Song";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(3);
    expect(target.querySelectorAll("section .track-row")).toHaveLength(3);
    expect(target.querySelector("search label")?.getAttribute("for")).toBe(input.id);
    expect(
      target.querySelector('.track-row[aria-current="true"] [aria-label="Playing"]'),
    ).not.toBeNull();
    expect(target.querySelectorAll("dialog")).toHaveLength(1);
    match.mockClear();
    button("Show more tracks").click();
    flushSync();
    expect(match).not.toHaveBeenCalled();
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(12);
    button("Play Song").click();
    expect(playback.replaceQueueAndPlay).toHaveBeenCalledWith(
      tracks.map((t) => t.id),
      0,
    );
    const menuButton = button("Open menu for Song");
    const desktopMenu = target.querySelector<HTMLButtonElement>(
      '.only-desktop[aria-label="Open menu for Song"]',
    )!;
    expect(desktopMenu.getAttribute("commandfor")).toBe("search-menu-popover");
    expect(desktopMenu.getAttribute("command")).toBe("toggle-popover");
    expect(menuButton.getAttribute("commandfor")).toBe("search-menu");
    expect(menuButton.getAttribute("command")).toBe("show-modal");
    menuButton.click();
    flushSync();
    expect(target.querySelector("#search-menu-title")?.textContent).toBe("Song");
    expect(button("Downloaded").disabled).toBe(true);
    button("Play next").click();
    expect(playback.enqueue).toHaveBeenLastCalledWith(["0"], "next");
    button("Play last").click();
    expect(playback.enqueue).toHaveBeenLastCalledWith(["0"], "last");
    // Long press focuses its invoker before opening the same shared dialog.
    const trackRows = target.querySelectorAll<HTMLButtonElement>('[aria-label="Play Song"]');
    expect(trackRows[1].getAttribute("data-longpressfor")).toBe("search-menu");
    trackRows[1].focus();
    flushSync();
    button("Play").click();
    expect(playback.replaceQueueAndPlay).toHaveBeenLastCalledWith(
      tracks.map((t) => t.id),
      1,
    );
    button("Play next").click();
    expect(playback.enqueue).toHaveBeenLastCalledWith(["1"], "next");

    input.value = "Artist";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(3);
    for (const name of ["Artist", "Album"]) {
      button(`Open menu for ${name}`).click();
      flushSync();
      expect(target.querySelector("#search-menu-title")?.textContent).toBe(name);
      expect(target.querySelectorAll("dialog")).toHaveLength(1);
      expect(
        target.querySelectorAll(
          `section[aria-label="${name === "Artist" ? "Artists" : "Albums"}"] .track-row-number`,
        ),
      ).toHaveLength(0);
      expect(target.querySelector(`a[aria-label="${name}"]`)?.getAttribute("href")).toContain(
        "#/library/artist/artist",
      );
      button("Play").click();
      expect(playback.replaceQueueAndPlay).toHaveBeenLastCalledWith(tracks.map((t) => t.id));
      button("Play next").click();
      expect(playback.enqueue).toHaveBeenLastCalledWith(
        tracks.map((t) => t.id),
        "next",
      );
      button("Download").click();
      expect(downloadMany).toHaveBeenCalledOnce();
      expect(downloadMany).toHaveBeenCalledWith(tracks.map((track) => track.id));
      downloadMany.mockClear();
    }
    input.value = "Song";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(3);
    button("Show more tracks").click();
    flushSync();
    button("Toggle route").click();
    flushSync();
    button("Toggle route").click();
    flushSync();
    input = target.querySelector("input")!;
    expect(input.value).toBe("Song");
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(12);
    // Native search cancellation emits an input event with an empty value.
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(input.value).toBe("");
    expect(target.textContent).toContain("Type to find music");
    expect(document.activeElement).toBe(input);
    input.value = "Song";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(3);
    input.value = "zzzzzzzzzz";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.textContent).toContain("No matches found.");
    expect(target.querySelectorAll(".track-row")).toHaveLength(0);
  } finally {
    match.mockRestore();
    await unmount(app);
    target.remove();
  }
});

it.each([
  { localReady: false, savedAt: undefined, offlineMode: false, heading: undefined },
  { localReady: true, savedAt: undefined, offlineMode: false, heading: "Connect your library" },
  { localReady: true, savedAt: 1, offlineMode: false, heading: "Your library is empty." },
  { localReady: true, savedAt: 1, offlineMode: true, heading: "No downloaded music to search." },
])(
  "represents library availability: $heading",
  async ({ localReady, savedAt, offlineMode, heading }) => {
    const target = document.createElement("div");
    document.body.append(target);
    const props = {
      cache: {
        savedAt,
        queue: { tracks: [], index: 0 },
        artists: new Map(),
        albums: new Map(),
        tracks: new Map(),
        artistAlbums: new Map(),
        albumTracks: new Map(),
      },
      session: { localReady, offlineMode },
      trackEngine: { getStatus: () => "idle" },
      covers: {},
      playback: {},
    } as unknown as Omit<ComponentProps<typeof Search>, "state">;
    const app = mount(Harness, { target, props: { props } });
    flushSync();
    try {
      expect(target.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe(
        String(!localReady),
      );
      expect(target.querySelector("section h2")?.textContent?.trim()).toBe(heading);
      if (heading)
        expect(target.querySelector("section a")?.getAttribute("href")).toBe(
          savedAt === undefined ? "#/settings" : "#/library",
        );
    } finally {
      await unmount(app);
      target.remove();
    }
  },
);

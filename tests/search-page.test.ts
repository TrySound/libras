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
    artistId: "artist",
    genres: [],
  }));
  const match = vi.spyOn(fuzzysort, "go");
  const playback = { replaceQueueAndPlay: vi.fn(), enqueue: vi.fn() };
  const cover = { load: vi.fn(), source: undefined };
  const download = vi.fn();
  const props = {
    cache: {
      artists: new Map([["artist", { id: "artist", name: "Artist", genres: [] }]]),
      albums: new Map([["album", { id: "album", title: "Album", artistId: "artist", genres: [] }]]),
      tracks: new Map(tracks.map((t) => [t.id, t])),
      albumTracks: new Map([["album", tracks]]),
      artistAlbums: new Map([["artist", [{ id: "album" }]]]),
    },
    session: { localReady: true, offlineMode: false },
    trackEngine: { getStatus: () => "downloaded", download },
    coverEngine: {
      ensureArtistCover: () => cover,
      ensureAlbumCover: () => cover,
      ensureTrackCover: () => cover,
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
    input.value = "Song";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll('[aria-label="Play Song"]')).toHaveLength(3);
    expect(target.querySelectorAll("section .wings > .wings-item")).toHaveLength(3);
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
    for (const name of ["Artist", "Album"]) {
      button(`Open menu for ${name}`).click();
      flushSync();
      expect(target.querySelector("#search-menu-title")?.textContent).toBe(name);
      expect(target.querySelectorAll("dialog")).toHaveLength(1);
      button("Play").click();
      expect(playback.replaceQueueAndPlay).toHaveBeenLastCalledWith(tracks.map((t) => t.id));
      button("Play next").click();
      expect(playback.enqueue).toHaveBeenLastCalledWith(
        tracks.map((t) => t.id),
        "next",
      );
      button("Download").click();
      expect(download).toHaveBeenCalledTimes(12);
      download.mockClear();
    }
    input.value = "Song";
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  } finally {
    match.mockRestore();
    await unmount(app);
    target.remove();
  }
});

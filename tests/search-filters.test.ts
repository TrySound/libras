// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Search from "../src/_search.svelte";
import Harness from "./search-test-app.svelte";
import type { ComponentProps } from "svelte";

afterEach(() => vi.unstubAllGlobals());

function fixture(count = 120) {
  const artists = Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    name: `Fixture artist ${i}`,
  }));
  const albums = artists.map((a, i) => ({
    id: `b${i}`,
    title: `Fixture album ${i}`,
    artistIds: [a.id],
    genres: [],
  }));
  const tracks = albums.map((a, i) => ({
    id: `t${i}`,
    title: `Fixture track ${i}`,
    albumId: a.id,
    artistIds: a.artistIds,
    genres: [],
  }));
  return {
    cache: {
      savedAt: 1,
      queue: { tracks: [], index: 0 },
      artists: new Map(artists.map((a) => [a.id, a])),
      albums: new Map(albums.map((a) => [a.id, a])),
      tracks: new Map(tracks.map((a) => [a.id, a])),
      artistAlbums: new Map(artists.map((a, i) => [a.id, [albums[i]]])),
      albumTracks: new Map(albums.map((a, i) => [a.id, [tracks[i]]])),
    },
    session: { localReady: true, offlineMode: false },
    covers: {},
    trackEngine: { getStatus: () => "downloaded", isDownloaded: () => true },
    playback: { toggleTrack: vi.fn(), replaceQueueAndPlay: vi.fn(), enqueue: vi.fn() },
  } as unknown as ComponentProps<typeof Search>;
}

describe("independent search filters", () => {
  it("appends batches, retains rows across hash changes and resets on new criteria", async () => {
    let callback: IntersectionObserverCallback;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const target = document.createElement("main");
    document.body.append(target);
    const app = mount(Harness, { target, props: { props: fixture(120) } });
    flushSync();
    try {
      target.querySelectorAll<HTMLButtonElement>("[aria-pressed]")[2].click();
      flushSync();
      const first = target.querySelector(".track-row");
      expect(target.querySelectorAll(".track-row")).toHaveLength(48);
      for (const size of [96, 120]) {
        const sentinel = target.querySelector(".library-sentinel")!;
        callback!(
          [{ target: sentinel, isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        flushSync();
        expect(target.querySelectorAll(".track-row")).toHaveLength(size);
        expect(target.querySelector(".track-row")).toBe(first);
      }
      expect(target.querySelector(".library-sentinel")).toBeNull();
      expect(target.textContent).toContain("119");
      window.navigation.navigate("?/search&type=track#anchor", { history: "push" });
      flushSync();
      expect(target.querySelectorAll(".track-row")).toHaveLength(120);
      const input = target.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = "Fixture";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(target.querySelectorAll(".track-row")).toHaveLength(48);
    } finally {
      await unmount(app);
      target.remove();
    }
  });
  it("filters offline browse eligibility before counting and retains album playback context", async () => {
    const props = fixture(3);
    const offlineProps = {
      ...props,
      session: { localReady: true, offlineMode: true, downloadedOnly: true },
      trackEngine: {
        getStatus: (id: string) => (id === "t2" ? "downloaded" : "idle"),
        isDownloaded: (id: string) => id === "t2",
      },
    } as unknown as ComponentProps<typeof Search>;
    const target = document.createElement("main");
    document.body.append(target);
    const app = mount(Harness, { target, props: { props: offlineProps } });
    flushSync();
    try {
      const trackChip = target.querySelectorAll<HTMLButtonElement>("[aria-pressed]")[2];
      trackChip.click();
      flushSync();
      expect(target.querySelectorAll(".track-row")).toHaveLength(1);
      expect(target.querySelector('section[aria-label="Tracks"] header')?.textContent).toContain(
        "1",
      );
      const play = target.querySelector<HTMLButtonElement>(".track-row button.link-target")!;
      expect(play.getAttribute("aria-label")).toBe("Play Fixture track 2");
      play.click();
      expect(props.playback.toggleTrack).toHaveBeenCalledWith("t2", ["t2"]);
      const input = target.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = "Fixture track 0";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(target.textContent).toContain("No matches found.");
      expect(target.querySelectorAll("[aria-pressed]")).toHaveLength(3);
    } finally {
      await unmount(app);
      target.remove();
    }
  });
  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    "supports combination %s, previews and single-type batches",
    async (mask) => {
      const props = fixture();
      const target = document.createElement("main");
      document.body.append(target);
      const app = mount(Harness, { target, props: { props } });
      flushSync();
      const chips = [...target.querySelectorAll<HTMLButtonElement>("[aria-pressed]")];
      try {
        chips.forEach((chip, i) => {
          if (mask & (1 << i)) {
            chip.click();
            flushSync();
          }
        });
        flushSync();
        expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual(
          chips.map((_, i) => String(!!(mask & (1 << i)))),
        );
        const selected = chips.filter((_, i) => mask & (1 << i)).length;
        if (selected === 1) {
          expect(target.querySelectorAll(".track-row")).toHaveLength(48);
          expect(target.querySelector(".library-sentinel")).not.toBeNull();
          expect(target.querySelector("section[aria-label] header")?.textContent).toContain("120");
          expect(target.textContent).not.toContain("Show more");
        } else expect(target.textContent).toContain("Type to find music");
        const input = target.querySelector<HTMLInputElement>('input[type="search"]')!;
        input.value = "Fixture";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(target.querySelectorAll("section[aria-label]").length).toBe(selected || 3);
        expect(target.querySelectorAll(".library-sentinel").length).toBe(selected === 1 ? 1 : 0);
        if (selected === 1) expect(target.querySelectorAll(".track-row")).toHaveLength(48);
        if (selected !== 1)
          expect(target.querySelectorAll(".track-row").length).toBe((selected || 3) * 3);
        chips.forEach((chip) => {
          if (chip.getAttribute("aria-pressed") === "true") {
            chip.click();
            flushSync();
          }
        });
        flushSync();
        expect(chips.every((chip) => chip.getAttribute("aria-pressed") === "false")).toBe(true);
        expect(target.querySelectorAll(".track-row")).toHaveLength(9);
      } finally {
        await unmount(app);
        target.remove();
      }
    },
  );
});

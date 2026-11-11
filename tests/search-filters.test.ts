// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import Search, { createSearchState } from "../src/_search.svelte";
import Harness from "./search-test-app.svelte";
import type { ComponentProps } from "svelte";

function fixture() {
  const artists = Array.from({ length: 1500 }, (_, i) => ({
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
    trackEngine: { getStatus: () => "downloaded" },
    playback: { toggleTrack: vi.fn(), replaceQueueAndPlay: vi.fn(), enqueue: vi.fn() },
    state: createSearchState(),
  } as unknown as ComponentProps<typeof Search>;
}

describe("independent search filters", () => {
  it("filters offline browse eligibility before counting and retains album playback context", async () => {
    const props = fixture();
    const offlineProps = {
      ...props,
      session: { localReady: true, offlineMode: true },
      trackEngine: { getStatus: (id: string) => (id === "t1499" ? "downloaded" : "idle") },
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
      expect(target.querySelector("li[aria-setsize]")?.getAttribute("aria-setsize")).toBe("1");
      const play = target.querySelector<HTMLButtonElement>(".track-row button.link-target")!;
      expect(play.getAttribute("aria-label")).toBe("Play Fixture track 1499");
      play.click();
      expect(props.playback.toggleTrack).toHaveBeenCalledWith("t1499", ["t1499"]);
      const input = target.querySelector("input")!;
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
    "supports combination %s, previews and full bounded browse",
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
          expect(target.querySelector(".virtual-list")).not.toBeNull();
          expect(target.querySelectorAll(".track-row").length).toBeLessThan(30);
          expect(target.querySelector("li[aria-setsize]")?.getAttribute("aria-setsize")).toBe(
            "1500",
          );
          expect(target.textContent).not.toContain("Show more");
        } else expect(target.textContent).toContain("Type to find music");
        const input = target.querySelector("input")!;
        input.value = "Fixture";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(target.querySelectorAll("section[aria-label]").length).toBe(selected || 3);
        expect(target.querySelectorAll(".virtual-list").length).toBe(selected === 1 ? 1 : 0);
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

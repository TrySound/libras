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
    trackEngine: { getStatus: () => "downloaded" },
    playback: { toggleTrack: vi.fn(), replaceQueueAndPlay: vi.fn(), enqueue: vi.fn() },
  } as unknown as ComponentProps<typeof Search>;
}

describe("independent search filters", () => {
  it("preserves a retained group's section and first row when restricting types", async () => {
    const target = document.createElement("main");
    document.body.append(target);
    const app = mount(Harness, { target, props: { props: fixture(3) } });
    flushSync();
    try {
      const input = target.querySelector("input")!;
      input.value = "Fixture";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(target.querySelectorAll("section[aria-label]")).toHaveLength(3);
      const section = target.querySelector('section[aria-label="Tracks"]')!;
      const firstRow = section.querySelector(".track-row");
      expect(firstRow).not.toBeNull();
      target.querySelectorAll<HTMLButtonElement>("[aria-pressed]")[2].click();
      flushSync();
      expect(target.querySelectorAll("section[aria-label]")).toHaveLength(1);
      expect(target.querySelector('section[aria-label="Tracks"]')).toBe(section);
      expect(section.querySelector(".track-row")).toBe(firstRow);
    } finally {
      await unmount(app);
      target.remove();
    }
  });
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
      const input = target.querySelector("input")!;
      input.value = "Fixture";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      const section = target.querySelector('section[aria-label="Tracks"]')!;
      const first = section.querySelector(".track-row")!;
      const firstBatch = first.parentElement!;
      target.querySelector<HTMLButtonElement>('[aria-label="Show more tracks"]')!.click();
      flushSync();
      expect(section.querySelector(".track-row")).toBe(first);
      expect(first.parentElement).toBe(firstBatch);
      target.querySelectorAll<HTMLButtonElement>("[aria-pressed]")[2].click();
      flushSync();
      const container = firstBatch.parentElement!;
      let previous = [...container.children];
      for (const [size, rowCounts] of [
        [48, [40, 8]],
        [96, [40, 40, 16]],
        [120, [40, 40, 40]],
      ] as const) {
        if (size > 48) {
          const sentinel = target.querySelector(".library-sentinel")!;
          callback!(
            [{ target: sentinel, isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
          flushSync();
        }
        expect(target.querySelectorAll(".track-row")).toHaveLength(size);
        expect(section.querySelector(".track-row")).toBe(first);
        expect(first.parentElement).toBe(firstBatch);
        const wrappers = [...container.children] as HTMLElement[];
        expect(wrappers.map((batch) => batch.childElementCount)).toEqual(rowCounts);
        wrappers.forEach((batch, index) => {
          expect(batch.style.getPropertyValue("--track-group-rows")).toBe(
            String(batch.childElementCount),
          );
          expect(batch.classList.contains("track-group")).toBe(index > 0);
        });
        previous.forEach((batch, index) => expect(wrappers[index]).toBe(batch));
        previous = wrappers;
      }
      expect(target.querySelector(".library-sentinel")).toBeNull();
      expect(target.textContent).toContain("119");
      window.navigation.navigate("?/search&type=track&q=Fixture#anchor", { history: "push" });
      flushSync();
      expect(target.querySelectorAll(".track-row")).toHaveLength(120);
      input.value = "Fixture track";
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
      session: { localReady: true, offlineMode: true },
      trackEngine: { getStatus: (id: string) => (id === "t2" ? "downloaded" : "idle") },
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
        const input = target.querySelector("input")!;
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

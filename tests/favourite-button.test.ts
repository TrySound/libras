// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { expect, it, vi } from "vitest";
import FavouriteButton from "../src/ui/favourite-button.svelte";
import type { Favourites } from "../src/favourites.svelte";

it.each([false, true])(
  "keeps the heart and label stable while pending (icon: %s)",
  async (icon) => {
    let reject!: (error: Error) => void;
    const toggle = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const state = new SvelteMap<string, unknown>([["id", "A"]]);
    const engine = {
      available: true,
      outcomeUnknown: false,
      pending: new SvelteSet<string>(),
      key: (target: { id: string }) => target.id,
      has: () => state.get("selected") === true,
      targetError: () => "",
      toggle,
    } as unknown as Favourites;
    const target = document.createElement("div");
    document.body.append(target);
    const input = document.createElement("input");
    target.append(input);
    const app = mount(FavouriteButton, {
      target,
      props: {
        favourites: engine,
        get target() {
          const id = state.get("id") as string | undefined;
          return id === undefined ? undefined : { kind: "tracks" as const, id };
        },
        icon,
      },
    });
    flushSync();
    try {
      const button = target.querySelector("button")!;
      const heart = button.querySelector("svg");
      expect(heart!.querySelector("use")!.getAttribute("href")).toBe("#icon-favourite");
      button.click();
      expect(toggle).toHaveBeenCalledWith({ kind: "tracks", id: "A" });
      input.focus();
      reject(new Error("Permission denied"));
      await Promise.resolve();
      flushSync();
      expect(target.textContent).not.toContain("Permission denied");
      expect(document.activeElement).toBe(input);
      expect(target.querySelector(".favourite-feedback")).toBeNull();
      engine.pending.add("A");
      flushSync();
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.querySelector("svg")).toBe(heart);
      expect(button.querySelector(".loader")).toBeNull();
      expect(target.textContent?.trim()).toBe(icon ? "" : "Add to favourites");
      button.click();
      expect(toggle).toHaveBeenCalledTimes(1);
      state.set("id", "B");
      flushSync();
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).toBe("false");
      engine.pending.delete("A");
      state.set("id", "A");
      flushSync();
      button.click();
      reject(new DOMException("Retired", "AbortError"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
      expect(target.textContent).not.toContain("Retired");
      state.set("selected", true);
      engine.pending.add("A");
      flushSync();
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.querySelector("svg")!.classList.contains("favourite-icon")).toBe(true);
      expect(button.querySelector(".loader")).toBeNull();
      expect(target.textContent?.trim()).toBe(icon ? "" : "Remove from favourites");
      if (icon) expect(button.getAttribute("data-variant")).toBe("secondary");
      state.delete("id");
      flushSync();
      expect(button.disabled).toBe(true);
    } finally {
      await unmount(app);
      target.remove();
    }
  },
);

it("explains unavailable actions without adding visible feedback or settings links", async () => {
  const engine = {
    available: false,
    pending: new SvelteSet(),
    key: () => "A",
    has: () => false,
  } as unknown as Favourites;
  const target = document.createElement("div");
  document.body.append(target);
  const app = mount(FavouriteButton, {
    target,
    props: { favourites: engine, target: { kind: "tracks", id: "A" }, icon: true },
  });
  flushSync();
  try {
    const button = target.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Reconnect in Settings");
    const description = target.querySelector(".visually-hidden")!;
    expect(button.getAttribute("aria-describedby")).toBe(description.id);
    expect(target.querySelector("a")).toBeNull();
    expect(target.querySelector(".favourite-feedback")).toBeNull();
  } finally {
    await unmount(app);
    target.remove();
  }
});

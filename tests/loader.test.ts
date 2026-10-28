// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";
import Loader from "../src/ui/loader.svelte";

it.each([undefined, "md", "lg", "xl"] as const)(
  "supports loader size=%s without changing its decoration",
  async (size) => {
    const target = document.createElement("div");
    const component = mount(Loader, { target, props: { size } });
    flushSync();
    try {
      const loader = target.querySelector<HTMLElement>(".loader")!;
      expect(loader.getAttribute("data-size")).toBe(size ?? "md");
      expect(loader.getAttribute("aria-hidden")).toBe("true");
      expect(loader.querySelectorAll(".loader-bar")).toHaveLength(5);
    } finally {
      await unmount(component);
    }
  },
);

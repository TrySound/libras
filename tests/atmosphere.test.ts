// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";
import Atmosphere from "../src/ui/atmosphere.svelte";

it("keeps decorative filters local to each atmosphere instance", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const visible = mount(Atmosphere, { target, props: { src: "blob:cover" } });
  const empty = mount(Atmosphere, { target, props: {} });
  flushSync();
  try {
    const filters = [...target.querySelectorAll("filter")];
    const images = [...target.querySelectorAll<HTMLImageElement>(".atmosphere")];
    const frames = [...target.querySelectorAll<HTMLElement>(".atmosphere-frame")];
    expect(filters).toHaveLength(2);
    expect(filters[0].id).not.toBe(filters[1].id);
    for (const [index, image] of images.entries()) {
      expect(image.style.getPropertyValue("--atmosphere-filter")).toBe(
        `url("#${filters[index].id}")`,
      );
      expect(image.alt).toBe("");
      expect(image.getAttribute("aria-hidden")).toBe("true");
      expect(filters[index].querySelector("feTurbulence")?.getAttribute("baseFrequency")).toBe(
        "0.01 0.4",
      );
      expect(filters[index].querySelector("feDisplacementMap")?.getAttribute("scale")).toBe("35");
    }
    expect(images[0].getAttribute("src")).toBe("blob:cover");
    expect(images[0].hidden).toBe(false);
    expect(images[1].hidden).toBe(true);
    expect(frames[0].contains(images[0])).toBe(true);
    expect(frames[0].hidden).toBe(false);
    expect(frames[1].hidden).toBe(false);
    expect(target.querySelectorAll(".atmosphere-lines")).toHaveLength(2);
    for (const frame of frames) {
      expect([...frame.children].map((layer) => layer.className)).toEqual([
        "atmosphere",
        "atmosphere-lines",
      ]);
    }
    expect(frames.every((frame) => frame.getAttribute("aria-hidden") === "true")).toBe(true);
  } finally {
    await unmount(visible);
    await unmount(empty);
    target.remove();
  }
});

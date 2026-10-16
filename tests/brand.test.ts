// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const paths = ["M16 5v24M12 29h8M8 12l16-4", "M4 23l4-11 4 11ZM20 19l4-11 4 11Z"];

it("uses the custom outlined brand without changing the shared icon API", () => {
  const document = new DOMParser().parseFromString(
    readFileSync("src/sprite.svg", "utf8"),
    "image/svg+xml",
  );
  const brand = document.getElementById("icon-brand")!;
  expect(brand.getAttribute("viewBox")).toBe("0 0 32 32");
  expect(brand.getAttribute("fill")).toBe("none");
  expect(brand.getAttribute("stroke")).toBe("currentColor");
  expect(brand.getAttribute("stroke-width")).toBe("1.6");
  expect(brand.getAttribute("stroke-linecap")).toBe("round");
  expect(brand.getAttribute("stroke-linejoin")).toBe("round");
  expect([...brand.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(paths);
  expect(brand.querySelector("circle")).toBeNull();
  expect(brand.querySelector("g")?.getAttribute("transform")).toBe("translate(0 -1)");
});

it.each(["public/icon.svg", "public/logo.svg", "public/og.svg", "website/public/icon.svg"])(
  "keeps %s synchronized with the brand geometry",
  (file) => {
    const document = new DOMParser().parseFromString(readFileSync(file, "utf8"), "image/svg+xml");
    expect([...document.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
      paths,
    );
    const mark = document.querySelector('g[stroke="#ffde21"]')!;
    expect(mark.getAttribute("fill")).toBe("none");
    expect(mark.getAttribute("stroke-width")).toBe("1.6");
    expect(mark.getAttribute("transform")).toMatch(/translate\(0 -1\)$/);
    expect(document.querySelector('[fill="url(#brand-background)"]')).not.toBeNull();
    expect(
      [...document.querySelectorAll("#brand-background stop")].map((stop) =>
        stop.getAttribute("stop-color"),
      ),
    ).toEqual(["#810000", "#550000"]);
  },
);

it("styles every website brand explicitly with the shared class", () => {
  const template = document.createElement("template");
  template.innerHTML = readFileSync("website/index.html", "utf8");
  const marks = [...template.content.querySelectorAll('use[href="#icon-brand"]')];
  expect(marks).toHaveLength(6);
  for (const mark of marks)
    expect(mark.closest("svg")?.classList.contains("brand-mark")).toBe(true);
  const css = readFileSync("src/app.css", "utf8");
  expect(css).toContain(".brand-mark {");
  expect(css).not.toContain('use[href="#icon-brand"]');
});

it.each([
  ["public/icons/icon-192.png", 192, 192],
  ["public/icons/icon-512.png", 512, 512],
  ["public/icons/icon-maskable-512.png", 512, 512],
  ["public/apple-touch-icon.png", 180, 180],
  ["public/og.png", 1200, 630],
] as const)("preserves the dimensions of %s", (file, width, height) => {
  const png = readFileSync(file);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBe(width);
  expect(png.readUInt32BE(20)).toBe(height);
});

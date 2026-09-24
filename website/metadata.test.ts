// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

it.each([
  ["./index.html", "https://libras-music.app/"],
  ["../index.html", "https://libras-music.app/webapp/"],
])("declares current SEO and social metadata in %s", (file, url) => {
  const html = read(file);
  const page = new DOMParser().parseFromString(html, "text/html");
  const meta = (key: string) =>
    page.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content");

  expect(page.title).toContain("Libras");
  expect(meta("description")).toBeTruthy();
  expect(page.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(url);
  expect(meta("og:url")).toBe(url);
  expect(meta("og:type")).toBe("website");
  expect(meta("og:site_name")).toBe("Libras");
  expect(meta("og:title")).toBe(page.title);
  expect(meta("og:description")).toBeTruthy();
  expect(meta("og:image")).toBe("https://libras-music.app/webapp/og.png");
  expect(meta("og:image:type")).toBe("image/png");
  expect(meta("og:image:width")).toBe("1200");
  expect(meta("og:image:height")).toBe("630");
  expect(meta("og:image:alt")).toBeTruthy();
  expect(meta("twitter:card")).toBe("summary_large_image");
  for (const key of ["title", "description", "image", "image:alt"]) {
    expect(meta(`twitter:${key}`)).toBe(meta(`og:${key}`));
  }
  expect(html).not.toContain("trysound.github.io");
});

it("publishes a sitemap for both entry points and advertises it to crawlers", () => {
  const sitemap = read("./public/sitemap.xml");
  const xml = new DOMParser().parseFromString(sitemap, "application/xml");
  expect([...xml.querySelectorAll("loc")].map((node) => node.textContent)).toEqual([
    "https://libras-music.app/",
    "https://libras-music.app/webapp/",
  ]);
  const robots = read("./public/robots.txt");
  expect(robots).toContain("Sitemap: https://libras-music.app/sitemap.xml");
});

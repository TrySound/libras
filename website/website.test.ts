// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function landingPage() {
  const html = readFileSync("website/index.html", "utf8").replaceAll("%BASE_URL%", "/");
  return new DOMParser().parseFromString(html, "text/html");
}

it("serves landing content and destinations without executing JavaScript", () => {
  const page = landingPage();
  const links = [...page.querySelectorAll("a")];
  const link = (name: string) => links.find((element) => element.textContent?.trim() === name);

  expect(page.querySelectorAll("h1")).toHaveLength(1);
  expect(page.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "Connect your music library and listen anywhere.",
  );
  expect(page.querySelector("script")).toBeNull();
  expect(page.querySelector('link[rel="stylesheet"]')).not.toBeNull();
  expect(link("Try live demo")?.getAttribute("href")).toBe("/demo/");
  expect(link("Connect your server")?.getAttribute("href")).toBe("/webapp/");
  expect(link("View on GitHub")?.getAttribute("href")).toBe("https://github.com/TrySound/libras");
  for (const button of page.querySelectorAll("a.button")) {
    expect(button.getAttribute("target")).toBe("_blank");
    expect(button.getAttribute("rel")).toBe("noopener");
  }
  expect(page.querySelector("footer")).toBeNull();
  expect(page.querySelector(".site-feature-step")).toBeNull();
  expect(page.querySelector(".site-hero-description")?.textContent).toContain("Navidrome server");
  expect(page.body.textContent).not.toContain("OpenSubsonic");
  expect(page.querySelectorAll(".site-feature-copy .site-subtitle")).toHaveLength(3);

  for (const anchor of page.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(page.getElementById(anchor.hash.slice(1))).not.toBeNull();
  }
});

it("removes the FAQ and keeps server descriptions in regular text color", () => {
  const page = landingPage();
  expect(page.querySelector(".site-faq")).toBeNull();
  expect(page.querySelector("details")).toBeNull();
  expect(page.querySelectorAll(".site-servers .site-subtitle")).toHaveLength(2);
  expect(page.querySelector(".site-servers p.text-subtle")).toBeNull();
  expect(page.querySelectorAll("h2.text-subtle")).toHaveLength(5);
  expect(page.querySelector(".site-subtitle.text-subtle")).toBeNull();
  expect(page.body.textContent).toContain("Clearing site data deletes");
});

it("shows a desktop preview, progressively narrower feature screenshots, and a final open-source CTA", () => {
  const page = landingPage();
  const preview = page.querySelector<HTMLImageElement>(".site-preview img")!;
  expect(preview.getAttribute("src")).toBe("/screenshots/hero.webp");
  expect(preview.getAttribute("loading")).not.toBe("lazy");
  const images = [...page.querySelectorAll<HTMLImageElement>(".site-feature img")];
  expect(images.every((image) => image.getAttribute("src") !== preview.getAttribute("src"))).toBe(
    true,
  );
  expect(images.map((image) => Number(image.getAttribute("width")))).toEqual([1440, 1000, 390]);
  for (const image of [preview, ...images]) {
    expect(image.getAttribute("alt")).toBeTruthy();
    expect(image.getAttribute("height")).toBeTruthy();
    expect(readFileSync(`website/public${image.getAttribute("src")}`)).not.toHaveLength(0);
  }
  const sections = [...page.querySelectorAll("main section")];
  expect(sections.at(-1)?.querySelector("h2")?.textContent).toContain("Free and open source");
  expect(sections.at(-1)?.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/TrySound/libras",
  );
});

it("focuses features on the interface, browser access, and downloaded-only offline content", () => {
  const page = landingPage();
  expect(page.getElementById("features-title")).toBeNull();
  expect(page.querySelectorAll(".site-feature h2")).toHaveLength(3);
  expect(page.querySelector(".site-features h3")).toBeNull();
  const descriptions = [...page.querySelectorAll(".site-feature-copy .site-subtitle")];
  expect(descriptions[0].textContent).toContain("video game interfaces");
  expect(descriptions[1].textContent).toContain("computer, tablet, or phone");
  expect(descriptions[2].textContent?.replace(/\s+/g, " ")).toContain(
    "only the music saved on this device",
  );
  expect(page.querySelector(".site-preview img")?.getAttribute("alt")).toContain("3 Libras");
  expect(page.querySelector(".site-feature img")?.getAttribute("alt")).toContain("Bullets");
});

it("places branding and new-tab navigation in the top bar instead of the hero", () => {
  const page = landingPage();
  expect(page.querySelector("header .brand")?.textContent).toContain("Libras");
  expect(page.querySelector(".site-hero .brand")).toBeNull();
  expect(page.querySelectorAll('header nav a.button[data-size="text"]')).toHaveLength(2);
  expect(page.querySelectorAll('main .button[data-size="large-text"]')).toHaveLength(4);
  expect(page.querySelector("header nav a[data-variant='primary']")?.textContent?.trim()).toBe(
    "Log in",
  );
  const links = [...page.querySelectorAll("header a")];
  expect(links.map((link) => link.textContent?.trim())).toEqual(["Libras", "GitHub", "Log in"]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/",
    "https://github.com/TrySound/libras",
    "/webapp/",
  ]);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
  }
});

it("describes server compatibility between the features and open-source section", () => {
  const page = landingPage();
  const servers = page.querySelector(".site-servers")!;
  expect(servers.querySelector("h2")?.id).toBe("servers-title");
  expect(servers.textContent).toContain("Navidrome");
  expect(servers.textContent).toContain("Subsonic-compatible");
  expect(servers.textContent).toContain("HTTPS");
  expect(servers.textContent).toContain("CORS");
  expect(page.getElementById("features")!.compareDocumentPosition(servers) & 4).toBeTruthy();
  expect(servers.compareDocumentPosition(page.querySelector(".site-final-cta")!) & 4).toBeTruthy();
  expect(servers.querySelector("a.button")?.getAttribute("href")).toBe(
    "https://github.com/TrySound/libras#get-started",
  );
});

it("references existing sprite symbols", () => {
  const sprite = new DOMParser().parseFromString(
    readFileSync("src/sprite.svg", "utf8"),
    "image/svg+xml",
  );
  for (const icon of landingPage().querySelectorAll("svg use")) {
    expect(sprite.getElementById(icon.getAttribute("href")!.slice(1))).not.toBeNull();
  }
});

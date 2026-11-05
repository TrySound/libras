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
  for (const anchor of links) {
    const opensAppOrWebsite =
      anchor.getAttribute("href") !== "/" && !anchor.getAttribute("href")?.startsWith("#");
    expect(anchor.getAttribute("target")).toBe(opensAppOrWebsite ? "_blank" : null);
    if (opensAppOrWebsite) expect(anchor.getAttribute("rel")).toBe("noopener");
  }
  expect(page.querySelector("footer")).toBeNull();
  expect(page.querySelector(".site-feature-step")).toBeNull();
  expect(page.querySelector(".site-hero-description")?.textContent).toContain("Navidrome server");
  expect(page.body.textContent).not.toContain("OpenSubsonic");
  expect(page.querySelectorAll(".site-feature-copy .site-body")).toHaveLength(3);
  expect(page.querySelectorAll(".site-subtitle")).toHaveLength(1);
  expect(page.querySelector(".site-hero .site-subtitle")).not.toBeNull();

  for (const anchor of page.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(page.getElementById(anchor.hash.slice(1))).not.toBeNull();
  }
});

it("removes the FAQ and keeps server descriptions in regular text color", () => {
  const page = landingPage();
  expect(page.querySelector(".site-faq")).toBeNull();
  expect(page.querySelector("details")).toBeNull();
  expect(page.querySelectorAll(".site-servers .site-body")).toHaveLength(2);
  expect(page.querySelector(".site-servers p.text-subtle")).toBeNull();
  expect(page.querySelectorAll("h2.text-subtle")).toHaveLength(6);
  expect(page.querySelector(".site-body.text-subtle")).toBeNull();
  expect(page.body.textContent).not.toContain("Clearing site data");
});

it("art-directs the early preview and closes with product actions and open-source trust", () => {
  const page = landingPage();
  const preview = page.querySelector<HTMLImageElement>(".site-preview img")!;
  expect(preview.getAttribute("src")).toBe("/screenshots/hero.webp");
  expect(preview.getAttribute("loading")).not.toBe("lazy");
  const mobile = page.querySelector(".site-preview source")!;
  expect(mobile.getAttribute("srcset")).toBe("/screenshots/library-mobile.webp");
  expect(mobile.getAttribute("width")).toBe("390");
  expect(mobile.getAttribute("height")).toBe("620");
  expect(readFileSync(`website/public${mobile.getAttribute("srcset")}`)).not.toHaveLength(0);
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
  expect(sections.at(-2)?.querySelector("h2")?.textContent).toContain("Free and open source");
  const github = sections.at(-2)?.querySelector("a.button");
  expect(github?.textContent?.trim()).toBe("View on GitHub");
  expect(github?.getAttribute("href")).toBe("https://github.com/TrySound/libras");
  expect(sections.at(-2)?.querySelectorAll("a")).toHaveLength(1);
  expect(sections.at(-1)?.querySelector("h2")?.textContent).toBe("Start listening now.");
  const closing = sections.at(-1)!;
  expect([...closing.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
    "/webapp/",
    "/demo/",
  ]);
  expect(closing.querySelector('[aria-describedby="demo-description"]')).toBeNull();
  expect(closing.textContent).not.toContain("Explore a sample library");
  expect(images.at(-1)?.getAttribute("height")).toBe("400");
});

it("focuses features on the interface, browser access, and downloaded-only offline content", () => {
  const page = landingPage();
  expect(page.getElementById("features-title")).toBeNull();
  expect(page.querySelectorAll(".site-feature h2")).toHaveLength(3);
  expect(page.querySelector(".site-features h3")).toBeNull();
  const descriptions = [...page.querySelectorAll(".site-feature-copy .site-body")];
  expect(descriptions[0].textContent).toContain("video game interfaces");
  expect(descriptions[1].textContent).toContain("computer, tablet, or phone");
  expect(descriptions[2].textContent?.replace(/\s+/g, " ")).toContain(
    "browse and play your downloads without a connection",
  );
  expect(page.querySelector(".site-preview img")?.getAttribute("alt")).toContain("artist library");
  expect(page.querySelector(".site-feature img")?.getAttribute("alt")).toContain("Bullets");
});

it("keeps home in the same tab and opens apps and external links separately", () => {
  const page = landingPage();
  expect(page.querySelector("header .brand")?.textContent).toContain("Libras");
  expect(page.querySelector(".site-hero .brand")).toBeNull();
  expect(page.querySelectorAll('header nav a.button[data-size="text"]')).toHaveLength(2);
  expect(page.querySelectorAll('main .button[data-size="large-text"]')).toHaveLength(6);
  expect(page.querySelector("header nav a[data-variant='primary']")?.textContent?.trim()).toBe(
    "Open player",
  );
  const links = [...page.querySelectorAll("header a")];
  expect(links.map((link) => link.textContent?.trim())).toEqual([
    "Libras",
    "GitHub",
    "Open player",
  ]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/",
    "https://github.com/TrySound/libras",
    "/webapp/",
  ]);
  expect(links[0].hasAttribute("target")).toBe(false);
  for (const link of links.slice(1)) {
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

it("preloads both hero and section heading font weights", () => {
  const fonts = [...landingPage().querySelectorAll('link[rel="preload"][as="font"]')];
  expect(fonts.map((font) => font.getAttribute("href"))).toEqual([
    "../src/fonts/rajdhani-600-latin.woff2",
    "../src/fonts/rajdhani-700-latin.woff2",
  ]);
  for (const font of fonts) {
    expect(font.getAttribute("type")).toBe("font/woff2");
    expect(font.hasAttribute("crossorigin")).toBe(true);
  }
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

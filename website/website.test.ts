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
  expect(link("Start listening")?.getAttribute("href")).toBe("/webapp/");
  expect(link("Music credits")?.getAttribute("href")).toBe("/demo/#/settings");
  expect(link("MIT License")?.getAttribute("href")).toBe(
    "https://github.com/TrySound/libras/blob/main/LICENSE",
  );

  for (const anchor of page.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(page.getElementById(anchor.hash.slice(1))).not.toBeNull();
  }
});

it("includes server requirements and offline limitations in native FAQ disclosures", () => {
  const page = landingPage();
  const disclosures = [...page.querySelectorAll("details")];
  const answer = (question: string) =>
    disclosures.find((element) => element.querySelector("summary")?.textContent === question)
      ?.textContent;

  expect(answer("Which servers are supported?")).toContain("OpenSubsonic");
  expect(answer("Which servers are supported?")).toContain("CORS");
  expect(answer("How does offline listening work?")).toContain("Clearing site data deletes");
  expect(answer("Can I use it on my phone?")).toContain("not yet been verified on iOS");
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

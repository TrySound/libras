// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("serves the complete landing page without executing JavaScript", () => {
  const html = readFileSync("website/index.html", "utf8").replaceAll("%BASE_URL%", "/");
  const page = new DOMParser().parseFromString(html, "text/html");

  expect(page.querySelectorAll("h1")).toHaveLength(1);
  expect(page.querySelector("h1")?.textContent).toContain("Your own music library.");
  expect(page.querySelectorAll(".site-feature")).toHaveLength(5);
  expect(page.querySelectorAll(".site-faq-list details[name=faq]")).toHaveLength(5);
  expect(page.querySelector(".site-faq-list")?.textContent).toContain(
    "Which servers are supported?",
  );
  expect(page.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe("/website.css");
  expect(page.querySelector("noscript")?.textContent).toContain("Enable JavaScript");
  expect(page.querySelector("#demo")?.childElementCount).toBe(0);
  expect(page.querySelectorAll(".app-root")).toHaveLength(0);
  expect(page.querySelectorAll('a[href="/webapp/"]')).toHaveLength(2);
  expect(page.querySelector('a[href="/catalog/credits.html"]')).not.toBeNull();
  expect(page.querySelectorAll(".site-waveform span")).toHaveLength(25);

  for (const link of page.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(page.getElementById(link.hash.slice(1))).not.toBeNull();
  }
  for (const button of page.querySelectorAll("button[commandfor]")) {
    expect(page.getElementById(button.getAttribute("commandfor")!)?.tagName).toBe("DIALOG");
  }

  // These symbols are injected into HTML by the existing Vite sprite plugin.
  const sprite = new DOMParser().parseFromString(
    readFileSync("src/sprite.svg", "utf8"),
    "image/svg+xml",
  );
  for (const icon of page.querySelectorAll("svg use")) {
    expect(sprite.getElementById(icon.getAttribute("href")!.slice(1))).not.toBeNull();
  }
});

// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps website-only classes and custom properties in use", () => {
  const html = readFileSync("website/index.html", "utf8");
  const css = readFileSync("website/website.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const shared = readFileSync("src/edgerunner.css", "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");

  // Check class presence, not current visibility: responsive rules, pseudo-elements,
  // open FAQ states and keyboard-only focus styles must not be treated as dead CSS.
  const selectors = css.replace(/"[^"\n]*"|'[^'\n]*'/g, "");
  const classes = new Set([...selectors.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
  classes.delete("app-root"); // Intentional scope boundary, not landing-page markup.
  for (const name of classes) {
    expect(page.querySelector(`.${name}`), `Unused website class: ${name}`).not.toBeNull();
  }
  // Only count shared rules explicitly exposed to .website, not app-only styles.
  const sharedScopes = [
    ...shared.matchAll(/@scope \(\.app-root, \.design-reference, \.website\) \{([\s\S]*?)\n\}/g),
  ]
    .map((match) => match[1])
    .join("\n");
  const sharedClasses = new Set(
    [...sharedScopes.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]),
  );
  for (const element of page.querySelectorAll("[class]")) {
    for (const name of element.classList) {
      expect(classes.has(name) || sharedClasses.has(name), `Unstyled website class: ${name}`).toBe(
        true,
      );
    }
  }

  expect(page.querySelectorAll(".site-feature.card")).toHaveLength(5);
  expect(page.querySelectorAll("h3.heading-md")).toHaveLength(5);
  expect(page.querySelectorAll(".brand")).toHaveLength(2);
  expect(css).not.toMatch(
    /\.(?:row-(?:xs|sm|md|lg|xl|wrap|center|justify)|stack-(?:xs|sm|md|lg|xl)|card|text-subtle)\b/,
  );
  expect(html).not.toMatch(/\b(?:display-(?:xl|lg|md)|type-body|text-muted)\b/);

  // Include the shared component rules, which consume inherited website tokens.
  const references = new Set(
    [...`${css}\n${shared}`.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]),
  );
  for (const [, name] of css.matchAll(/(--[\w-]+)\s*:/g)) {
    expect(references.has(name), `Unreferenced website token: ${name}`).toBe(true);
  }
});

it("serves the complete landing page without executing JavaScript", () => {
  const html = readFileSync("website/index.html", "utf8").replaceAll("%BASE_URL%", "/");
  const page = new DOMParser().parseFromString(html, "text/html");

  expect(page.querySelectorAll("h1")).toHaveLength(1);
  expect(page.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "Connect your music library and listen anywhere.",
  );
  expect(page.querySelectorAll(".site-feature")).toHaveLength(5);
  expect(page.querySelectorAll(".site-faq-list details[name=faq]")).toHaveLength(5);
  expect(page.querySelector(".site-faq-list")?.textContent).toContain(
    "Which servers are supported?",
  );
  expect(page.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe("/website.css");
  expect(page.querySelector("script, #demo, dialog, .site-showcase")).toBeNull();
  expect(page.querySelector('a[href="/demo/"]')?.textContent).toContain("Try live demo");
  expect(page.querySelectorAll(".app-root")).toHaveLength(0);
  expect(page.querySelectorAll('a[href="/webapp/"]')).toHaveLength(2);
  expect(page.querySelectorAll('a[data-variant="primary"][href="/webapp/"]')).toHaveLength(2);
  expect(page.querySelectorAll('.button[data-size="text"]')).toHaveLength(3);
  expect(page.querySelector('a[href="/demo/"]')?.getAttribute("data-variant")).toBe("secondary");
  expect(page.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#2f0000");
  expect(page.querySelector('link[rel="preload"][as="font"]')?.getAttribute("href")).toBe(
    "../src/fonts/rajdhani-700-latin.woff2",
  );
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

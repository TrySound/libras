// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Demo from "./demo.svelte";
import { readDeezer } from "./deezer-api";
vi.mock("./deezer-api", () => ({ readDeezer: vi.fn() }));
const read = vi.mocked(readDeezer);
import { installDisk } from "../tests/cache-test-helpers";
import { installNavigation } from "../tests/router-test-helpers";

let component: ReturnType<typeof Demo> | undefined;
let cleanup: typeof import("./main").cleanup | undefined;
const fetcher = vi.fn<typeof fetch>();
async function catalogResponse(input: Parameters<typeof fetch>[0]) {
  const url = String(input);
  if (url.startsWith("https://cdn-images.dzcdn.net/"))
    return new Response("art", { headers: { "Content-Type": "image/jpeg" } });
  if (url.endsWith(".svg"))
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      headers: { "Content-Type": "image/svg+xml" },
    });
  throw new Error("Unexpected request");
}
function render() {
  component = mount(Demo, { target: document.body });
  flushSync();
}
beforeEach(() => {
  installDisk();
  installNavigation("/settings");
  vi.stubEnv("BASE_URL", "/");
  read.mockReset().mockRejectedValue(new Error("Unexpected live Deezer request"));
  fetcher.mockReset().mockImplementation(catalogResponse);
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  if (component) await unmount(component);
  if (cleanup) await cleanup();
  component = undefined;
  cleanup = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("opens preconnected without touching regular settings or registering a PWA", async () => {
  installNavigation("/library");
  const register = vi.fn();
  Object.assign(navigator, { serviceWorker: { register } });
  localStorage.setItem("navidrome-auth", "regular credentials");
  localStorage.setItem("navidrome-account", "regular account");
  localStorage.setItem("navidrome-offline-mode", "true");
  render();
  await vi.waitFor(() =>
    expect(document.querySelector(".tile")?.textContent).toContain("A Perfect Circle"),
  );
  expect(document.querySelector("form")).toBeNull();
  expect(document.querySelector(".app-root.standalone")).not.toBeNull();
  expect(document.querySelector("[data-embedded]")).toBeNull();
  expect(localStorage.getItem("navidrome-auth")).toBe("regular credentials");
  expect(localStorage.getItem("navidrome-account")).toBe("regular account");
  expect(localStorage.getItem("navidrome-offline-mode")).toBe("true");
  expect(localStorage.length).toBe(3);
  expect(register).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(Array.from(document.querySelectorAll(".tile"), (tile) => tile.textContent)).toEqual(
    expect.arrayContaining(
      ["Archive", "Breaking Benjamin", "Metric", "Radiohead", "Seether", "Shinedown", "The xx"].map(
        (artist) => expect.stringContaining(artist),
      ),
    ),
  );
  expect(document.getElementById("demo-credits-title")).toBeNull();
});

it.each([
  { artistId: "702", albumId: "302117", year: 2000 },
  { artistId: "1334", albumId: "59667692", year: 2009 },
  { artistId: "5286", albumId: "11019040", year: 2004 },
  { artistId: "5286", albumId: "13793191", year: 2006 },
  { artistId: "5286", albumId: "426788", year: 2009 },
  { artistId: "956", albumId: "320369597", year: 2009 },
  { artistId: "399", albumId: "14879699", year: 1997 },
  { artistId: "261212", albumId: "355921", year: 2009 },
  { artistId: "1189", albumId: "8015732", year: 2004 },
  { artistId: "1189", albumId: "8015752", year: 2005 },
  { artistId: "1189", albumId: "8015762", year: 2007 },
  { artistId: "6691", albumId: "1240724", year: 2008 },
  { artistId: "6691", albumId: "1603045", year: 2012 },
  { artistId: "6691", albumId: "62256972", year: 2018 },
])("shows the album year for artist $artistId", async ({ artistId, albumId, year }) => {
  installNavigation(`/library/artist/${artistId}`);
  render();
  const caption = () =>
    document
      .querySelector(`a[href$="/album/${albumId}"]`)
      ?.closest(".track-row")
      ?.querySelector(".caption")?.textContent;
  await vi.waitFor(() => expect(caption()).toContain(String(year)));
  expect(caption()).not.toContain("Unknown year");
});

it("renders demo credits as an HTML card inside Settings, not above the app", async () => {
  render();
  await vi.waitFor(() => expect(document.querySelector(".settings-view")).not.toBeNull());
  const card = document.querySelector(
    '.settings-view article.card[aria-labelledby="demo-credits-title"]',
  );
  expect(card?.querySelector("h2")?.textContent).toBe("Demo music credits");
  expect(card?.textContent).toContain("Previews provided by Deezer");
  expect(card?.textContent).toContain("Downloads may not work in this demo");
  expect(card?.querySelectorAll("li")).toHaveLength(53);
  expect(card?.querySelectorAll("a")).toHaveLength(53);
  expect(card?.querySelectorAll('a[href*="/track/"]')).toHaveLength(0);
  expect(Array.from(card!.querySelectorAll("a"), (link) => link.textContent?.trim())).toEqual(
    expect.arrayContaining([
      "A Perfect Circle — Mer De Noms (2000)",
      "Archive — Controlling Crowds (Parts I-III) (2009)",
      "Breaking Benjamin — We Are Not Alone (2004)",
      "Seether — Disclaimer II (2004)",
      "Shinedown — The Sound of Madness (2008)",
    ]),
  );
  expect(Array.from(card!.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual(
    expect.arrayContaining([
      "https://www.deezer.com/album/302117",
      "https://www.deezer.com/album/59667692",
      "https://www.deezer.com/album/320369597",
      "https://www.deezer.com/album/14879699",
      "https://www.deezer.com/album/355921",
      "https://www.deezer.com/album/11019040",
      "https://www.deezer.com/album/13793191",
      "https://www.deezer.com/album/426788",
      "https://www.deezer.com/album/8015732",
      "https://www.deezer.com/album/8015752",
      "https://www.deezer.com/album/8015762",
      "https://www.deezer.com/album/1240724",
      "https://www.deezer.com/album/1603045",
      "https://www.deezer.com/album/62256972",
    ]),
  );
  expect(card?.textContent).toContain("Archive");
  expect(card?.textContent).toContain("Breaking Benjamin");
  expect(card?.textContent).toContain("Seether");
  expect(card?.textContent).toContain("Shinedown");
  expect(card?.textContent).not.toContain("Audioslave");
  expect(card?.querySelectorAll("h3")).toHaveLength(0);
  expect(document.querySelector('[aria-label="Demo music credits"]')).toBeNull();
});

it("mounts the demo page as a standalone app and cleans up on hot reload", async () => {
  const html = readFileSync("website/demo/index.html", "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  document.body.append(page.querySelector("#app")!);
  cleanup = (await import("./main")).cleanup;
  flushSync();
  await vi.waitFor(() =>
    expect(document.querySelector("#app .app-root.standalone")).not.toBeNull(),
  );
  expect(document.querySelector(".website, .site-demo-dialog")).toBeNull();
  expect(page.querySelector('link[rel="manifest"]')).toBeNull();
  expect(page.querySelector("noscript")?.textContent).toContain("Enable JavaScript");
  await cleanup();
  cleanup = undefined;
  expect(document.querySelector(".app-root")).toBeNull();
});

it("rejects switching the demo into a real account", async () => {
  localStorage.setItem("navidrome-auth", "regular credentials");
  render();
  await vi.waitFor(() => expect(document.querySelector("#settings-disconnect")).not.toBeNull());
  document.querySelector<HTMLButtonElement>("#settings-disconnect")!.click();
  flushSync();
  for (const [id, value] of [
    ["server-host", "https://regular.example.test"],
    ["server-username", "listener"],
    ["server-password", "not-a-real-secret"],
  ]) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
  await vi.waitFor(() => expect(document.body.textContent).toContain("fixed to its local library"));
  expect(localStorage.getItem("navidrome-auth")).toBe("regular credentials");
  expect(localStorage.length).toBe(1);
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes("regular.example.test"))).toBe(
    true,
  );
});

it("resets preferences on a new mount without writing to localStorage", async () => {
  const toggle = () => document.querySelector<HTMLInputElement>("#settings-offline");
  render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  expect(toggle()!.checked).toBe(false);
  toggle()!.click();
  await vi.waitFor(() => expect(toggle()!.checked).toBe(true));
  await unmount(component!);
  component = undefined;
  render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  expect(toggle()!.checked).toBe(false);
  expect(localStorage.length).toBe(0);
});

it("syncs and refreshes the snapshot even when live Deezer album responses would fail", async () => {
  read.mockRejectedValue(new Error("Unexpected Deezer album or artist."));
  render();
  await vi.waitFor(() =>
    expect(document.querySelector("#settings-server-identity")?.textContent).toContain(
      "deezer-preview-demo",
    ),
  );
  expect(document.querySelector("form")).toBeNull();
  document.querySelector<HTMLButtonElement>('[aria-label="Refresh library"]')!.click();
  flushSync();
  await vi.waitFor(() =>
    expect(document.querySelector("#settings-refresh")?.getAttribute("aria-busy")).toBe("false"),
  );
  expect(document.body.textContent).not.toContain("Synchronization needs attention");
  expect(document.body.textContent).not.toContain("Unexpected Deezer album or artist");
  expect(read).not.toHaveBeenCalled();
});

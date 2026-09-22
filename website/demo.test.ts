// @vitest-environment happy-dom
import { flushSync, mount, unmount, type Component } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Demo from "./demo.svelte";
import Website from "./website.svelte";
import { assetsFixture, searchFixture } from "./fixtures";
import { installDisk } from "../tests/cache-test-helpers";
import { installNavigation } from "../tests/router-test-helpers";

let component: ReturnType<typeof Demo> | undefined;
const fetcher = vi.fn<typeof fetch>();
async function catalogResponse(input: Parameters<typeof fetch>[0]) {
  const url = String(input);
  if (url.endsWith("search3.json")) return new Response(JSON.stringify(searchFixture));
  if (url.endsWith("assets.json")) return new Response(JSON.stringify(assetsFixture));
  if (url.endsWith(".svg"))
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      headers: { "Content-Type": "image/svg+xml" },
    });
  throw new Error("Unexpected request");
}
function render(App: Component<Record<string, never>> = Demo) {
  component = mount(App, { target: document.body });
  flushSync();
}
beforeEach(() => {
  installDisk();
  installNavigation("/settings");
  vi.stubEnv("BASE_URL", "/libras/demo/");
  fetcher.mockReset().mockImplementation(catalogResponse);
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
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
  await vi.waitFor(() => expect(document.body.textContent).toContain("Demo artist"));
  expect(document.querySelector("form")).toBeNull();
  expect(localStorage.getItem("navidrome-auth")).toBe("regular credentials");
  expect(localStorage.getItem("navidrome-account")).toBe("regular account");
  expect(localStorage.getItem("navidrome-offline-mode")).toBe("true");
  expect(localStorage.length).toBe(3);
  expect(register).not.toHaveBeenCalled();
});

it("renders the website around a live demo without replacing the host title or anchor", async () => {
  const navigation = installNavigation("features");
  const title = document.title;
  document.title = "Libras website";
  try {
    render(Website);
    await vi.waitFor(() =>
      expect(document.querySelector(".site-demo-frame .app-root")?.textContent).toContain(
        "Demo artist",
      ),
    );
    expect(document.title).toBe("Libras website");
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toContain("All your music.");
    expect(document.querySelector<HTMLAnchorElement>(".site-actions a.button")?.pathname).toBe(
      "/libras/",
    );
    expect(document.querySelectorAll(".site-faq-list details")).toHaveLength(5);
    for (const link of document.querySelectorAll<HTMLAnchorElement>('.website a[href^="#"]')) {
      if (link.closest(".site-demo-frame")) continue;
      expect(document.getElementById(link.hash.slice(1))).not.toBeNull();
    }
  } finally {
    document.title = title;
  }
});

it("declares native demo commands and preserves the player across closing and resizing", () => {
  const viewport = Object.assign(new EventTarget(), { matches: true });
  vi.spyOn(window, "matchMedia").mockReturnValue(viewport as MediaQueryList);
  render(Website);
  const dialog = document.querySelector<HTMLDialogElement>(".site-demo-dialog")!;
  const app = dialog.querySelector(".app-root");
  expect(dialog.open).toBe(false);
  // Happy DOM doesn't implement invoker commands; check the wiring and simulate
  // the native dialog actions. Real click behavior is checked in Chromium.
  const launch = document.querySelector<HTMLButtonElement>(".site-demo-launch")!;
  expect(launch.getAttribute("commandfor")).toBe(dialog.id);
  expect(launch.getAttribute("command")).toBe("show-modal");
  dialog.showModal();
  expect(dialog.open).toBe(true);
  const close = document.querySelector<HTMLButtonElement>(".site-demo-close")!;
  expect(close.getAttribute("commandfor")).toBe(dialog.id);
  expect(close.getAttribute("command")).toBe("close");
  dialog.close();
  expect(dialog.open).toBe(false);
  expect(dialog.querySelector(".app-root")).toBe(app);
  const heroLaunch = document.querySelector<HTMLButtonElement>(
    '.site-actions button[command="show-modal"]',
  )!;
  expect(heroLaunch.getAttribute("commandfor")).toBe(dialog.id);
  dialog.showModal();
  expect(dialog.open).toBe(true);
  viewport.matches = false;
  viewport.dispatchEvent(new Event("change"));
  flushSync();
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector(".app-root")).toBe(app);
  viewport.matches = true;
  viewport.dispatchEvent(new Event("change"));
  flushSync();
  expect(dialog.open).toBe(false);
  expect(document.querySelectorAll(".app-root")).toHaveLength(1);
});

it("rejects switching the demo into a real account", async () => {
  localStorage.setItem("navidrome-auth", "regular credentials");
  render();
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Disconnect"]')).not.toBeNull(),
  );
  document.querySelector<HTMLButtonElement>('[aria-label="Disconnect"]')!.click();
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
  const toggle = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Offline library"]');
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

it("uses shared app errors and Refresh library to retry catalog loading", async () => {
  fetcher.mockImplementation(async () => new Response("missing", { status: 404 }));
  render();
  await vi.waitFor(() => expect(document.body.textContent).toContain("HTTP 404"));
  expect(document.querySelector("form")).toBeNull();
  fetcher.mockImplementation(catalogResponse);
  document.querySelector<HTMLButtonElement>('[aria-label="Refresh library"]')!.click();
  await vi.waitFor(() => expect(document.body.textContent).not.toContain("HTTP 404"));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("search3.json"))).toHaveLength(
    2,
  );
});

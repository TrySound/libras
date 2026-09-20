// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import Demo from "./demo.svelte";
import { assetsFixture, searchFixture } from "./fixtures";
import { installDisk } from "../tests/cache-test-helpers";
import { installNavigation } from "../tests/router-test-helpers";

let component: ReturnType<typeof Demo> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("opens the shared app preconnected, with isolated settings and no PWA registration", async () => {
  installDisk();
  installNavigation("/library", vi.fn());
  vi.stubEnv("BASE_URL", "/libras/demo/");
  const register = vi.fn();
  Object.assign(navigator, { serviceWorker: { register } });
  localStorage.setItem("navidrome-auth", "regular credentials");
  localStorage.setItem("navidrome-account", "regular account");
  localStorage.setItem("navidrome-offline-mode", "true");
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("search3.json")) return new Response(JSON.stringify(searchFixture));
    if (url.endsWith("assets.json")) return new Response(JSON.stringify(assetsFixture));
    if (url.endsWith(".svg"))
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        headers: { "Content-Type": "image/svg+xml" },
      });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  component = mount(Demo, { target: document.body });
  flushSync();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Demo artist"));
  expect(document.querySelector("form")).toBeNull();
  expect(document.querySelector('a[href$="/catalog/credits.html"]')).not.toBeNull();
  expect(localStorage.getItem("navidrome-auth")).toBe("regular credentials");
  expect(localStorage.getItem("navidrome-account")).toBe("regular account");
  expect(localStorage.getItem("navidrome-offline-mode")).toBe("true");
  expect(register).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes("/rest/"))).toBe(true);
});

it("shows a retryable boot error instead of connecting to a real server", async () => {
  vi.stubEnv("BASE_URL", "/libras/demo/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("missing", { status: 404 })),
  );
  component = mount(Demo, { target: document.body });
  flushSync();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP 404"),
  );
  expect(document.querySelector("button")?.textContent).toBe("Retry");
  expect(document.querySelector("form")).toBeNull();
});

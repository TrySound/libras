// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release, entered: false, mount: vi.fn() };
});
vi.mock("svelte", async (original) => ({
  ...(await original<typeof import("svelte")>()),
  mount: startup.mount,
}));
vi.mock("../src/webapp.svelte", () => ({ default: {} }));
vi.mock("dialog-closedby-polyfill", () => ({}));
vi.mock("invokers-polyfill", () => ({}));
vi.mock("@virtualstate/navigation/polyfill", async () => {
  startup.entered = true;
  await startup.gate;
  return {};
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("captures installation before awaited startup polyfills and passes its owner to the player", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("navigation", undefined);
  await import("../src/main");
  await vi.waitFor(() => expect(startup.entered).toBe(true));
  const prompt = vi.fn(async () => {});
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(startup.mount).not.toHaveBeenCalled();
  startup.release();
  await vi.waitFor(() => expect(startup.mount).toHaveBeenCalledOnce());
  const controller = startup.mount.mock.calls[0][1].props.installation;
  expect(controller.state).toBe("available");
  expect(prompt).not.toHaveBeenCalled();
  controller.destroy();
});

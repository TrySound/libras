// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { registerSW } from "virtual:pwa-register";
import WebappUpdater from "./webapp-updater.svelte";

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn() }));

const cleanups: (() => Promise<void>)[] = [];
function setup() {
  vi.useFakeTimers();
  const show = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: show });
  const apply = vi.fn(async () => {});
  vi.mocked(registerSW).mockReturnValue(apply);
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(WebappUpdater, { target });
  flushSync();
  const callbacks = vi.mocked(registerSW).mock.calls.at(-1)![0]!;
  const registration = {
    waiting: { state: "installed" } as ServiceWorker | null,
    installing: null,
    active: { state: "activated" },
    update: vi.fn(async () => {}),
  };
  callbacks.onRegisteredSW?.("/sw.js", registration as unknown as ServiceWorkerRegistration);
  const updateButton = target.querySelector<HTMLButtonElement>("button")!;
  const later = target.querySelectorAll<HTMLButtonElement>("button")[1]!;
  const region = target.querySelector<HTMLElement>("section")!;
  const destroy = async () => {
    await unmount(component);
    target.remove();
  };
  cleanups.push(destroy);
  const ready = () => {
    callbacks.onNeedRefresh?.();
    flushSync();
  };
  const clickUpdate = async () => {
    updateButton.click();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
  };
  return {
    target,
    callbacks,
    registration,
    apply,
    reload,
    show,
    ready,
    clickUpdate,
    updateButton,
    later,
    region,
    destroy,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(registerSW).mockClear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
});

describe("webapp updater", () => {
  it("prompts without stealing focus and uses a native dismiss command", () => {
    const { ready, show, reload, later, region } = setup();
    expect(show).not.toHaveBeenCalled();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    ready();
    expect(show).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(later.getAttribute("commandfor")).toBe(region.id);
    expect(later.getAttribute("command")).toBe("hide-popover");
    const closed = new Event("toggle");
    Object.assign(closed, { newState: "closed" });
    region.dispatchEvent(closed);
    flushSync();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("uses the plugin to activate and reloads only after its reload callback", async () => {
    const { ready, clickUpdate, apply, reload, callbacks, updateButton } = setup();
    ready();
    await clickUpdate();
    expect(apply).toHaveBeenCalledOnce();
    expect(updateButton.disabled).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    callbacks.onNeedRefresh?.();
    flushSync();
    expect(updateButton.disabled).toBe(true);
    callbacks.onNeedReload?.();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("requires approval when another tab activates the update", async () => {
    const { callbacks, registration, clickUpdate, apply, reload } = setup();
    registration.waiting = null;
    callbacks.onNeedReload?.();
    flushSync();
    expect(reload).not.toHaveBeenCalled();
    await clickUpdate();
    expect(reload).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("offers retry on timeout and does not reload on a late callback", async () => {
    const { ready, clickUpdate, callbacks, updateButton, reload, target } = setup();
    ready();
    await clickUpdate();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(updateButton.disabled).toBe(false);
    expect(target.textContent).toContain("taking too long");
    callbacks.onNeedReload?.();
    flushSync();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not leave the UI stuck if a reload fails to navigate", async () => {
    const { ready, clickUpdate, callbacks, target, updateButton } = setup();
    ready();
    await clickUpdate();
    callbacks.onNeedReload?.();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(updateButton.disabled).toBe(false);
    expect(target.textContent).toContain("taking too long");
  });

  it("shows plugin errors and allows another attempt", async () => {
    const { ready, clickUpdate, apply, updateButton, target } = setup();
    apply.mockRejectedValueOnce(new Error("Activation failed"));
    ready();
    await clickUpdate();
    expect(target.textContent).toContain("Activation failed");
    expect(updateButton.disabled).toBe(false);
    await clickUpdate();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(updateButton.disabled).toBe(true);
  });

  it("ignores an old attempt's rejection after retry starts", async () => {
    const { ready, clickUpdate, apply, updateButton, target } = setup();
    let reject!: (reason: Error) => void;
    apply.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    ready();
    await clickUpdate();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    await clickUpdate();
    reject(new Error("Old attempt failed"));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(updateButton.disabled).toBe(true);
    expect(target.textContent).not.toContain("Old attempt failed");
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(updateButton.disabled).toBe(false);
    expect(target.textContent).toContain("taking too long");
  });

  it("ignores an outstanding activation rejection after destruction", async () => {
    const { ready, clickUpdate, apply, destroy, show, reload } = setup();
    let reject!: (reason: Error) => void;
    apply.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    ready();
    await clickUpdate();
    await destroy();
    cleanups.pop();
    reject(new Error("Late failure"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(show).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows registration errors without offering an update", () => {
    const { callbacks, updateButton, later, show } = setup();
    callbacks.onRegisterError?.(new Error("Registration failed"));
    flushSync();
    expect(show).toHaveBeenCalledOnce();
    expect(updateButton.hidden).toBe(true);
    expect(later.textContent).toBe("Dismiss");
  });

  it("stops checks, timeouts, and late callbacks when destroyed", async () => {
    const { ready, clickUpdate, destroy, callbacks, registration, reload, show } = setup();
    ready();
    await clickUpdate();
    await destroy();
    cleanups.pop();
    callbacks.onNeedReload?.();
    callbacks.onNeedRefresh?.();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(registration.update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledOnce();
  });
});

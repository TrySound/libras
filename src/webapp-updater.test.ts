// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { registerSW } from "virtual:pwa-register";
import WebappUpdater from "./webapp-updater.svelte";

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn() }));

const cleanups: (() => Promise<void>)[] = [];
function setup() {
  vi.useFakeTimers();
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
  const destroy = async () => {
    await unmount(component);
    target.remove();
  };
  cleanups.push(destroy);
  const ready = () => {
    callbacks.onNeedRefresh?.();
    flushSync();
  };
  const update = async () => {
    void component.update();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
  };
  return {
    target,
    callbacks,
    registration,
    apply,
    reload,
    ready,
    update,
    status: component.getStatus,
    destroy,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(registerSW).mockClear();
});

describe("webapp updater", () => {
  it("keeps updates available without a dialog, dismissal, focus change, or reload", async () => {
    const { ready, reload, target, status } = setup();
    expect(status().hasUpdate).toBe(false);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    ready();
    expect(status().hasUpdate).toBe(true);
    expect(target.querySelector('[role="status"]')?.textContent).toContain("update is ready");
    expect(target.querySelector("[popover], dialog, button")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status().hasUpdate).toBe(true);
  });

  it("ignores update requests without an available update", async () => {
    const { update, apply, reload } = setup();
    await update();
    expect(apply).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("activates only once and reloads only after the plugin reload callback", async () => {
    const { ready, update, apply, reload, callbacks, status } = setup();
    ready();
    await update();
    await update();
    expect(apply).toHaveBeenCalledOnce();
    expect(status().busy).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    callbacks.onNeedRefresh?.();
    flushSync();
    expect(status().busy).toBe(true);
    expect(status().hasUpdate).toBe(true);
    callbacks.onNeedReload?.();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("requires approval when another tab activates the update", async () => {
    const { callbacks, registration, update, apply, reload, status } = setup();
    registration.waiting = null;
    callbacks.onNeedReload?.();
    flushSync();
    expect(status().hasUpdate).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await update();
    expect(reload).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ["/#/settings", false],
    ["/libras/#/settings", false],
    ["/libras/#/settings", true],
  ])("reloads the library from %s (already activated: %s)", async (path, activated) => {
    const { ready, update, callbacks, registration, reload } = setup();
    const previousUrl = window.location.href;
    const previousState = window.history.state;
    try {
      window.history.replaceState({ test: true }, "", path);
      reload.mockImplementation(() => {
        expect(window.location.hash).toBe("#/library");
        expect(window.location.pathname).toBe(path.split("#")[0]);
        expect(window.history.state).toEqual({ test: true });
      });
      if (activated) registration.waiting = null;
      ready();
      expect(window.location.hash).toBe("#/settings");
      await update();
      if (!activated) callbacks.onNeedReload?.();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      window.history.replaceState(previousState, "", previousUrl);
    }
  });

  it("offers retry on timeout and does not reload on a late callback", async () => {
    const { ready, update, callbacks, status, reload } = setup();
    ready();
    await update();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(status()).toMatchObject({ hasUpdate: true, busy: false });
    expect(status().message).toContain("taking too long");
    callbacks.onNeedReload?.();
    flushSync();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not leave the UI stuck if a reload fails to navigate", async () => {
    const { ready, update, callbacks, status } = setup();
    ready();
    await update();
    callbacks.onNeedReload?.();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(status().busy).toBe(false);
    expect(status().message).toContain("taking too long");
  });

  it("shows plugin errors and allows another attempt", async () => {
    const { ready, update, apply, status } = setup();
    apply.mockRejectedValueOnce(new Error("Activation failed"));
    ready();
    await update();
    expect(status().message).toContain("Activation failed");
    expect(status()).toMatchObject({ hasUpdate: true, busy: false });
    await update();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(status().busy).toBe(true);
  });

  it("ignores an old attempt's rejection after retry starts", async () => {
    const { ready, update, apply, status } = setup();
    let reject!: (reason: Error) => void;
    apply.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    ready();
    await update();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    await update();
    reject(new Error("Old attempt failed"));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(status().busy).toBe(true);
    expect(status().message).not.toContain("Old attempt failed");
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(status().busy).toBe(false);
    expect(status().message).toContain("taking too long");
  });

  it("ignores an outstanding activation rejection after destruction", async () => {
    const { ready, update, apply, destroy, reload } = setup();
    let reject!: (reason: Error) => void;
    apply.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    ready();
    await update();
    await destroy();
    cleanups.pop();
    reject(new Error("Late failure"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("exposes registration errors without offering an update", () => {
    const { callbacks, status } = setup();
    callbacks.onRegisterError?.(new Error("Registration failed"));
    flushSync();
    expect(status().hasUpdate).toBe(false);
    expect(status().message).toContain("Offline app setup failed");
  });

  it("stops checks, timeouts, and late callbacks when destroyed", async () => {
    const { ready, update, destroy, callbacks, registration, reload } = setup();
    ready();
    await update();
    await destroy();
    cleanups.pop();
    callbacks.onNeedReload?.();
    callbacks.onNeedRefresh?.();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(registration.update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

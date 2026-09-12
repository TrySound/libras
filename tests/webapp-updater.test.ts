// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { registerSW } from "virtual:pwa-register";
import WebappUpdater from "../src/webapp-updater.svelte";

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn() }));

const cleanups: (() => Promise<void>)[] = [];
const worker = (state: ServiceWorkerState) => Object.assign(new EventTarget(), { state });
function setup(controlled = true) {
  vi.useFakeTimers();
  const initial = controlled ? worker("activated") : null;
  const serviceWorker = Object.assign(new EventTarget(), { controller: initial });
  vi.stubGlobal("navigator", { serviceWorker, onLine: true });
  const apply = vi.fn(async () => {});
  vi.mocked(registerSW).mockReturnValue(apply);
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(WebappUpdater, { target });
  flushSync();
  const callbacks = vi.mocked(registerSW).mock.calls.at(-1)![0]!;
  const registration = {
    waiting: null as ReturnType<typeof worker> | null,
    installing: null,
    active: initial,
    update: vi.fn(async () => {}),
  };
  callbacks.onRegisteredSW?.("/sw.js", registration as unknown as ServiceWorkerRegistration);
  const destroy = async () => {
    await unmount(component);
    target.remove();
  };
  cleanups.push(destroy);
  const ready = () => {
    registration.waiting = worker("installed");
    callbacks.onNeedRefresh?.();
    flushSync();
  };
  const activate = (claim = true) => {
    const next = registration.waiting ?? worker("activated");
    next.state = "activated";
    registration.active = next;
    registration.waiting = null;
    next.dispatchEvent(new Event("statechange"));
    if (claim) {
      serviceWorker.controller = next;
      serviceWorker.dispatchEvent(new Event("controllerchange"));
    }
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
    activate,
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
  vi.unstubAllGlobals();
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

  it("ignores stale refresh notifications when the current worker has no waiting update", () => {
    const { callbacks, status, reload } = setup();
    callbacks.onNeedRefresh?.();
    callbacks.onNeedReload?.();
    flushSync();
    expect(status().hasUpdate).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not offer a reload when the initial installation claims the page", () => {
    const { activate, callbacks, status, reload } = setup(false);
    activate();
    callbacks.onNeedRefresh?.();
    callbacks.onNeedReload?.();
    flushSync();
    expect(status().hasUpdate).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads an approved waiting update even when the page initially had no controller", async () => {
    const { ready, activate, update, reload } = setup(false);
    ready();
    await update();
    activate();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads a hard-refreshed page when activation does not emit controllerchange", async () => {
    const { ready, activate, update, reload, registration, status } = setup(false);
    ready();
    await update();
    registration.waiting!.state = "activating";
    registration.waiting!.dispatchEvent(new Event("statechange"));
    expect(reload).not.toHaveBeenCalled();
    activate(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(status().busy).toBe(true);
  });

  it("requires approval after a waiting update activates without claiming the page", async () => {
    const { ready, activate, update, reload, apply, status } = setup(false);
    ready();
    activate(false);
    expect(reload).not.toHaveBeenCalled();
    expect(status().hasUpdate).toBe(true);
    await update();
    expect(reload).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("clears an update that disappeared before approval instead of reloading", async () => {
    const { ready, registration, update, status, apply, reload } = setup();
    ready();
    registration.waiting = null;
    await update();
    expect(status().hasUpdate).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("drops a redundant waiting update without reloading", () => {
    const { ready, registration, status, reload } = setup(false);
    ready();
    const waiting = registration.waiting!;
    registration.waiting = null;
    waiting.state = "redundant";
    waiting.dispatchEvent(new Event("statechange"));
    flushSync();
    expect(status().hasUpdate).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores state changes from a replaced waiting worker", async () => {
    const { ready, registration, update, reload } = setup(false);
    ready();
    const old = registration.waiting!;
    ready();
    await update();
    old.state = "activated";
    old.dispatchEvent(new Event("statechange"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("notices a waiting worker during registration before the plugin's refresh callback", () => {
    const { callbacks, registration, status } = setup();
    registration.waiting = worker("installed");
    callbacks.onRegisteredSW?.("/sw.js", registration as unknown as ServiceWorkerRegistration);
    flushSync();
    expect(status().hasUpdate).toBe(true);
  });

  it("ignores update requests without an available update", async () => {
    const { update, apply, reload } = setup();
    await update();
    expect(apply).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reloads without a plugin callback (controlled at startup: %s)",
    async (controlled) => {
      const { ready, activate, update, apply, reload, callbacks, status } = setup(controlled);
      // Workbox keeps isUpdate=false when the first worker claims an initially uncontrolled page.
      if (!controlled) activate();
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
      activate();
      expect(reload).toHaveBeenCalledOnce();
      callbacks.onNeedReload?.();
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it("requires approval when another tab activates the update", async () => {
    const { activate, update, apply, reload, status } = setup();
    activate();
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
    const { ready, activate, update, reload } = setup();
    const previousUrl = window.location.href;
    const previousState = window.history.state;
    try {
      window.history.replaceState({ test: true }, "", path);
      reload.mockImplementation(() => {
        expect(window.location.hash).toBe("#/library");
        expect(window.location.pathname).toBe(path.split("#")[0]);
        expect(window.history.state).toEqual({ test: true });
      });
      if (activated) activate();
      else ready();
      expect(window.location.hash).toBe("#/settings");
      await update();
      if (!activated) activate();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      window.history.replaceState(previousState, "", previousUrl);
    }
  });

  it.each([false, true])(
    "requires retry after late activation (claims page: %s)",
    async (claim) => {
      const { ready, activate, update, status, reload } = setup(claim);
      ready();
      await update();
      await vi.advanceTimersByTimeAsync(15_000);
      flushSync();
      expect(status()).toMatchObject({ hasUpdate: true, busy: false });
      expect(status().message).toContain("taking too long");
      activate(claim);
      expect(reload).not.toHaveBeenCalled();
      await update();
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it("does not leave the UI stuck if a reload fails to navigate", async () => {
    const { ready, activate, update, status, reload } = setup();
    ready();
    await update();
    activate();
    expect(reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(status().busy).toBe(false);
    expect(status().message).toContain("taking too long");
    await update();
    expect(reload).toHaveBeenCalledTimes(2);
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
    const { ready, activate, update, destroy, callbacks, registration, reload } = setup();
    ready();
    await update();
    await destroy();
    cleanups.pop();
    activate();
    callbacks.onNeedReload?.();
    callbacks.onNeedRefresh?.();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(registration.update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

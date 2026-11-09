// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import WebappUpdater from "../src/webapp-updater.svelte";

const cleanups: (() => Promise<void>)[] = [];
const worker = (state: ServiceWorkerState) =>
  Object.assign(new EventTarget(), { state, postMessage: vi.fn() });
type Worker = ReturnType<typeof worker>;
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};
async function setup(
  options: {
    controlled?: boolean;
    firstInstall?: boolean;
    waiting?: Worker;
    installing?: Worker;
    deferred?: boolean;
    dev?: boolean;
    unsupported?: boolean;
    registration?: Promise<ServiceWorkerRegistration>;
  } = {},
) {
  vi.useFakeTimers();
  vi.stubEnv("DEV", options.dev ?? false);
  vi.stubEnv("BASE_URL", "/webapp/");
  vi.spyOn(document, "readyState", "get").mockReturnValue(
    options.deferred ? "loading" : "complete",
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const initial = options.firstInstall ? null : worker("activated");
  const registration = Object.assign(new EventTarget(), {
    waiting: options.waiting ?? (null as Worker | null),
    installing: options.installing ?? (null as Worker | null),
    active: initial,
    update: vi.fn(async () => {}),
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: options.controlled === false ? null : initial,
    register: vi.fn(() => options.registration ?? Promise.resolve(registration)),
  });
  const navigator = {
    serviceWorker: options.unsupported ? undefined : serviceWorker,
    onLine: true,
  };
  vi.stubGlobal("navigator", navigator);
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(WebappUpdater, { target });
  flushSync();
  await settle();
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    await unmount(component);
    target.remove();
  };
  cleanups.push(destroy);
  const discover = (next = worker("installing")) => {
    registration.installing = next;
    registration.dispatchEvent(new Event("updatefound"));
    flushSync();
    return next;
  };
  const change = (next: Worker, state: ServiceWorkerState) => {
    next.state = state;
    next.dispatchEvent(new Event("statechange"));
    flushSync();
  };
  const ready = () => {
    const next = discover();
    registration.installing = null;
    registration.waiting = next;
    change(next, "installed");
    return next;
  };
  const claim = (next: Worker) => {
    serviceWorker.controller = next;
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    flushSync();
  };
  const activate = (next: Worker, control = true) => {
    registration.waiting = null;
    registration.installing = null;
    registration.active = next;
    change(next, "activating");
    change(next, "activated");
    if (control) claim(next);
  };
  const update = async () => {
    await component.update();
    flushSync();
  };
  return {
    target,
    navigator,
    serviceWorker,
    registration,
    initial,
    reload,
    discover,
    change,
    ready,
    claim,
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("native webapp updater", () => {
  it("registers one base-aware classic worker and exposes one atomic status", async () => {
    const h = await setup();
    expect(h.serviceWorker.register).toHaveBeenCalledExactlyOnceWith("/webapp/sw.js", {
      scope: "/webapp/",
      type: "classic",
    });
    expect(h.target.querySelectorAll('[role="status"][aria-atomic="true"]')).toHaveLength(1);
    expect(h.status()).toMatchObject({ hasUpdate: false, busy: false, message: "" });
  });

  it.each([{ dev: true }, { unsupported: true }])("does not register in %j", async (options) => {
    const h = await setup(options);
    expect(h.serviceWorker.register).not.toHaveBeenCalled();
    expect(h.status().hasUpdate).toBe(false);
  });

  it("defers registration until load, once", async () => {
    const h = await setup({ deferred: true });
    expect(h.serviceWorker.register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("load"));
    window.dispatchEvent(new Event("load"));
    await settle();
    expect(h.serviceWorker.register).toHaveBeenCalledOnce();
  });

  it("cancels deferred registration on destruction", async () => {
    const h = await setup({ deferred: true });
    await h.destroy();
    window.dispatchEvent(new Event("load"));
    expect(h.serviceWorker.register).not.toHaveBeenCalled();
  });

  it("keeps discovery non-disruptive and observes repeated updatefound events", async () => {
    const h = await setup();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const b = h.ready();
    expect(h.status().hasUpdate).toBe(true);
    expect(h.target.textContent).toContain("A new version of Libras is available.");
    expect(h.target.querySelector("[popover], dialog, button")).toBeNull();
    h.activate(b);
    const c = h.ready();
    await h.update();
    expect(c.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    expect(b.postMessage).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.status().busy).toBe(true);
    h.activate(c);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "installing"] as const)(
    "observes existing %s at registration",
    async (slot) => {
      const next = worker(slot === "waiting" ? "installed" : "installing");
      const h = await setup({ [slot]: next });
      if (slot === "installing") {
        expect(h.status().hasUpdate).toBe(false);
        h.registration.installing = null;
        h.registration.waiting = next;
        h.change(next, "installed");
      }
      expect(h.status().hasUpdate).toBe(true);
    },
  );

  it.each([true, false])(
    "ignores first installation and claim (present at register: %s)",
    async (existing) => {
      const first = worker("installing");
      const h = await setup({ firstInstall: true, installing: existing ? first : undefined });
      if (!existing) h.discover(first);
      h.activate(first);
      expect(h.status().hasUpdate).toBe(false);
      expect(h.reload).not.toHaveBeenCalled();
      h.ready();
      expect(h.status().hasUpdate).toBe(true);
    },
  );

  it("does not offer a failed first installation's successor as an update", async () => {
    const first = worker("installing");
    const h = await setup({ firstInstall: true, installing: first });
    h.registration.installing = null;
    h.change(first, "redundant");
    const next = h.discover();
    h.activate(next);
    expect(h.status().hasUpdate).toBe(false);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("baselines a successful first claim only after activation, including failed first-install retries", async () => {
    const h = await setup({ firstInstall: true });
    for (let i = 0; i < 3; i++) {
      const failed = h.discover();
      h.registration.installing = null;
      h.change(failed, "redundant");
      expect(h.status().hasUpdate).toBe(false);
    }
    const first = h.discover();
    h.registration.installing = null;
    h.registration.waiting = first;
    h.change(first, "installed");
    expect(h.status().hasUpdate).toBe(false);
    h.registration.waiting = null;
    h.registration.active = first;
    h.change(first, "activating");
    h.claim(first);
    expect(h.status().hasUpdate).toBe(false);
    h.change(first, "activated");
    expect(h.status().hasUpdate).toBe(false);
    const next = h.ready();
    expect(h.status().hasUpdate).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
    expect(next.postMessage).not.toHaveBeenCalled();
  });

  it("does not offer an installation that becomes redundant before precaching completes", async () => {
    const h = await setup();
    const next = h.discover();
    h.registration.installing = null;
    h.change(next, "redundant");
    expect(h.status().hasUpdate).toBe(false);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "notices replacement B while registration is pending (controller changes before resolution: %s)",
    async (claimBeforeResolution) => {
      let resolve!: (value: ServiceWorkerRegistration) => void;
      const pending = new Promise<ServiceWorkerRegistration>((done) => {
        resolve = done;
      });
      const h = await setup({ registration: pending });
      const b = worker("activated");
      // The document mounted under A; another tab finishes activating B while
      // register() is pending. Its controllerchange may arrive on either side
      // of this registration promise's completion.
      h.registration.active = b;
      if (claimBeforeResolution) h.claim(b);
      resolve(h.registration as unknown as ServiceWorkerRegistration);
      await settle();
      expect(h.status()).toMatchObject({ hasUpdate: true, busy: false });
      if (!claimBeforeResolution) h.claim(b);
      expect(h.status().hasUpdate).toBe(true);
      expect(h.reload).not.toHaveBeenCalled();
      await h.update();
      expect(h.reload).toHaveBeenCalledOnce();
      expect(b.postMessage).not.toHaveBeenCalled();
    },
  );

  it("notices active A replaced by B on an initially uncontrolled page", async () => {
    const h = await setup({ controlled: false });
    h.activate(h.ready(), false);
    expect(h.status().hasUpdate).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
    await h.update();
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it.each(["activation-first", "controller-first", "no-controller"])(
    "waits for completed approved activation: %s",
    async (order) => {
      const h = await setup({ controlled: order !== "no-controller" });
      const b = h.ready();
      await h.update();
      await h.update();
      expect(b.postMessage).toHaveBeenCalledOnce();
      h.registration.waiting = null;
      h.registration.active = b;
      h.change(b, "activating");
      if (order === "controller-first") h.claim(b);
      expect(h.reload).not.toHaveBeenCalled();
      h.change(b, "activated");
      if (order === "activation-first") h.claim(b);
      expect(h.reload).toHaveBeenCalledOnce();
      expect(h.status().busy).toBe(true);
      h.claim(b);
      expect(h.reload).toHaveBeenCalledOnce();
    },
  );

  it("applies a waiting update offline without a network check", async () => {
    const h = await setup();
    const b = h.ready();
    h.navigator.onLine = false;
    await h.update();
    h.activate(b);
    expect(h.registration.update).not.toHaveBeenCalled();
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("requires explicit consent after another tab activates", async () => {
    const h = await setup();
    const b = h.ready();
    h.activate(b);
    expect(h.reload).not.toHaveBeenCalled();
    await h.update();
    expect(b.postMessage).not.toHaveBeenCalled();
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("ignores clicks without an update and clears a stale waiting offer", async () => {
    const h = await setup();
    await h.update();
    h.ready();
    h.registration.waiting = null;
    await h.update();
    expect(h.status()).toMatchObject({ hasUpdate: false, busy: false, failed: true });
    expect(h.status().message).toContain("no longer available");
    expect(h.reload).not.toHaveBeenCalled();
  });

  it.each([false, true])("ends a redundant update immediately (approved: %s)", async (approved) => {
    const h = await setup();
    const b = h.ready();
    if (approved) await h.update();
    h.registration.waiting = null;
    h.change(b, "redundant");
    expect(h.status()).toMatchObject({ hasUpdate: false, busy: false, failed: true });
    expect(h.status().message).toContain("no longer available");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("ends a disappeared approved update on reconciliation", async () => {
    const h = await setup();
    h.ready();
    await h.update();
    h.registration.waiting = null;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.status()).toMatchObject({ busy: false, hasUpdate: false });
  });

  it("applies installed replacement C under B's approval without another click", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    const c = h.discover();
    // C can be announced before B becomes redundant; neither event revokes approval.
    expect(h.status().busy).toBe(true);
    expect(c.postMessage).not.toHaveBeenCalled();
    h.change(b, "redundant");
    h.registration.waiting = c;
    h.registration.installing = null;
    h.change(c, "installed");
    expect(h.status().busy).toBe(true);
    expect(b.postMessage).toHaveBeenCalledOnce();
    expect(c.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "SKIP_WAITING" });
    h.registration.dispatchEvent(new Event("updatefound"));
    await h.update();
    expect(c.postMessage).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
    h.activate(c);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps the attempt busy while C installs, ending only on outcome/deadline (C succeeds: %s)",
    async (succeeds) => {
      const h = await setup();
      const b = h.ready();
      await h.update();
      h.registration.waiting = null;
      const c = h.discover();
      expect(h.status()).toMatchObject({ busy: true, failed: false });
      h.change(b, "redundant");
      expect(h.status().busy).toBe(true);
      h.registration.installing = null;
      if (succeeds) {
        h.registration.waiting = c;
        h.change(c, "installed");
        expect(c.postMessage).toHaveBeenCalledOnce();
        expect(h.reload).not.toHaveBeenCalled();
        h.activate(c);
        expect(h.reload).toHaveBeenCalledOnce();
      } else {
        h.change(c, "redundant");
        expect(h.status()).toEqual({
          busy: false,
          hasUpdate: false,
          failed: true,
          message: "This update is no longer available. You can keep using the app.",
        });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(c.postMessage).not.toHaveBeenCalled();
        expect(h.reload).not.toHaveBeenCalled();
      }
    },
  );

  it("messages an already-installed replacement within the same attempt", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    const c = worker("installed");
    h.registration.waiting = c;
    h.change(b, "redundant");
    expect(h.status()).toMatchObject({ hasUpdate: true, busy: true });
    expect(c.postMessage).toHaveBeenCalledOnce();
    h.activate(c);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("reloads a completed replacement within the same attempt", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    const c = worker("activated");
    // A frozen tab can resume after another tab has replaced B entirely.
    h.registration.waiting = null;
    h.registration.active = c;
    h.change(b, "redundant");
    h.claim(c);
    expect(h.status()).toMatchObject({ busy: true, hasUpdate: true });
    expect(h.reload).toHaveBeenCalledOnce();
    expect(c.postMessage).not.toHaveBeenCalled();
  });

  it("replacement installation cannot extend the original deadline or retain expired approval", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    await vi.advanceTimersByTimeAsync(10_000);
    h.registration.waiting = null;
    const c = h.discover();
    h.change(b, "redundant");
    await vi.advanceTimersByTimeAsync(4_999);
    flushSync();
    expect(h.status().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    flushSync();
    expect(h.status()).toEqual({
      hasUpdate: false,
      busy: false,
      failed: true,
      message: "The update is taking too long. You can keep using the app.",
    });
    h.registration.installing = null;
    h.registration.waiting = c;
    h.change(c, "installed");
    expect(h.status()).toMatchObject({ hasUpdate: true, busy: false, failed: false });
    expect(c.postMessage).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    await h.update();
    expect(c.postMessage).toHaveBeenCalledOnce();
    h.activate(c);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("failed replacement leaves a waiting update bounded by the original deadline", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    await vi.advanceTimersByTimeAsync(10_000);
    const c = h.discover();
    await vi.advanceTimersByTimeAsync(2_000);
    h.registration.installing = null;
    h.change(c, "redundant");
    expect(h.status().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    flushSync();
    expect(h.status()).toMatchObject({ hasUpdate: true, busy: false });
    expect(h.status().message).toContain("taking too long");
    expect(b.postMessage).toHaveBeenCalledOnce();
    h.activate(b);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.status()).toMatchObject({ hasUpdate: true, failed: false });
  });

  it.each([false, true])(
    "does not reload an earlier completed update while C is pending (C claims during activation: %s)",
    async (claim) => {
      const h = await setup();
      h.activate(h.ready());
      const c = h.ready();
      await h.update();
      expect(c.postMessage).toHaveBeenCalledOnce();
      expect(h.reload).not.toHaveBeenCalled();
      h.registration.waiting = null;
      h.registration.active = c;
      h.change(c, "activating");
      if (claim) h.claim(c);
      expect(h.reload).not.toHaveBeenCalled();
      h.change(c, "activated");
      expect(h.reload).toHaveBeenCalledOnce();
    },
  );

  it("can use an already-completed update while a newer download is installing", async () => {
    const h = await setup();
    h.activate(h.ready());
    const c = h.discover();
    await h.update();
    expect(h.reload).toHaveBeenCalledOnce();
    expect(c.postMessage).not.toHaveBeenCalled();
    expect(h.registration.update).not.toHaveBeenCalled();
  });

  it("does not label post-timeout activation as a lost update or keep a false retry action", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    await vi.advanceTimersByTimeAsync(15_000);
    h.registration.waiting = null;
    h.registration.active = b;
    h.change(b, "activating");
    expect(h.status()).toMatchObject({ hasUpdate: false, busy: false });
    expect(h.status().message).not.toContain("no longer available");
    h.change(b, "activated");
    expect(h.status()).toMatchObject({ hasUpdate: true, failed: false });
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("keeps observing an activating current worker after expiry but requires fresh consent", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    h.registration.waiting = null;
    h.registration.active = b;
    h.change(b, "activating");
    h.claim(b);
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(h.status()).toMatchObject({ busy: false, hasUpdate: false });
    expect(h.status().message).toBe("The update is taking too long. You can keep using the app.");
    h.change(b, "activated");
    expect(h.status()).toMatchObject({ hasUpdate: true, failed: false });
    expect(h.reload).not.toHaveBeenCalled();
    await h.update();
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("prunes obsolete listeners through repeated long-lived discovery and on destruction", async () => {
    const h = await setup();
    let previous = h.initial!;
    let remove = vi.spyOn(previous, "removeEventListener");
    for (let i = 0; i < 12; i++) {
      const next = worker("installing");
      const add = vi.spyOn(next, "addEventListener");
      h.discover(next);
      h.registration.installing = null;
      h.registration.waiting = next;
      h.change(next, "installed");
      h.activate(next);
      expect(remove).toHaveBeenCalledExactlyOnceWith("statechange", expect.any(Function));
      expect(add).toHaveBeenCalledExactlyOnceWith("statechange", expect.any(Function));
      previous = next;
      remove = vi.spyOn(previous, "removeEventListener");
    }
    expect(h.reload).not.toHaveBeenCalled();
    await h.destroy();
    expect(remove).toHaveBeenCalledExactlyOnceWith("statechange", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores state events from an obsolete unapproved worker", async () => {
    const h = await setup();
    const b = h.ready();
    const c = h.ready();
    await h.update();
    // Simulate a queued stale notification after its listener has been removed.
    h.change(b, "redundant");
    expect(h.status().busy).toBe(true);
    expect(c.postMessage).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it.each([false, true])("late activation requires new approval (claim: %s)", async (claim) => {
    const h = await setup({ controlled: claim });
    const b = h.ready();
    await h.update();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(h.status()).toMatchObject({ busy: false, hasUpdate: true });
    expect(h.status().message).toContain("taking too long");
    h.activate(b, claim);
    expect(h.status()).toMatchObject({ hasUpdate: true, failed: false });
    expect(h.status().message).toContain("A new version of Libras is available.");
    expect(h.reload).not.toHaveBeenCalled();
    await h.update();
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("revokes approval by the deadline even before an overdue timer callback runs", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    // Model resuming a suspended page with an event queued ahead of its timer.
    vi.setSystemTime(Date.now() + 15_001);
    h.activate(b);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.status()).toMatchObject({ hasUpdate: true, busy: false });
    await h.update();
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("keeps the watchdog through navigation and offers explicit reload on failure", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    h.activate(b);
    expect(h.reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(h.status()).toMatchObject({ busy: false, hasUpdate: true });
    expect(h.status().message).toContain("did not reload");
    await h.update();
    expect(h.reload).toHaveBeenCalledTimes(2);
  });

  it("does not invent retry availability when an activating attempt is absent at timeout", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    // A registration may lose its worker without delivering another event to this document.
    h.registration.waiting = null;
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(h.status()).toMatchObject({ busy: false, hasUpdate: false, failed: true });
    expect(h.status().message).toBe("The update is taking too long. You can keep using the app.");
    // Detached workers are deliberately not retained after expiry. A synthetic
    // reappearance without an observed event is reconciled on visibility, even offline.
    h.activate(b, false);
    expect(h.status().hasUpdate).toBe(false);
    h.navigator.onLine = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.status()).toMatchObject({ hasUpdate: true, failed: false });
    expect(h.registration.update).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("handles a synchronous message failure and allows a real retry", async () => {
    const h = await setup();
    const b = h.ready();
    b.postMessage.mockImplementationOnce(() => {
      throw new DOMException("cannot send");
    });
    await h.update();
    expect(h.status()).toMatchObject({ busy: false, hasUpdate: true, failed: true });
    expect(h.status().message).toContain("could not be applied");
    await h.update();
    expect(h.status().busy).toBe(true);
    expect(b.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["/?/settings#downloads", "/webapp/?/settings#downloads"])(
    "preserves URL on reload: %s",
    async (path) => {
      const h = await setup();
      const previous = window.location.href;
      try {
        window.history.replaceState({ test: true }, "", path);
        h.reload.mockImplementation(() => {
          expect(window.location.pathname + window.location.search + window.location.hash).toBe(
            path,
          );
          expect(window.history.state).toEqual({ test: true });
        });
        const b = h.ready();
        await h.update();
        h.activate(b);
        expect(h.reload).toHaveBeenCalledOnce();
      } finally {
        window.history.replaceState(null, "", previous);
      }
    },
  );

  it("shows safe setup errors without a retry action", async () => {
    const h = await setup({ registration: Promise.reject(new Error("secret URL")) });
    expect(h.status()).toMatchObject({ hasUpdate: false, failed: true });
    expect(h.status().message).toBe("Offline app setup failed. You can keep using the app online.");
  });

  it("does not offer an action after setup fails even if the controller changed while pending", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<ServiceWorkerRegistration>((_resolve, fail) => {
      reject = fail;
    });
    const h = await setup({ registration: pending });
    h.claim(worker("activated"));
    reject(new Error("registration failed"));
    await settle();
    expect(h.status()).toMatchObject({ hasUpdate: false, busy: false, failed: true });
    expect(h.status().message).toContain("Offline app setup failed");
    await h.update();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("checks only when visible and online, silently reconciling rejected checks", async () => {
    const h = await setup();
    h.ready();
    h.registration.update.mockRejectedValue(new Error("offline"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.status()).toMatchObject({ hasUpdate: true, failed: false });
    h.navigator.onLine = false;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.registration.update).toHaveBeenCalledTimes(1);
    h.navigator.onLine = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.registration.update).toHaveBeenCalledTimes(1);
  });

  it("reconciles workers installed during a rejected check", async () => {
    const h = await setup();
    h.registration.update.mockImplementationOnce(async () => {
      h.registration.waiting = worker("installed");
      throw new Error("check failed after installation");
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    flushSync();
    expect(h.status().hasUpdate).toBe(true);
  });

  it("ignores stale checks and cancels all lifecycle activity after destruction", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    let reject!: (reason: Error) => void;
    h.registration.update.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await h.destroy();
    reject(new Error("late failure"));
    h.activate(b);
    h.discover();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.registration.update).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an older attempt's deadline cannot expire a fresh approval", async () => {
    const h = await setup();
    const b = h.ready();
    await h.update();
    await vi.advanceTimersByTimeAsync(10_000);
    h.registration.waiting = null;
    h.change(b, "redundant");
    const c = h.ready();
    await h.update();
    await vi.advanceTimersByTimeAsync(5_000);
    flushSync();
    expect(h.status().busy).toBe(true);
    h.activate(c);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("an older rejected check cannot corrupt a fresh approval", async () => {
    const h = await setup();
    let reject!: (cause: Error) => void;
    h.registration.update.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    const b = h.ready();
    await h.update();
    reject(new Error("stale check"));
    await settle();
    expect(h.status().busy).toBe(true);
    h.activate(b);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("ignores asynchronous registration rejection after destruction", async () => {
    let reject!: (cause: Error) => void;
    const pending = new Promise<ServiceWorkerRegistration>((_resolve, fail) => {
      reject = fail;
    });
    const h = await setup({ registration: pending });
    await h.destroy();
    reject(new Error("late setup failure"));
    await settle();
    expect(h.status().message).toBe("");
  });

  it("ignores asynchronous registration completion after destruction", async () => {
    let resolve!: (value: ServiceWorkerRegistration) => void;
    const pending = new Promise<ServiceWorkerRegistration>((done) => {
      resolve = done;
    });
    const h = await setup({ registration: pending });
    const listen = vi.spyOn(h.registration, "addEventListener");
    await h.destroy();
    resolve(h.registration as unknown as ServiceWorkerRegistration);
    await settle();
    expect(listen).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
  });
});

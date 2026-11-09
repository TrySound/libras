<script lang="ts">
  import { onMount } from "svelte";

  type UpdaterState =
    | { status: "idle" }
    | { status: "ready" }
    | { status: "updating" }
    | { status: "error"; message: string; retry: boolean };

  let state = $state<UpdaterState>({ status: "idle" });
  let apply = () => {};
  const busy = $derived(state.status === "updating");
  const hasUpdate = $derived(
    state.status === "ready" || busy || (state.status === "error" && state.retry),
  );
  const message = $derived(
    state.status === "error"
      ? state.message
      : {
          idle: "",
          ready:
            "A new version of Libras is available. Update now to reload the app. This interrupts playback.",
          updating: "Applying the update. The app will reload when it is ready.",
        }[state.status],
  );

  onMount(() => {
    if (import.meta.env.DEV || !navigator.serviceWorker) return;
    const serviceWorker = navigator.serviceWorker;
    const lifetime = new AbortController();
    let registration: ServiceWorkerRegistration | undefined;
    // A hard-refreshed document may have an active worker but no controller.
    // Neither that worker nor the initial installation is an update for this page.
    const initialController = serviceWorker.controller;
    let initialActive: ServiceWorker | null = null;
    let initialInstall: ServiceWorker | null = null;
    let late: ServiceWorker | null = null;
    const observed = new Set<ServiceWorker>();
    type Attempt = {
      worker: ServiceWorker | null;
      previousActive: ServiceWorker | null;
      reloaded: boolean;
      timer?: ReturnType<typeof setTimeout>;
    };
    let attempt: Attempt | undefined;
    const isBaseline = (worker: ServiceWorker) =>
      worker === initialController || worker === initialActive || worker === initialInstall;
    const waiting = () => {
      const worker = registration?.waiting;
      return worker?.state === "installed" && !isBaseline(worker) ? worker : null;
    };
    const activated = () =>
      [registration?.active, serviceWorker.controller].find(
        (worker) => worker?.state === "activated" && !isBaseline(worker),
      );
    const available = () => !!(waiting() || activated());
    const notice = (message: string) => {
      state = { status: "error", message, retry: available() };
    };
    const endAttempt = () => {
      if (attempt) clearTimeout(attempt.timer);
      attempt = undefined;
    };
    const reload = (current: Attempt) => {
      if (attempt !== current || current.reloaded) return;
      current.reloaded = true;
      // Retain the watchdog until navigation actually destroys this document.
      location.reload();
    };
    const reconcile = () => {
      if (lifetime.signal.aborted || !registration) return;
      if (initialInstall?.state === "activated") initialActive ??= initialInstall;
      if (initialInstall?.state === "redundant" && !initialActive && !initialController) {
        // A failed first installation must not turn its successor into an update.
        initialInstall = registration.installing ?? registration.waiting;
        if (initialInstall?.state === "redundant") initialInstall = null;
      }
      const relevant = new Set(
        [
          registration.installing,
          registration.waiting,
          registration.active,
          serviceWorker.controller,
          attempt?.worker,
          late,
        ].filter((worker): worker is ServiceWorker => !!worker),
      );
      for (const worker of relevant) {
        if (!observed.has(worker)) {
          observed.add(worker);
          worker.addEventListener("statechange", reconcile);
        }
      }
      for (const worker of observed) {
        if (!relevant.has(worker)) {
          worker.removeEventListener("statechange", reconcile);
          observed.delete(worker);
        }
      }
      const lateActivation = late?.state === "activated" && registration.active === late;
      if (late?.state === "redundant" || late?.state === "activated") late = null;
      const current = attempt;
      if (current?.worker) {
        const approved = current.worker;
        const replacement =
          [registration.installing, registration.waiting].some(
            (worker) => worker && worker !== approved && worker.state !== "redundant",
          ) ||
          (registration.active &&
            registration.active !== approved &&
            registration.active !== current.previousActive &&
            registration.active.state !== "redundant");
        const present = [
          registration.installing,
          registration.waiting,
          registration.active,
          serviceWorker.controller,
        ].includes(approved);
        if (approved.state === "redundant" || replacement || !present) {
          late = approved.state !== "redundant" && approved.state !== "activated" ? approved : null;
          endAttempt();
          notice(
            available()
              ? "A newer update is available. Select Update Libras again to reload. This interrupts playback."
              : "This update is no longer available. You can keep using the app.",
          );
          return;
        }
        if (approved.state === "activated") reload(current);
        return;
      }
      if (current) return;
      if (available()) {
        if (lateActivation) {
          notice(
            "A new version is ready. Select Update Libras to reload. This interrupts playback.",
          );
        } else if (state.status !== "error" || !state.retry) {
          // Preserve actionable recovery explanations until availability changes.
          state = { status: "ready" };
        }
      } else if (state.status === "ready" || (state.status === "error" && state.retry)) {
        notice("This update is no longer available. You can keep using the app.");
      }
    };
    apply = () => {
      if (lifetime.signal.aborted || attempt) return;
      reconcile();
      if (!available()) return;
      const current: Attempt = {
        worker: waiting(),
        previousActive: registration?.active ?? null,
        reloaded: false,
      };
      attempt = current;
      state = { status: "updating" };
      current.timer = setTimeout(() => {
        if (attempt !== current || lifetime.signal.aborted) return;
        late = current.worker;
        endAttempt();
        // Reconcile without approval: late completion must never reload this tab.
        reconcile();
        notice(
          waiting()
            ? "The update is taking too long. Try Update Libras again. Reloading interrupts playback."
            : activated()
              ? "The app did not reload. Select Update Libras again. This interrupts playback."
              : "The update could not be completed and is no longer available. You can keep using the app.",
        );
      }, 15_000);
      try {
        if (current.worker) {
          // Consent belongs to this worker identity, not the stable sw.js URL.
          current.worker.postMessage({ type: "SKIP_WAITING" });
          reconcile();
        } else reload(current);
      } catch {
        if (attempt !== current) return;
        late = current.worker;
        endAttempt();
        reconcile();
        notice(
          available()
            ? "The update could not be applied. Try Update Libras again. Reloading interrupts playback."
            : "This update is no longer available. You can keep using the app.",
        );
      }
    };
    const check = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || !registration) return;
      try {
        await registration.update();
      } catch {
        // Routine failed checks must not interrupt playback or hide a waiting update.
      } finally {
        reconcile();
      }
    };
    const register = async () => {
      try {
        const value = await serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
          scope: import.meta.env.BASE_URL,
          type: "classic",
        });
        if (lifetime.signal.aborted) return;
        registration = value;
        // Registration can resolve after another tab replaces our controller.
        // Only an initially uncontrolled page needs the returned active baseline.
        initialActive = initialController ?? value.active;
        if (!initialActive && !initialController)
          initialInstall = value.installing ?? value.waiting;
        value.addEventListener(
          "updatefound",
          () => {
            if (!initialActive && !initialController && !initialInstall)
              initialInstall = value.installing;
            reconcile();
          },
          { signal: lifetime.signal },
        );
        reconcile();
      } catch {
        if (!lifetime.signal.aborted) {
          notice("Offline app setup failed. You can keep using the app online.");
        }
      }
    };
    serviceWorker.addEventListener("controllerchange", reconcile, { signal: lifetime.signal });
    document.addEventListener("visibilitychange", check, { signal: lifetime.signal });
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true, signal: lifetime.signal });
    const timer = setInterval(check, 60 * 60 * 1000);
    return () => {
      lifetime.abort();
      clearInterval(timer);
      endAttempt();
      for (const worker of observed) worker.removeEventListener("statechange", reconcile);
      observed.clear();
      apply = () => {};
    };
  });

  export function getStatus() {
    return { hasUpdate, busy, message, failed: state.status === "error" };
  }

  export async function update() {
    if (!hasUpdate || busy) return;
    apply();
  }
</script>

<span class="visually-hidden" role="status" aria-atomic="true">{message}</span>

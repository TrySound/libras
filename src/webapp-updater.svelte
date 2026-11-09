<script lang="ts">
  import { onMount } from "svelte";

  type UpdaterState =
    | { status: "idle" }
    | { status: "ready" }
    | { status: "updating" }
    // Retry kind preserves recovery copy until actionable availability changes.
    | { status: "error"; message: string; retry: false | "waiting" | "reload" };

  let state = $state<UpdaterState>({ status: "idle" });
  let apply = () => {};
  const busy = $derived(state.status === "updating");
  const hasUpdate = $derived(
    state.status === "ready" || busy || (state.status === "error" && !!state.retry),
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
    // Never adopt a replacement for a known mount-time controller. For an
    // uncontrolled document, conservatively baseline the first successful active worker.
    let baseline = serviceWorker.controller;
    const observed = new Set<ServiceWorker>();
    type Attempt = {
      deadline: number;
      messaged?: ServiceWorker;
      reloaded: boolean;
      timer?: ReturnType<typeof setTimeout>;
    };
    let attempt: Attempt | undefined;
    const active = () => registration?.active ?? serviceWorker.controller;
    const waiting = () => {
      const worker = registration?.waiting;
      return baseline && worker?.state === "installed" && worker !== baseline ? worker : null;
    };
    const activated = () => active()?.state === "activated" && active() !== baseline;
    const available = () =>
      waiting() ? ("waiting" as const) : activated() ? ("reload" as const) : false;
    const notice = (message: string) => {
      state = { status: "error", message, retry: available() };
    };
    const endAttempt = () => {
      if (attempt) clearTimeout(attempt.timer);
      attempt = undefined;
    };
    const expire = () => {
      endAttempt();
      // Reconcile current slots without approval: late completion requires a click.
      reconcile();
      notice(
        waiting()
          ? "The update is taking too long. Try Update Libras again. Reloading interrupts playback."
          : activated()
            ? "The app did not reload. Select Update Libras again. This interrupts playback."
            : "The update is taking too long. You can keep using the app.",
      );
    };
    const reconcile = () => {
      if (lifetime.signal.aborted || !registration) return;
      const relevant = [
        registration.installing,
        registration.waiting,
        registration.active,
        serviceWorker.controller,
      ].filter((worker): worker is ServiceWorker => !!worker);
      for (const worker of relevant) {
        if (!observed.has(worker)) {
          observed.add(worker);
          worker.addEventListener("statechange", reconcile);
        }
      }
      for (const worker of observed) {
        if (!relevant.includes(worker)) {
          worker.removeEventListener("statechange", reconcile);
          observed.delete(worker);
        }
      }
      if (!baseline && active()?.state === "activated") baseline = active();
      const current = attempt;
      if (!current) {
        const retry = available();
        if (retry) {
          if (state.status !== "error" || state.retry !== retry) state = { status: "ready" };
        } else if (state.status === "ready" || (state.status === "error" && state.retry)) {
          if (registration.installing || active()?.state === "activating") {
            // Progress without approval is not proof that the update was lost.
            state = { status: "idle" };
          } else notice("This update is no longer available. You can keep using the app.");
        }
        return;
      }
      // A suspended page can receive lifecycle events before its overdue timer runs.
      if (Date.now() >= current.deadline) {
        expire();
        return;
      }
      if (current.reloaded) return; // Watchdog remains until navigation destroys this page.
      try {
        const next = waiting();
        if (next) {
          // Identity only deduplicates messages; approval covers installed replacements
          // throughout this one fixed attempt, without extending its deadline.
          if (current.messaged !== next) {
            current.messaged = next;
            next.postMessage({ type: "SKIP_WAITING" });
            reconcile();
          }
        } else if (active()?.state === "activating") {
          // controllerchange may precede completed activation.
        } else if (activated()) {
          // A completed update is usable even if a still newer download is installing.
          current.reloaded = true;
          location.reload();
        } else if (!registration.installing || registration.installing.state === "redundant") {
          endAttempt();
          notice("This update is no longer available. You can keep using the app.");
        }
      } catch {
        if (attempt !== current) return;
        endAttempt();
        notice(
          available()
            ? "The update could not be applied. Try Update Libras again. Reloading interrupts playback."
            : "This update is no longer available. You can keep using the app.",
        );
      }
    };
    apply = () => {
      if (lifetime.signal.aborted || attempt) return;
      reconcile();
      if (!available()) return;
      const current: Attempt = { deadline: Date.now() + 15_000, reloaded: false };
      attempt = current;
      state = { status: "updating" };
      current.timer = setTimeout(() => {
        if (attempt !== current || lifetime.signal.aborted) return;
        expire();
      }, 15_000);
      reconcile();
    };
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      reconcile();
      if (!navigator.onLine || !registration) return;
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
        value.addEventListener("updatefound", reconcile, { signal: lifetime.signal });
        reconcile();
      } catch {
        if (!lifetime.signal.aborted) {
          state = {
            status: "error",
            retry: false,
            message: "Offline app setup failed. You can keep using the app online.",
          };
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

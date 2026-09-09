<script lang="ts">
  import { onMount } from "svelte";
  import { registerSW } from "virtual:pwa-register";

  type UpdaterState =
    | { status: "idle" }
    | { status: "ready" }
    | { status: "updating" }
    | { status: "error"; message: string; retry: boolean };

  let state = $state<UpdaterState>({ status: "idle" });
  let registration: ServiceWorkerRegistration | undefined;
  let updateServiceWorker: () => Promise<void>;
  let updateTimeout: ReturnType<typeof setTimeout> | undefined;
  let reloadAvailable = false;

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
            "An app update is ready in Settings. Updating reloads the app and interrupts playback.",
          updating: "Applying the update. The app will reload when it is ready.",
        }[state.status],
  );

  function reloadHome() {
    const url = new URL(window.location.href);
    url.hash = "/library";
    window.history.replaceState(window.history.state, "", url);
    window.location.reload();
  }

  onMount(() => {
    const lifetime = new AbortController();
    const serviceWorker = navigator.serviceWorker;
    let controller = serviceWorker?.controller;
    const syncAvailability = () => {
      if (lifetime.signal.aborted || busy) return;
      // Workbox can also announce an external installation that is already current.
      if (registration?.waiting || reloadAvailable) state = { status: "ready" };
      else if (hasUpdate) state = { status: "idle" };
    };
    const controlled = () => {
      if (lifetime.signal.aborted) return;
      const next = serviceWorker?.controller;
      if (!next || next === controller) return;
      const previous = controller;
      controller = next;
      if (busy) {
        reloadAvailable = true;
        reloadHome();
      } else {
        // Initial installation claims this page without requiring an update/reload.
        if (previous) reloadAvailable = true;
        syncAvailability();
      }
    };
    // The plugin's reload callback is conditional on Workbox's isUpdate heuristic.
    serviceWorker?.addEventListener("controllerchange", controlled, { signal: lifetime.signal });
    updateServiceWorker = registerSW({
      onNeedRefresh: syncAvailability,
      onNeedReload() {
        // Native controllerchange handles activation; suppress the plugin's default reload.
      },
      onRegisteredSW(_url, value) {
        if (lifetime.signal.aborted) return;
        registration = value;
        syncAvailability();
      },
      onRegisterError() {
        if (lifetime.signal.aborted || hasUpdate) return;
        state = {
          status: "error",
          message: "Offline app setup failed. You can keep using the app online.",
          retry: false,
        };
      },
    });
    const check = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void registration?.update().catch(() => {
          // A failed update check must not interrupt playback or offline use.
        });
      }
    };
    document.addEventListener("visibilitychange", check, { signal: lifetime.signal });
    const timer = setInterval(check, 60 * 60 * 1000);
    return () => {
      lifetime.abort();
      clearInterval(timer);
      clearTimeout(updateTimeout);
      updateTimeout = undefined;
    };
  });

  export function getStatus() {
    return { hasUpdate, busy, message };
  }

  export async function update() {
    if (!hasUpdate || busy) return;
    if (!registration?.waiting && !reloadAvailable) {
      state = { status: "idle" };
      return;
    }
    state = { status: "updating" };
    const fail = (cause: unknown) => {
      if (updateTimeout !== timeout) return;
      clearTimeout(timeout);
      updateTimeout = undefined;
      state = {
        status: "error",
        message:
          cause instanceof Error
            ? cause.message
            : "The update could not be applied. Please try again.",
        retry: true,
      };
    };
    const timeout = setTimeout(() => {
      fail(new Error("The update is taking too long. Please try again or reopen the app."));
    }, 15_000);
    updateTimeout = timeout;
    try {
      // Another tab may have activated the update before this click.
      if (!registration?.waiting) {
        reloadHome();
      } else {
        await updateServiceWorker();
      }
      // Keep the watchdog until navigation: this promise only sends SKIP_WAITING.
    } catch (cause) {
      fail(cause);
    }
  }
</script>

<span class="visually-hidden" role="status" aria-atomic="true">{message}</span>

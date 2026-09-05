<script lang="ts">
  import { onMount } from "svelte";
  import { registerSW } from "virtual:pwa-register";

  let available = $state(false);
  let dismissed = $state(false);
  let updating = $state(false);
  let error = $state("");
  let activated = false;
  let approved = false;
  let updateServiceWorker: () => Promise<void> = async () => {};

  onMount(() => {
    let registration: ServiceWorkerRegistration | undefined;
    updateServiceWorker = registerSW({
      onNeedRefresh() {
        available = true;
        dismissed = false;
      },
      onNeedReload() {
        activated = true;
        if (approved) window.location.reload();
        else {
          available = true;
          dismissed = false;
        }
      },
      onRegisteredSW(_url, value) {
        registration = value;
      },
      onRegisterError() {
        error = "Offline app setup failed. You can keep using the app online.";
        dismissed = false;
      },
    });
    const check = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void registration?.update().catch(() => {
          // A failed update check must not interrupt playback or offline use.
        });
      }
    };
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, 60 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  });

  async function update() {
    approved = true;
    updating = true;
    error = "";
    if (activated) {
      window.location.reload();
      return;
    }
    try {
      await updateServiceWorker();
    } catch {
      approved = false;
      updating = false;
      error = "The update could not be applied. Please try again.";
    }
  }
</script>

{#if !dismissed && (available || error)}
  <aside class="pwa-update stack-sm" aria-label="App update">
    <p class="type-small" role="status">
      {error || "An app update is ready. Updating reloads the app and interrupts playback."}
    </p>
    <div class="pwa-update-actions">
      {#if available}
        <button class="button" type="button" data-size="sm" data-variant="neutral" disabled={updating} onclick={update}>
          {updating ? "Updating…" : "Update now"}
        </button>
      {/if}
      <button class="button" type="button" data-size="sm" data-variant="neutral" disabled={updating} onclick={() => { dismissed = true; }}>
        {available ? "Later" : "Dismiss"}
      </button>
    </div>
  </aside>
{/if}

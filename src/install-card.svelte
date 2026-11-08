<script lang="ts">
  import type { InstallController, InstallState } from "./install.svelte";

  let { installation }: { installation: InstallController } = $props();
  let instructions: HTMLElement;
  let action: HTMLButtonElement | undefined = $state();
  const messages: Record<InstallState, string> = {
    unavailable:
      "An installation prompt isn’t available here. Installation options depend on your browser and device.",
    available: "Add Libras as an app on this device.",
    pending: "Opening installation prompt…",
    accepted: "Installation accepted in your browser.",
    dismissed: "Installation dismissed.",
    failed: "The installation prompt couldn’t be opened.",
    installed: "Your browser reported that Libras was installed.",
    standalone: "Running as an app.",
  };

  $effect.pre(() => {
    // Recover focus before the action is detached, but never move unrelated focus.
    if (
      installation.state !== "available" &&
      installation.state !== "pending" &&
      action &&
      document.activeElement === action
    )
      instructions?.focus();
  });
</script>

<section class="card stack-md" aria-labelledby="install-title">
  <h2 class="heading-md uppercase" id="install-title">Install Libras</h2>
  <p class="body" role="status">{messages[installation.state]}</p>
  {#if installation.state === "available" || installation.state === "pending"}
    <div>
      <button
        type="button"
        class="button"
        data-size="text"
        data-variant="secondary"
        aria-disabled={installation.state === "pending"}
        onclick={installation.install}
        bind:this={action}>Install Libras</button
      >
    </div>
  {/if}
  <details class="body">
    <summary bind:this={instructions}>Installation instructions</summary>
    <div class="stack-md">
      <p class="body">On iPhone:</p>
      <ol>
        <li>Open this player in Safari.</li>
        <li>Choose Share → Add to Home Screen.</li>
        <li>If shown, turn on Open as Web App, then tap Add.</li>
      </ol>
      <p class="body">
        Share may be inside Safari’s menu, depending on its layout. If Add to Home Screen is
        missing, check Edit Actions. If it isn’t available here, open this player in Safari and
        follow these steps.
      </p>
      <p class="body">
        On other devices, check your browser’s menu for installation options. Not every browser or
        device offers installation.
      </p>
    </div>
  </details>
  <p class="caption text-secondary">
    Installation does not guarantee downloads continue while the device is locked. Saved data may
    still be removed by the browser or operating system.
  </p>
</section>

<style>
  ol {
    margin-block: 0;
  }
</style>

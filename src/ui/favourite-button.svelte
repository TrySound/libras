<script lang="ts">
  import { getContext, onMount } from "svelte";
  import type { Favourites } from "../favourites.svelte";
  import type { FavouriteTarget } from "../schema";
  import Icon from "../icon.svelte";
  import Loader from "./loader.svelte";

  let { target, overlayId }: { target: FavouriteTarget | undefined; overlayId: string } = $props();
  const descriptionId = $props.id();
  const favourites = getContext<Favourites | undefined>("favourites");
  const selected = $derived(target ? (favourites?.has(target) ?? false) : false);
  const pending = $derived(
    target ? (favourites?.pending.has(favourites.key(target)) ?? false) : false,
  );
  const reason = $derived(
    !favourites?.available
      ? "Reconnect in Settings to edit favourites."
      : favourites.outcomeUnknown
        ? "Outcome unknown; refresh in Settings before editing favourites."
        : target
          ? favourites.targetError(target)
          : "",
  );
  let error = $state("");
  let lifetime = 0;
  let overlay: HTMLElement | null = null;
  let invoker: HTMLElement | null = null;
  const visible = (element: HTMLElement | null) =>
    !!element?.isConnected && element.checkVisibility();
  const opened = () =>
    overlay instanceof HTMLDialogElement ? overlay.open : !!overlay?.matches(":popover-open");
  function dismiss() {
    if (overlay instanceof HTMLDialogElement) overlay.close();
    else overlay?.hidePopover();
  }
  function restoreFocus() {
    const fallback = document.querySelector<HTMLElement>("#library-search, main h1");
    const destination = visible(invoker) ? invoker : fallback;
    if (destination && visible(destination)) {
      if (!destination.matches("input, button, a[href], [tabindex]")) destination.tabIndex = -1;
      destination.focus({ preventScroll: true });
    }
  }
  $effect(() => {
    void target?.kind;
    void target?.id;
    lifetime++;
    error = "";
  });
  onMount(() => {
    overlay = document.getElementById(overlayId);
    const change = (event: Event) => {
      lifetime++;
      error = "";
      if ((event as ToggleEvent).newState === "open") {
        invoker =
          ((event as ToggleEvent).source as HTMLElement | null) ??
          (document.activeElement as HTMLElement);
      }
    };
    overlay?.addEventListener("beforetoggle", change);
    return () => {
      lifetime++;
      overlay?.removeEventListener("beforetoggle", change);
    };
  });
  async function submit() {
    if (!favourites || !target || pending || reason) return;
    const submitted = { ...target };
    const opening = lifetime;
    error = "";
    try {
      await favourites.toggle(submitted);
      if (opening !== lifetime || !opened()) return;
      dismiss();
      restoreFocus();
    } catch (cause) {
      if (
        opening !== lifetime ||
        !opened() ||
        (cause instanceof DOMException && cause.name === "AbortError")
      )
        return;
      error = cause instanceof Error ? cause.message : "Could not update favourites.";
    }
  }
</script>

{#if favourites && target}
  <button
    class="menu-item"
    aria-pressed={selected}
    aria-busy={pending}
    disabled={!!reason || pending}
    aria-describedby={reason || error ? descriptionId : undefined}
    onclick={submit}
  >
    {#if pending}<Loader />{:else}<Icon name="favourite" />{/if}
    <span
      >{pending
        ? favourites.intentions.get(favourites.key(target))
          ? "Adding to favourites…"
          : "Removing from favourites…"
        : selected
          ? "Remove from favourites"
          : "Add to favourites"}</span
    >
  </button>
  {#if reason || error}
    <p
      id={descriptionId}
      class="caption"
      style:color={error ? "var(--error-text)" : undefined}
      aria-live="polite"
    >
      {error || reason}
      <a
        href="?/settings"
        onclick={() => {
          dismiss();
          // Now Playing contains its Actions popover inside a modal dialog.
          overlay?.parentElement?.closest("dialog")?.close();
        }}>Open settings</a
      >
    </p>
  {/if}
{/if}

<style>
  /* A submitted operation is busy, not unavailable. Keep its progress readable. */
  .menu-item[aria-busy="true"]:disabled {
    opacity: 1;
    cursor: wait;
  }
</style>

<script lang="ts">
  import type { Favourites } from "../favourites.svelte";
  import type { FavouriteTarget } from "../schema";
  import Icon from "../icon.svelte";

  let {
    favourites,
    target,
    icon = false,
    describedby,
  }: {
    favourites: Favourites;
    target: FavouriteTarget | undefined;
    icon?: boolean;
    describedby?: string;
  } = $props();
  const descriptionId = $props.id();
  const targetKey = $derived(target ? favourites.key(target) : undefined);
  const selected = $derived(target ? favourites.has(target) : false);
  const pending = $derived(targetKey !== undefined && favourites.pending.has(targetKey));
  const reason = $derived(
    !target
      ? ""
      : !favourites.available
        ? "Reconnect in Settings to edit favourites."
        : favourites.outcomeUnknown
          ? "Outcome unknown; refresh in Settings before editing favourites."
          : favourites.targetError(target),
  );
  async function submit() {
    if (!target || pending || reason) return;
    try {
      await favourites.toggle({ ...target });
    } catch {
      // The engine owns failures; the app's global error message displays them.
    }
  }
</script>

{#if target || icon}
  <button
    type="button"
    class={icon ? "button" : "menu-item"}
    data-variant={icon ? "secondary" : undefined}
    aria-label={icon ? "Favourite current track" : undefined}
    aria-pressed={selected}
    aria-busy={pending}
    disabled={!target || !!reason || pending}
    title={reason || undefined}
    aria-describedby={[describedby, reason ? descriptionId : undefined].filter(Boolean).join(" ") ||
      undefined}
    onclick={submit}
  >
    <Icon name="favourite" class="favourite-icon" />
    {#if !icon}
      <span>{selected ? "Remove from favourites" : "Add to favourites"}</span>
    {/if}
  </button>
  {#if reason}
    <span id={descriptionId} class="visually-hidden">{reason}</span>
  {/if}
{/if}

<style>
  button[aria-busy="true"]:disabled {
    opacity: 1;
    cursor: wait;
  }
</style>

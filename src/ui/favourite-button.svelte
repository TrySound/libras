<script lang="ts">
  import { getContext } from "svelte";
  import type { Favourites } from "../favourites.svelte";
  import type { FavouriteTarget } from "../schema";
  let { target }: { target: FavouriteTarget } = $props();
  const descriptionId = $props.id();
  const favourites = getContext<Favourites | undefined>("favourites");
  const selected = $derived(favourites?.has(target) ?? false);
  const pending = $derived(favourites?.pending.has(favourites.key(target)) ?? false);
  const reason = $derived(
    favourites?.targetError(target) ||
      (!favourites?.available
        ? "Reconnect to edit favourites."
        : favourites.outcomeUnknown
          ? "Outcome unknown; refresh favourites before retrying."
          : ""),
  );
  let error = $state("");
</script>

{#if favourites}
  <div class="stack-xs">
    <button
      class="button"
      data-size="text"
      data-variant="secondary"
      aria-pressed={selected}
      aria-busy={pending}
      disabled={!!reason || pending}
      aria-describedby={reason ? descriptionId : undefined}
      onclick={async () => {
        error = "";
        try {
          await favourites.toggle(target);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : "Could not save favourite. Retry.";
        }
      }}
    >
      {pending
        ? selected
          ? "Removing…"
          : "Adding…"
        : selected
          ? "★ Remove from favourites"
          : "☆ Add to favourites"}
    </button>
    {#if reason}<span id={descriptionId} class="caption text-secondary">{reason}</span>{/if}
    {#if error}<p class="caption" role="alert">{error} Refresh favourites on Home to retry.</p>{/if}
  </div>
{/if}

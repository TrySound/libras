<script lang="ts">
  import type { Cache } from "../cache.svelte";
  import type { Favourites } from "../favourites.svelte";
  import type { FavouriteTarget } from "../schema";
  import Icon from "../icon.svelte";
  import Loader from "./loader.svelte";

  let {
    favourites,
    cache,
    target,
    icon = false,
    describedby,
    onsettings,
  }: {
    favourites: Favourites;
    cache: Cache;
    target: FavouriteTarget | undefined;
    icon?: boolean;
    describedby?: string;
    onsettings?: () => void;
  } = $props();
  const descriptionId = $props.id();
  const targetKey = $derived(target ? favourites.key(target) : undefined);
  const selected = $derived(target ? favourites.has(target) : false);
  const pending = $derived(targetKey !== undefined && favourites.pending.has(targetKey));
  const progress = $derived(
    pending
      ? favourites.pending.get(targetKey!)
        ? "Adding to favourites…"
        : "Removing from favourites…"
      : "",
  );
  const reason = $derived(
    !target
      ? ""
      : !favourites.available
        ? "Reconnect in Settings to edit favourites."
        : favourites.outcomeUnknown
          ? "Outcome unknown; refresh in Settings before editing favourites."
          : favourites.targetError(target),
  );
  let failure = $state.raw<{
    favourites: Favourites;
    cache: Cache;
    key: string;
    message: string;
  }>();
  const error = $derived(
    failure?.favourites === favourites && failure.cache === cache && failure.key === targetKey
      ? failure.message
      : "",
  );
  async function submit() {
    if (!target || pending || reason) return;
    const submitted = { ...target };
    const engine = favourites;
    const owner = cache;
    const key = engine.key(submitted);
    failure = undefined;
    try {
      await engine.toggle(submitted);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      failure = {
        favourites: engine,
        cache: owner,
        key,
        message: cause instanceof Error ? cause.message : "Could not update favourites.",
      };
    }
  }
</script>

{#if target || icon}
  <button
    type="button"
    class={icon ? "button" : "menu-item"}
    data-variant={icon ? (selected ? "primary" : "secondary") : undefined}
    aria-label={icon ? "Favourite current track" : undefined}
    aria-pressed={selected}
    aria-busy={pending}
    disabled={!target || !!reason || pending}
    aria-describedby={[
      describedby,
      reason || error || (icon && pending) ? descriptionId : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined}
    onclick={submit}
  >
    {#if pending}<Loader />{:else}<Icon name="favourite" />{/if}
    {#if !icon}<span>{progress || (selected ? "Remove from favourites" : "Add to favourites")}</span
      >{/if}
  </button>
  {#if target && (reason || error || (icon && pending))}
    <div class="favourite-feedback stack-xs caption">
      <p
        id={descriptionId}
        style:color={error ? "var(--error-text)" : undefined}
        aria-live={error ? "polite" : undefined}
      >
        {error || reason || progress}
      </p>
      {#if reason || error}
        <a
          href="?/settings"
          onclick={(event) => {
            if (onsettings) onsettings();
            else {
              event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
              event.currentTarget.closest("dialog")?.close();
            }
          }}>Open settings</a
        >
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* Busy progress remains readable while duplicate submission is disabled. */
  button[aria-busy="true"]:disabled {
    opacity: 1;
    cursor: wait;
  }
</style>

<script lang="ts" generics="T extends { id: string }">
  import { onMount, tick, type Snippet } from "svelte";

  let {
    items,
    row,
    pinnedId,
  }: {
    items: readonly T[];
    row: Snippet<[T]>;
    pinnedId?: string;
  } = $props();

  // Natural rows start near 65px, plus the shared 8px inter-row gap.
  const estimate = 65 + 8;
  let list: HTMLUListElement;
  let top = $state(0);
  let viewport = $state(800);
  let focusedId = $state<string>();
  let requested = $state<number>();
  let heights = $state.raw(new Map<string, number>());
  let observer: ResizeObserver | undefined;
  const offsets = $derived.by(() => {
    const values = [0];
    for (const item of items)
      values.push(values[values.length - 1] + (heights.get(item.id) ?? estimate));
    return values;
  });
  function at(y: number) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid + 1] < y) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  const visible = $derived.by(() => {
    const first = Math.max(0, at(top) - 5);
    const last = Math.min(items.length, at(top + viewport) + 6);
    const indices = new Set<number>();
    for (let i = first; i < last; i++) indices.add(i);
    for (const id of [focusedId, pinnedId]) {
      if (id === undefined) continue;
      const i = items.findIndex((item) => item.id === id);
      if (i >= 0) indices.add(i);
    }
    if (requested !== undefined && requested >= 0 && requested < items.length)
      indices.add(requested);
    return [...indices].sort((a, b) => a - b);
  });

  function updateViewport() {
    top = -list.getBoundingClientRect().top;
    viewport = window.innerHeight;
  }

  function applyMeasurements(next: Map<string, number>) {
    // Keep the first visible record stationary when wrapping changes rows above it.
    // Native anchoring cannot do this reliably for absolutely positioned children.
    const anchor = Math.min(items.length, at(Math.max(0, top)));
    const oldOffset = offsets[anchor];
    let newOffset = 0;
    for (let i = 0; i < anchor; i++) newOffset += next.get(items[i].id) ?? estimate;
    heights = next;
    if (top > 0 && newOffset !== oldOffset) window.scrollBy(0, newOffset - oldOffset);
    updateViewport();
  }

  function measure(node: HTMLLIElement) {
    observer?.observe(node);
    return {
      destroy() {
        observer?.unobserve(node);
      },
    };
  }

  onMount(() => {
    observer = new ResizeObserver((entries) => {
      const next = new Map(heights);
      for (const entry of entries) {
        const node = entry.target as HTMLLIElement;
        next.set(
          node.dataset.id!,
          entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height,
        );
      }
      applyMeasurements(next);
    });
    list.querySelectorAll<HTMLLIElement>("li").forEach((node) => observer!.observe(node));
    let width = list.clientWidth;
    const resize = new ResizeObserver(() => {
      if (list.clientWidth !== width) {
        width = list.clientWidth;
        // Mounted rows are measured again even when their own height did not change.
        const next = new Map<string, number>();
        list
          .querySelectorAll<HTMLLIElement>("li")
          .forEach((node) => next.set(node.dataset.id!, node.getBoundingClientRect().height));
        applyMeasurements(next);
      }
      updateViewport();
    });
    resize.observe(list);
    updateViewport();
    window.addEventListener("scroll", updateViewport, { passive: true });
    window.addEventListener("resize", updateViewport);
    return () => {
      observer?.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  });

  function focusChanged() {
    const node = document.activeElement?.closest<HTMLLIElement>("li[data-id]");
    focusedId = node && list.contains(node) ? node.dataset.id : undefined;
  }

  async function tab(event: KeyboardEvent, index: number) {
    if (event.key !== "Tab") return;
    const node = event.currentTarget as HTMLLIElement;
    const controls = [
      ...node.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"),
    ].filter((control) => control.getClientRects().length > 0);
    const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
    const next = index + (event.shiftKey ? -1 : 1);
    if (event.target !== edge || next < 0 || next >= items.length) return;
    event.preventDefault();
    requested = next;
    await tick();
    const target = list.querySelector<HTMLLIElement>(`li[data-index="${next}"]`);
    const candidates = [
      ...(target?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []),
    ].filter((control) => control.getClientRects().length > 0);
    (event.shiftKey ? candidates[candidates.length - 1] : candidates[0])?.focus();
    requested = undefined;
  }
</script>

<ul
  bind:this={list}
  class="virtual-list"
  style:height={`${offsets[items.length]}px`}
  onfocusin={focusChanged}
  onfocusout={() => queueMicrotask(focusChanged)}
>
  {#each visible as i (items[i].id)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Delegated Tab handling bridges unmounted rows; the li itself is not focusable.) -->
    <li
      data-id={items[i].id}
      data-index={i}
      aria-posinset={i + 1}
      aria-setsize={items.length}
      style:top={`${offsets[i]}px`}
      use:measure
      onkeydown={(event) => tab(event, i)}
    >
      {@render row(items[i])}
    </li>
  {/each}
</ul>

<style>
  .virtual-list {
    position: relative;
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-anchor: none;
  }
  li {
    position: absolute;
    left: 0;
    right: 0;
    padding-bottom: 8px;
    box-sizing: border-box;
  }
</style>

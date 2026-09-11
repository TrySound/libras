// Observe cover handles through Svelte reactivity, not a separate event API.
export function observeCover(observe: () => void) {
  return $effect.root(() => {
    $effect(observe);
  });
}

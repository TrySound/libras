// Exercise cache consumers with real Svelte effects without a DOM renderer.
export function observeCache(observe: () => void) {
  return $effect.root(() => {
    $effect(observe);
  });
}

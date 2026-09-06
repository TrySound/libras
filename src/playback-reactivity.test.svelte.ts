// Exercise attachment-style setup inside a real Svelte effect, without a DOM renderer.
export function observePlayback(bind: () => () => void, observe: () => void) {
  return $effect.root(() => {
    $effect(() => bind());
    $effect(observe);
  });
}

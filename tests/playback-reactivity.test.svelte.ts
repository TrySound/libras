// Observe playback with a real Svelte effect, without a DOM renderer.
export function observePlayback(observe: () => void) {
  return $effect.root(() => {
    $effect(observe);
  });
}

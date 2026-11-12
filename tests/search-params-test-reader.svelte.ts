import { getSearchParameters } from "../src/router.svelte";

export function observeSearchParameters(read: (parameters: URLSearchParams) => void) {
  return $effect.root(() => {
    const parameters = $derived(getSearchParameters());
    $effect(() => read(parameters));
  });
}

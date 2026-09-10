<script module lang="ts">
  import type { Snippet } from "svelte";
  import type { RouteParams } from "./router-engine";

  export interface RouteControls {
    back(): void;
    href(path: string): string;
    navigate(path: string, history?: "push" | "replace"): void;
  }

  export interface RenderRoute {
    pattern: string;
    render: Snippet<[RouteParams, RouteControls]>;
  }

  export type RouterNavigate = RouteControls["navigate"];
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { RouterEngine } from "./router-engine";

  interface Props {
    routes: readonly RenderRoute[];
    fallback?: RenderRoute;
    navigate?: RouterNavigate;
  }

  let { routes, fallback = routes[0], navigate = $bindable() }: Props = $props();

  const engine = untrack(() => new RouterEngine(routes, fallback));
  const controls: RouteControls = {
    back: () => engine.back(),
    href: (path) => engine.href(path),
    navigate: (path, history) => engine.navigate(path, history),
  };
  let match = $derived(engine.match);
  navigate = controls.navigate;

  onMount(() => engine.start());
  onDestroy(() => engine.destroy());
</script>

{#if match}
  {@render match.route.render(match.params, controls)}
{/if}

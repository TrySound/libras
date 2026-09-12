<script module lang="ts">
  import type { Snippet } from "svelte";

  export type RouteParams = Record<string, string | undefined>;

  export interface RouteControls {
    /** Paths are slash-prefixed, without a hash. */
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
  import { onMount, tick, untrack } from "svelte";

  interface Props {
    routes: readonly RenderRoute[];
    fallback?: RenderRoute;
    navigate?: RouterNavigate;
    onNavigate?: () => void;
  }

  let { routes, fallback = routes[0], navigate = $bindable(), onNavigate }: Props = $props();

  const initial = untrack(() => {
    if (!fallback) throw new Error("Router requires at least one route.");
    return {
      fallback,
      compiled: routes.map((route) => ({
        route,
        pattern: new URLPattern({ hash: route.pattern }),
      })),
    };
  });
  let match = $state.raw<{ route: RenderRoute; params: RouteParams }>({
    route: initial.fallback,
    params: {},
  });

  function resolve(url: URL) {
    for (const { route, pattern } of initial.compiled) {
      const result = pattern.exec(url);
      if (!result) continue;
      return {
        route,
        params: Object.fromEntries(
          Object.entries(result.hash.groups).map(([name, value]) => [
            name,
            value === undefined ? undefined : decodeURIComponent(value),
          ]),
        ),
      };
    }
    return { route: initial.fallback, params: {} };
  }

  const controls: RouteControls = {
    href: (path) => `#${path}`,
    navigate(path, history = "push") {
      void window.navigation.navigate(controls.href(path), { history }).finished?.catch(() => {});
    },
  };
  navigate = controls.navigate;

  onMount(() => {
    const handleNavigation = (event: NavigateEvent) => {
      const destination = new URL(event.destination.url);
      if (
        !event.canIntercept ||
        event.navigationType === "reload" ||
        destination.origin !== window.location.origin ||
        !destination.hash.startsWith("#/")
      )
        return;

      event.intercept({
        handler: async () => {
          onNavigate?.();
          match = resolve(destination);
          // Let the browser restore scroll after Svelte renders the destination.
          await tick();
        },
      });
    };
    window.navigation.addEventListener("navigate", handleNavigation);
    if (window.location.hash.startsWith("#/")) {
      match = resolve(new URL(window.location.href));
    } else {
      controls.navigate(initial.fallback.pattern, "replace");
    }
    return () => window.navigation.removeEventListener("navigate", handleNavigation);
  });
</script>

{@render match.route.render(match.params, controls)}

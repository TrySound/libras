<script module lang="ts">
  import type { Snippet } from "svelte";

  export type RouteParams = Record<string, string | undefined>;

  /** Paths are slash-prefixed, without a hash. */
  export function navigate(path: string, history: "push" | "replace" = "push") {
    void window.navigation.navigate(`#${path}`, { history }).finished?.catch(() => {});
  }

  export interface RenderRoute {
    pattern: string;
    render: Snippet<[RouteParams]>;
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  interface Props {
    routes: readonly RenderRoute[];
    fallback?: RenderRoute;
    /** Leave the host page's scroll, focus, and view transitions alone. */
    embedded?: boolean;
  }

  let { routes, fallback = routes[0], embedded = false }: Props = $props();

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
        scroll: embedded ? "manual" : undefined,
        focusReset: embedded ? "manual" : undefined,
        handler: async () => {
          const update = async () => {
            if (event.signal?.aborted) return;
            match = resolve(destination);
            await tick();
          };
          if (
            embedded ||
            !document.startViewTransition ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ) {
            await update();
            return;
          }

          const transition = document.startViewTransition(async () => {
            await update();
            if (event.signal?.aborted) return;
            // Capture destination artwork at its final scroll position, including Back.
            event.scroll();
          });
          // Skipped/overlapping transitions must not turn into unhandled rejections.
          void transition.ready.catch(() => {});
          void transition.finished.catch(() => {});
          await transition.updateCallbackDone;
        },
      });
    };
    window.navigation.addEventListener("navigate", handleNavigation);
    if (window.location.hash.startsWith("#/")) {
      match = resolve(new URL(window.location.href));
    } else if (!embedded) {
      navigate(initial.fallback.pattern, "replace");
    }
    return () => window.navigation.removeEventListener("navigate", handleNavigation);
  });
</script>

{@render match.route.render(match.params)}

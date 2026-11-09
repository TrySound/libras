<script module lang="ts">
  import type { Snippet } from "svelte";

  export type RouteParams = Record<string, string | undefined>;

  /** Current route metadata, published reactively by the page's Router. */
  export const route = $state<{ pattern: string | undefined }>({ pattern: undefined });

  /** Match a navigation destination to the resolved page or a parent section. */
  export function isCurrentPage(path: string): boolean {
    return route.pattern === path || (route.pattern?.startsWith(`${path}/`) ?? false);
  }

  /** Paths are slash-prefixed; the query selects a page and the hash selects an anchor. */
  export function navigate(path: string, history: "push" | "replace" = "push") {
    const destination = new URL(`?${path}`, window.location.href);
    if (destination.href === window.location.href) return;
    void window.navigation.navigate(`?${path}`, { history }).finished?.catch(() => {});
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
  }

  let { routes, fallback = routes[0] }: Props = $props();

  // Route definitions are fixed for this Router instance.
  const defaultRoute = untrack(() => fallback);
  if (!defaultRoute) throw new Error("Router requires at least one route.");
  const compiled = untrack(() =>
    routes.map((route) => ({ route, pattern: new URLPattern({ pathname: route.pattern }) })),
  );

  const initialMatch = resolve(new URL(window.location.href));
  let match = $state.raw(initialMatch);
  route.pattern = initialMatch.route.pattern;

  function resolve(url: URL): { route: RenderRoute; params: RouteParams } {
    for (const { route, pattern } of compiled) {
      const result = pattern.exec({ pathname: url.search.slice(1) });
      if (!result) continue;
      return {
        route,
        params: Object.fromEntries(
          Object.entries(result.pathname.groups).map(([name, value]) => [
            name,
            value === undefined ? undefined : decodeURIComponent(value),
          ]),
        ),
      };
    }
    return { route: defaultRoute, params: {} };
  }

  function updateRoute(url: URL) {
    match = resolve(url);
    route.pattern = match.route.pattern;
  }

  onMount(() => {
    // The browser may have tried the initial fragment before Svelte rendered its target.
    void tick().then(() => {
      if (!window.location.hash) return;
      let id = window.location.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Malformed percent escapes can still be literal element IDs.
      }
      document.getElementById(id)?.scrollIntoView();
    });

    let activeTransition: ViewTransition | undefined;
    let captureOwner = 0;
    const handleNavigation = (event: NavigateEvent) => {
      const current = new URL(window.location.href);
      const destination = new URL(event.destination.url);
      if (
        !event.canIntercept ||
        event.navigationType === "reload" ||
        event.hashChange ||
        destination.origin !== current.origin ||
        destination.pathname !== current.pathname ||
        (destination.search !== "" && !destination.search.startsWith("?/"))
      )
        return;

      event.intercept({
        handler: async () => {
          const update = async () => {
            if (event.signal.aborted) return;
            updateRoute(destination);
            await tick();
          };
          if (
            destination.href === current.href ||
            !document.startViewTransition ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ) {
            await update();
            return;
          }

          // Claim the flag before skip can resolve the previous owner's finished promise.
          const owner = ++captureOwner;
          activeTransition?.skipTransition();
          // Stop hover/press motion and commit click-triggered names before capture.
          document.documentElement.dataset.routeTransition = "";
          await tick();
          if (owner !== captureOwner) return;
          if (event.signal.aborted) {
            activeTransition = undefined;
            delete document.documentElement.dataset.routeTransition;
            return;
          }

          const transition = document.startViewTransition(async () => {
            await update();
            if (event.signal.aborted) return;
            // Capture destination artwork at its final scroll position, including Back.
            event.scroll();
          });
          activeTransition = transition;
          const abort = () => transition.skipTransition();
          event.signal.addEventListener("abort", abort, { once: true });
          const cleanup = () => {
            event.signal.removeEventListener("abort", abort);
            if (owner !== captureOwner) return;
            activeTransition = undefined;
            delete document.documentElement.dataset.routeTransition;
          };
          // Skipped/overlapping transitions must not turn into unhandled rejections.
          void transition.ready.catch(() => {});
          void transition.finished.then(cleanup, cleanup);
          await transition.updateCallbackDone;
        },
      });
    };
    window.navigation.addEventListener("navigate", handleNavigation);
    return () => {
      window.navigation.removeEventListener("navigate", handleNavigation);
      ++captureOwner;
      activeTransition?.skipTransition();
      activeTransition = undefined;
      delete document.documentElement.dataset.routeTransition;
    };
  });
</script>

{@render match.route.render(match.params)}

<script module lang="ts">
  import type { Snippet } from "svelte";
  import { createSubscriber } from "svelte/reactivity";

  const subscribe = createSubscriber((update) => {
    const navigation = window.navigation;
    navigation.addEventListener("currententrychange", update);
    return () => navigation.removeEventListener("currententrychange", update);
  });

  let search: string | undefined;
  let parameters = new URLSearchParams();

  /** Complete committed query parameters. Treat the returned collection as read-only. */
  export function getSearchParameters(): URLSearchParams {
    subscribe();
    const url = new URL(window.navigation.currentEntry?.url ?? window.location.href);
    // Keep query identity across hash-only commits so local result batches do not reset.
    if (url.search !== search) {
      search = url.search;
      parameters = url.searchParams;
    }
    return parameters;
  }

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

  const initialUrl = new URL(window.location.href);
  const initialMatch = resolve(initialUrl);
  let match = $state.raw(initialMatch);
  route.pattern = initialMatch.route.pattern;

  function routePath(url: URL) {
    // Match the first raw token, not a decoded searchParams key: IDs may contain
    // encoded slashes/ampersands or literal plus signs. Only empty values are valid.
    const token = url.search.slice(1).split("&", 1)[0];
    const separator = token.indexOf("=");
    if (separator < 0) return token;
    return token.slice(separator + 1) === "" ? token.slice(0, separator) : undefined;
  }

  function resolve(url: URL): { route: RenderRoute; params: RouteParams } {
    const path = routePath(url);
    if (path === undefined) return { route: defaultRoute, params: {} };
    for (const { route, pattern } of compiled) {
      const result = pattern.exec({ pathname: path });
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

      const sameSearch = routePath(current) === "/search" && routePath(destination) === "/search";
      event.intercept({
        // Keep typing/toggle focus; leave scrolling and history restoration native.
        ...(sameSearch ? { focusReset: "manual" as const } : {}),
        handler: async () => {
          const update = async () => {
            if (event.signal.aborted) return;
            updateRoute(destination);
            await tick();
          };
          if (
            sameSearch ||
            destination.href === current.href ||
            !document.startViewTransition ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ) {
            await update();
            return;
          }

          // Commit click-triggered transition names before capturing the outgoing view.
          await tick();
          if (event.signal.aborted) return;

          const transition = document.startViewTransition(async () => {
            await update();
            if (event.signal.aborted) return;
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
    return () => window.navigation.removeEventListener("navigate", handleNavigation);
  });
</script>

{@render match.route.render(match.params)}

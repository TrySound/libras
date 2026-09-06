import { tick } from "svelte";
import { createSubscriber } from "svelte/reactivity";

export type RouteParams = Record<string, string | undefined>;

export interface RouteDefinition {
  pattern: string;
}

export interface RouteMatch<Route extends RouteDefinition> {
  params: RouteParams;
  route: Route;
}

interface CompiledRoute<Route extends RouteDefinition> {
  definition: Route;
  pattern: URLPattern;
}

export class RouterEngine<Route extends RouteDefinition> {
  #compiled: readonly CompiledRoute<Route>[];
  #fallback: Route;
  #match: RouteMatch<Route>;
  #started = false;
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });
  #handleNavigation = (event: NavigateEvent) => {
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
        this.#setMatch(destination);
        // Let the browser restore scroll after Svelte renders the destination.
        await tick();
      },
    });
  };

  constructor(routes: readonly Route[], fallback: Route = routes[0]) {
    if (!fallback) throw new Error("RouterEngine requires at least one route.");
    this.#compiled = routes.map((definition) => ({
      definition,
      pattern: new URLPattern({ hash: this.#path(definition.pattern) }),
    }));
    this.#fallback = fallback;
    this.#match = { route: fallback, params: {} };
  }

  get match() {
    this.#subscribe();
    return this.#match;
  }

  #path(path: string) {
    const withoutHash = path.startsWith("#") ? path.slice(1) : path;
    return withoutHash.startsWith("/") ? withoutHash : `/${withoutHash}`;
  }

  href(path: string) {
    return `#${this.#path(path)}`;
  }

  resolve(destination: string | URL): RouteMatch<Route> {
    const url = destination instanceof URL ? destination : new URL(destination);
    for (const route of this.#compiled) {
      const result = route.pattern.exec(url);
      if (!result) continue;
      return {
        route: route.definition,
        params: Object.fromEntries(
          Object.entries(result.hash.groups).map(([name, value]) => [
            name,
            value === undefined ? undefined : decodeURIComponent(value),
          ]),
        ),
      };
    }
    return { route: this.#fallback, params: {} };
  }

  #setMatch(destination: string | URL) {
    this.#match = this.resolve(destination);
    this.#update();
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    window.navigation.addEventListener("navigate", this.#handleNavigation);
    if (window.location.hash.startsWith("#/")) {
      this.#setMatch(window.navigation.currentEntry?.url ?? window.location.href);
    } else {
      this.navigate(this.#fallback.pattern, "replace");
    }
  }

  navigate(path: string, history: "push" | "replace" = "push") {
    void window.navigation.navigate(this.href(path), { history }).finished?.catch(() => {});
  }

  back() {
    if (window.navigation.canGoBack) {
      void window.navigation.back().finished?.catch(() => {});
    } else {
      this.navigate(this.#fallback.pattern, "replace");
    }
  }

  destroy() {
    if (!this.#started) return;
    this.#started = false;
    window.navigation.removeEventListener("navigate", this.#handleNavigation);
  }
}

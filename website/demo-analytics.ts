interface AnalyticsEvent {
  n: string;
  u: string;
  r?: string | null;
}

interface Plausible {
  (name: "pageview", options: { url: string }): void;
  init(options: {
    autoCapturePageviews: false;
    transformRequest(event: AnalyticsEvent): AnalyticsEvent;
  }): void;
}

function routeToken(url: URL): string {
  return url.search.slice(1).split("&", 1)[0].replace(/=$/, "") || "/library";
}

/** Match the router's first raw query token, but keep only the screen type. */
export function demoPageUrl(href: string): string {
  const url = new URL(href);
  const token = routeToken(url);
  let screen = "library";
  if (/^\/library\/artist\/[^/=]+$/.test(token)) screen = "artist";
  else if (/^\/library\/album\/[^/=]+$/.test(token)) screen = "album";
  else if (["/search", "/settings", "/downloads"].includes(token)) screen = token.slice(1);
  return new URL(screen, new URL("./", url)).href;
}

/** Called only by the demo entry, after its Navigation API polyfill is ready. */
export function trackDemoNavigation(): () => void {
  const analytics = window as Window & { plausible?: Plausible };
  if (!analytics.plausible) return () => {};

  analytics.plausible.init({
    autoCapturePageviews: false,
    transformRequest(event) {
      // Manual pageviews already have a sanitized URL; automatic events don't.
      if (event.n !== "pageview") event.u = demoPageUrl(event.u);
      if (event.r) {
        const referrer = new URL(event.r);
        referrer.search = "";
        referrer.hash = "";
        event.r = referrer.href;
      }
      return event;
    },
  });

  const navigation = window.navigation;
  let previousRoute: string | undefined;
  const track = () => {
    const href = navigation.currentEntry?.url ?? window.location.href;
    const route = routeToken(new URL(href));
    if (route === previousRoute) return;
    previousRoute = route;
    analytics.plausible?.("pageview", { url: demoPageUrl(href) });
  };
  navigation.addEventListener("currententrychange", track);
  track();
  return () => navigation.removeEventListener("currententrychange", track);
}

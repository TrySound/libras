import { vi } from "vitest";

export class TestURLPattern {
  #expression: RegExp;
  #names: string[] = [];

  constructor(init: URLPatternInit) {
    const source = String(init.pathname).replace(/:([A-Za-z]+)/g, (_, name: string) => {
      this.#names.push(name);
      return "([^/]+)";
    });
    this.#expression = new RegExp(`^${source}$`);
  }

  exec(input: URLPatternInit) {
    const match = this.#expression.exec(String(input.pathname));
    if (!match) return null;
    return {
      pathname: {
        groups: Object.fromEntries(this.#names.map((name, index) => [name, match[index + 1]])),
      },
    } as unknown as URLPatternResult;
  }
}

export function navigationEvent() {
  return Object.assign(new Event("navigate"), {
    signal: new AbortController().signal,
    hashChange: false,
  });
}

export function installNavigation(
  path = "/library",
  onNavigate: (path: string, history?: string) => void = () => {},
) {
  vi.stubGlobal("URLPattern", TestURLPattern);
  window.history.replaceState(null, "", `/?${path}`);
  const navigation = Object.assign(new EventTarget(), {
    currentEntry: { url: window.location.href },
    commit(href: string, updateLocation = true) {
      const url = new URL(href, window.location.href).href;
      navigation.currentEntry = { url };
      navigation.dispatchEvent(new Event("currententrychange"));
      if (updateLocation) window.history.replaceState(null, "", url);
    },
    // A navigation attempt is not a commit; tests explicitly choose when to commit.
    navigate: vi.fn((href: string, options: { history: string }) => {
      onNavigate(href.slice(1), options.history);
      return { finished: Promise.resolve() };
    }),
  });
  vi.stubGlobal("navigation", navigation);
  return navigation;
}

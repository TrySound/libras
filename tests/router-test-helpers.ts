import { vi } from "vitest";

export class TestURLPattern {
  #expression: RegExp;
  #names: string[] = [];

  constructor(init: URLPatternInit) {
    const source = String(init.hash).replace(/:([A-Za-z]+)/g, (_, name: string) => {
      this.#names.push(name);
      return "([^/]+)";
    });
    this.#expression = new RegExp(`^${source}$`);
  }

  exec(input: string | URL) {
    const match = this.#expression.exec(new URL(input).hash.slice(1));
    if (!match) return null;
    return {
      hash: {
        groups: Object.fromEntries(this.#names.map((name, index) => [name, match[index + 1]])),
      },
    } as unknown as URLPatternResult;
  }
}

export function installNavigation(
  path = "/library",
  onNavigate: (path: string, history?: string) => void = () => {},
) {
  vi.stubGlobal("URLPattern", TestURLPattern);
  window.history.replaceState(null, "", `#${path}`);
  const navigation = Object.assign(new EventTarget(), {
    navigate: vi.fn((href: string, options: { history: string }) => {
      onNavigate(href.slice(1), options.history);
      return { finished: Promise.resolve() };
    }),
  });
  vi.stubGlobal("navigation", navigation);
  return navigation;
}

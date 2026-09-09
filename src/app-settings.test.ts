// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./app.svelte";
import { createSession, credentials, deferred } from "./session-test-helpers";

const mocks = vi.hoisted(() => ({
  session: undefined as import("./session.svelte").Session | undefined,
  navigate: vi.fn(),
}));

vi.mock("./session.svelte", async (importOriginal) => {
  const { Session } = await importOriginal<typeof import("./session.svelte")>();
  return {
    Session: vi.fn(function (options: ConstructorParameters<typeof Session>[0]) {
      return mocks.session ?? new Session(options);
    }),
  };
});

// Keep these tests on the settings route; router behavior is tested separately.
vi.mock("./router-engine", () => ({
  RouterEngine: class {
    match;
    constructor(routes: { pattern: string }[]) {
      this.match = { route: routes.find((route) => route.pattern === "/settings"), params: {} };
    }
    start() {}
    destroy() {}
    back() {}
    href(path: string) {
      return `#${path}`;
    }
    navigate = mocks.navigate;
  },
}));

vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => {} }));

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  mocks.session = undefined;
  mocks.navigate.mockClear();
});

async function setup(saved = false) {
  const fixture = createSession(saved);
  fixture.session.start();
  if (saved) await vi.waitFor(() => expect(fixture.session.status).toBe("connected"));
  const target = document.createElement("main");
  document.body.append(target);
  mocks.session = fixture.session;
  const navigate = mocks.navigate;
  const component = mount(App, { target });
  flushSync();
  mocks.navigate.mockClear();
  cleanups.push(async () => {
    await unmount(component);
    fixture.session.destroy();
  });
  const button = (label: string) =>
    [...target.querySelectorAll("button")].find(
      (button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === label,
    )!;
  const offline = () => target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const fill = () => {
    const inputs = [...target.querySelectorAll<HTMLInputElement>("form input")];
    for (const [index, value] of [credentials.host, credentials.username, "password"].entries()) {
      inputs[index].value = value;
      inputs[index].dispatchEvent(new Event("input", { bubbles: true }));
    }
    target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
  };
  return { ...fixture, target, button, offline, fill, navigate };
}

describe("app settings", () => {
  it("shows read-only connection information and allows disconnect during refresh", async () => {
    const { target, session, auth, metadata, button, offline } = await setup(true);
    expect(target.textContent).toContain(credentials.host);
    expect(target.textContent).toContain(credentials.username);
    expect(target.querySelector("form")).toBeNull();
    const refresh = deferred();
    metadata.refresh.mockReturnValueOnce(refresh.promise);
    button("Refresh library").click();
    flushSync();
    expect(button("Refreshing…").disabled).toBe(true);
    button("Refreshing…").click();
    expect(metadata.refresh).toHaveBeenCalledOnce();
    button("Disconnect").click();
    flushSync();
    expect(auth.load()).toBeNull();
    expect(target.querySelector("form")).not.toBeNull();
    expect(
      [...target.querySelectorAll<HTMLInputElement>("form input")].map((input) => input.value),
    ).toEqual(["", "", ""]);
    expect(offline().checked).toBe(true);
    expect(offline().disabled).toBe(true);
    expect(target.textContent).toContain("Connect to a server to browse online.");
    refresh.resolve();
    await vi.waitFor(() => expect(session.status).toBe("disconnected"));
  });

  it("keeps Connect usable while forced offline, reports failures, and unlocks online mode on success", async () => {
    const { target, metadata, fill, button, offline, session, navigate } = await setup();
    expect(offline().checked).toBe(true);
    expect(offline().disabled).toBe(true);
    expect(button("Connect").disabled).toBe(false);
    metadata.prepareConnection.mockRejectedValueOnce(new Error("Unauthorized"));
    fill();
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toBe("Unauthorized"),
    );
    expect(offline().checked).toBe(true);
    expect(session.auth).toBeNull();
    fill();
    await vi.waitFor(() => expect(target.querySelector("form")).toBeNull());
    expect(offline().checked).toBe(false);
    expect(offline().disabled).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/library", undefined);
  });
});

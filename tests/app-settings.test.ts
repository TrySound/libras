// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/app.svelte";
import { registerSW } from "virtual:pwa-register";
import { installNavigation } from "./router-test-helpers";
import { createSession, credentials, deferred, snapshot } from "./session-test-helpers";

const mocks = vi.hoisted(() => ({
  session: undefined as import("../src/session.svelte").Session | undefined,
  navigate: vi.fn(),
}));

vi.mock("../src/session.svelte", async (importOriginal) => {
  const { Session } = await importOriginal<typeof import("../src/session.svelte")>();
  return {
    Session: vi.fn(function (options: ConstructorParameters<typeof Session>[0]) {
      return mocks.session ?? new Session(options);
    }),
  };
});

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn(() => async () => {}) }));

// Start these tests on the settings route; router behavior is tested separately.
beforeEach(() => {
  installNavigation("/settings", mocks.navigate);
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  mocks.session = undefined;
  mocks.navigate.mockClear();
  vi.mocked(registerSW).mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    await fixture.destroy();
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
  it("uses shared cards for server and offline settings", async () => {
    const { target } = await setup();
    expect(target.querySelector(".settings-view")?.classList.contains("container")).toBe(true);
    const server = target.querySelector('.card[aria-label="Music server"]')!;
    const offline = target.querySelector('.card[aria-label="Offline library"]')!;
    expect(server.classList.contains("stack-md")).toBe(true);
    expect(server.querySelector(":scope > .row-md > .stack-xs")?.textContent).toContain(
      "Disconnected",
    );
    expect(server.querySelector(":scope > form")).not.toBeNull();
    expect(offline.classList.contains("row-md")).toBe(true);
    expect(offline.querySelector(":scope > .stack-xs")?.textContent).toContain("Offline library");
    expect(offline.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(offline.querySelector("small")?.classList.contains("truncate")).toBe(false);
  });

  it("keeps the decorative status variant aligned with the connection label", async () => {
    const { target, session } = await setup(true);
    const indicator = target.querySelector(".status")!;
    const expectStatus = (variant: string, label?: string) => {
      flushSync();
      expect(target.querySelector(".status")?.getAttribute("data-variant")).toBe(variant);
      if (label)
        expect(target.querySelector('[aria-label="Music server"]')?.textContent).toContain(label);
    };
    expect(indicator.getAttribute("aria-hidden")).toBe("true");
    expect(indicator.hasAttribute("role")).toBe(false);
    expectStatus("success", "Connected");
    session.status = "error";
    expectStatus("danger", "Connection failed");
    await session.setOfflineMode(true);
    session.status = "error";
    expectStatus("neutral", "Offline mode");
    session.status = "connecting";
    expectStatus("warning", "Connecting…");
    session.auth = null;
    expectStatus("warning", "Connecting…");
    session.status = "error";
    expectStatus("neutral", "Disconnected");
    session.status = "disconnected";
    expectStatus("neutral", "Disconnected");
  });

  it("offers updates in a header popover without modifying Settings", async () => {
    const { target, button } = await setup();
    expect(button("App update")).toBeUndefined();
    const callbacks = vi.mocked(registerSW).mock.calls.at(-1)![0]!;
    callbacks.onRegisteredSW?.("/sw.js", {
      waiting: Object.assign(new EventTarget(), { state: "installed" }),
    } as unknown as ServiceWorkerRegistration);
    flushSync();
    expect(button("App update").getAttribute("commandfor")).toBe("update-popover");
    expect(button("App update").getAttribute("command")).toBe("toggle-popover");
    const popover = target.querySelector("#update-popover")!;
    expect(popover.getAttribute("popover")).toBe("auto");
    expect(popover.textContent).toContain("interrupts playback");
    expect(button("Close app update").getAttribute("command")).toBe("hide-popover");
    expect(target.querySelector('.settings-view [aria-label="App update"]')).toBeNull();
    const settings = target.querySelector('a[aria-label="Settings"]')!;
    expect(settings.getAttribute("title")).toBe("Settings");
    expect(settings.querySelector("span")).toBeNull();
    expect(target.querySelector("#player-dialog #update-popover")).toBeNull();
    button("Update now").click();
    flushSync();
    expect(button("Updating…").disabled).toBe(true);
    expect(popover.textContent).toContain("Applying the update");
  });

  it("shows offline setup failures in the update popover without an update action", async () => {
    const { target, button } = await setup();
    vi.mocked(registerSW).mock.calls.at(-1)![0]!.onRegisterError?.(new Error("Failed"));
    flushSync();
    expect(button("App update")).toBeDefined();
    expect(target.querySelector("#update-popover")?.textContent).toContain(
      "Offline app setup failed",
    );
    expect(button("Update now")).toBeUndefined();
  });

  it("offers error details beside Settings, never inside the player", async () => {
    const { target, session, button } = await setup();
    expect(button("Show errors")).toBeUndefined();
    session.error = "Connection failed";
    flushSync();
    const trigger = button("Show errors");
    expect(trigger.getAttribute("commandfor")).toBe("error-popover");
    expect(trigger.getAttribute("command")).toBe("toggle-popover");
    expect(trigger.nextElementSibling?.nextElementSibling?.getAttribute("href")).toBe("#/settings");
    const popover = target.querySelector("#error-popover")!;
    expect(popover.getAttribute("popover")).toBe("auto");
    expect(popover.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const notice = popover.querySelector('[role="alert"]')!;
    expect(notice.classList.contains("card")).toBe(true);
    expect(notice.getAttribute("data-variant")).toBe("danger");
    expect(notice.parentElement?.classList.contains("stack-sm")).toBe(true);
    expect(popover.textContent).toContain("Connection failed");
    expect(button("Close errors").getAttribute("commandfor")).toBe("error-popover");
    expect(button("Close errors").getAttribute("command")).toBe("hide-popover");
    expect(target.querySelector("#player-dialog [role='alert']")).toBeNull();
    expect(target.querySelector("#player-dialog [commandfor='error-popover']")).toBeNull();
    session.error = "";
    flushSync();
    expect(button("Show errors")).toBeUndefined();
    expect(target.querySelector("#error-popover")).toBeNull();
  });

  it.each([false, true])(
    "shows album/track counters during background refresh (saved: %s)",
    async (saved) => {
      const { target, metadata, session } = await setup(saved);
      const pending = deferred();
      metadata.getModifiedAt.mockResolvedValue(20);
      metadata.readLibrary.mockImplementationOnce(async (_signal, onProgress) => {
        onProgress?.({ albums: 500, tracks: 1000 });
        await pending.promise;
        return snapshot(credentials);
      });
      const loading = saved
        ? session.refresh()
        : session.connect({ ...credentials, password: "password" });
      await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
      flushSync();
      const counter = `${(500).toLocaleString()} albums · ${(1000).toLocaleString()} tracks`;
      expect(
        target.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, " ").trim(),
      ).toBe(counter);
      expect(target.textContent).not.toContain("songs");
      expect(target.querySelector('[aria-label="Music server"]')?.textContent).toContain(
        "Refreshing…",
      );
      expect(target.querySelector(".status")?.getAttribute("data-variant")).toBe("warning");
      pending.resolve();
      await loading;
      await session.refresh();
      flushSync();
      expect(target.textContent?.replace(/\s+/g, " ")).not.toContain(counter);
      expect(target.querySelector('[aria-label="Music server"]')?.textContent).toContain(
        "Connected",
      );
      expect(target.querySelector(".status")?.getAttribute("data-variant")).toBe("success");
    },
  );
  it("shows read-only connection information and allows disconnect during refresh", async () => {
    const { target, session, auth, metadata, button, offline } = await setup(true);
    const summary = target.querySelector('[aria-label="Music server"] > .row-md > .stack-xs')!;
    expect(summary.querySelector("strong")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      `${credentials.username} · ${credentials.host.replace(/^https?:\/\//i, "")}`,
    );
    expect(summary.textContent).not.toContain("https://");
    expect(summary.firstElementChild?.classList.contains("row-sm")).toBe(true);
    expect(summary.firstElementChild?.textContent).toContain("Connected");
    const actions = summary.nextElementSibling!;
    expect(actions.parentElement?.classList.contains("row-md")).toBe(true);
    expect(actions.querySelectorAll("button")).toHaveLength(2);
    expect(actions.querySelector('[aria-label="Refresh library"]')).not.toBeNull();
    expect(actions.querySelector('[aria-label="Disconnect"]')).not.toBeNull();
    expect(target.querySelector("form")).toBeNull();
    const refresh = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await refresh.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    button("Refresh library").click();
    flushSync();
    expect(button("Refreshing…").disabled).toBe(true);
    button("Refreshing…").click();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
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
    const { target, fill, button, offline, session, navigate, validate } = await setup();
    expect(offline().checked).toBe(true);
    expect(offline().disabled).toBe(true);
    expect(button("Connect").disabled).toBe(false);
    validate.mockRejectedValueOnce(new Error("Unauthorized"));
    fill();
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toBe("Unauthorized"),
    );
    expect(target.querySelector('[aria-label="Music server"] [role="alert"]')).toBeNull();
    expect(target.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(button("Show errors").getAttribute("commandfor")).toBe("error-popover");
    expect(session.error).toBe("Unauthorized");
    expect(offline().checked).toBe(true);
    expect(session.auth).toBeNull();
    fill();
    await vi.waitFor(() => expect(target.querySelector("form")).toBeNull());
    expect(offline().checked).toBe(false);
    expect(offline().disabled).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/library", "push");
  });
});

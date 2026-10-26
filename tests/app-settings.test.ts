// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/app.svelte";
import WebappUpdater from "../src/webapp-updater.svelte";
import { Network } from "../src/network.svelte";
import { AuthStore } from "../src/auth";
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

async function setup(saved = false, pwa = true) {
  const fixture = createSession(saved);
  fixture.session.start();
  if (saved) await vi.waitFor(() => expect(fixture.session.status).toBe("connected"));
  const target = document.createElement("main");
  document.body.append(target);
  mocks.session = fixture.session;
  const navigate = mocks.navigate;
  const component = mount(App, {
    target,
    props: {
      network: new Network(),
      auth: new AuthStore(),
      updaterComponent: pwa ? WebappUpdater : undefined,
    },
  });
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
  it("does not register a service worker without an updater component", async () => {
    await setup(false, false);
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("uses isolated Edgerunner cards, labeled native fields, and a native switch", async () => {
    const { target } = await setup();
    expect(target.querySelector(".settings-view")?.classList.contains("ui-edgerunner")).toBe(true);
    expect(target.querySelector(".settings-view h1")?.textContent).toBe("Settings");
    const server = target.querySelector("#settings-server")!;
    const offline = target.querySelector("#settings-offline-card")!;
    expect(server.classList.contains("card")).toBe(true);
    expect(server.querySelector("#settings-connection-status")?.textContent).toContain(
      "Disconnected",
    );
    expect(server.querySelector("form")?.getAttribute("aria-describedby")).toBe(
      "settings-auth-help",
    );
    expect(server.querySelectorAll("form input.input")).toHaveLength(3);
    for (const name of ["host", "username", "password"]) {
      const input = server.querySelector<HTMLInputElement>(`#server-${name}`)!;
      expect(input.required).toBe(true);
      expect(server.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
      expect(input.getAttribute("aria-errormessage")).toBe(`server-${name}-error`);
    }
    expect(server.querySelector("#server-host")?.getAttribute("type")).toBe("text");
    expect(server.querySelector("#server-password")?.getAttribute("type")).toBe("password");
    expect(offline.classList.contains("card")).toBe(true);
    const control = offline.querySelector('input[role="switch"]')!;
    expect(control.classList.contains("switch")).toBe(true);
    expect(control.getAttribute("aria-labelledby")).toBe("settings-offline-title");
    expect(control.getAttribute("aria-describedby")).toBe("settings-offline-help");
    expect(target.querySelector("select")).toBeNull();
  });

  it("keeps decorative status glyphs and loading aligned with the connection label", async () => {
    const { target, session } = await setup(true);
    const expectStatus = (symbol: string | null, label: string) => {
      flushSync();
      const status = target.querySelector("#settings-connection-status")!;
      expect(status.textContent).toContain(label);
      if (symbol) {
        expect(status.querySelector("use")?.getAttribute("href")).toBe(`#icon-${symbol}`);
        expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      } else {
        expect(status.querySelectorAll(".loader-bar")).toHaveLength(5);
        expect(status.querySelector(".loader")?.getAttribute("aria-hidden")).toBe("true");
      }
    };
    expectStatus("check", "Connected");
    session.status = "error";
    expectStatus("cross", "Connection failed");
    await session.setOfflineMode(true);
    session.status = "error";
    expectStatus("idle", "Offline mode");
    session.status = "connecting";
    expectStatus(null, "Connecting…");
    session.auth = null;
    expectStatus(null, "Connecting…");
    session.status = "error";
    expectStatus("cross", "Connection failed");
    session.status = "disconnected";
    expectStatus("idle", "Disconnected");
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
        target
          .querySelector("#settings-library-progress")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
      ).toBe(counter);
      expect(target.textContent).not.toContain("songs");
      expect(target.querySelector("#settings-connection-status")?.textContent).toContain(
        "Refreshing…",
      );
      expect(target.querySelectorAll("#settings-connection-status .loader-bar")).toHaveLength(5);
      pending.resolve();
      await loading;
      await session.refresh();
      flushSync();
      expect(target.textContent?.replace(/\s+/g, " ")).not.toContain(counter);
      expect(target.querySelector("#settings-connection-status")?.textContent).toContain(
        "Connected",
      );
      expect(target.querySelector("#settings-connection-status use")?.getAttribute("href")).toBe(
        "#icon-check",
      );
    },
  );
  it("shows read-only connection information and allows disconnect during refresh", async () => {
    const { target, session, auth, metadata, button, offline } = await setup(true);
    const server = target.querySelector("#settings-server")!;
    expect(server.querySelector("#settings-server-address")?.textContent).toBe(credentials.host);
    expect(server.querySelector("#settings-server-username")?.textContent).toBe(
      credentials.username,
    );
    expect(server.querySelector("#settings-connection-status")?.textContent).toContain("Connected");
    expect(server.querySelectorAll("button")).toHaveLength(2);
    expect(button("Refresh library")).toBeDefined();
    expect(button("Disconnect")).toBeDefined();
    expect(target.querySelector("form")).toBeNull();
    const refresh = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await refresh.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    button("Refresh library").click();
    flushSync();
    expect(button("Refreshing…").getAttribute("aria-disabled")).toBe("true");
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
    expect(target.querySelector("#settings-server [role='alert']")).toBeNull();
    expect(target.querySelector("#settings-server-error")?.textContent).toBe("Unauthorized");
    expect(target.querySelector("form")?.getAttribute("aria-describedby")).toContain(
      "settings-server-error",
    );
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

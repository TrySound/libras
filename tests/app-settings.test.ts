// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
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

async function setup(
  saved = false,
  pwa = true,
  options: {
    beforeStart?: (fixture: ReturnType<typeof createSession>) => void;
    waitForSync?: boolean;
  } = {},
) {
  const fixture = createSession(saved);
  options.beforeStart?.(fixture);
  fixture.session.start();
  if (saved && options.waitForSync !== false)
    await vi.waitFor(() => {
      expect(fixture.session.status).toBe("connected");
      expect(fixture.session.syncing).toBe(false);
    });
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
  const fill = (host = credentials.host) => {
    const inputs = [...target.querySelectorAll<HTMLInputElement>("form input")];
    for (const [index, value] of [host, credentials.username, "password"].entries()) {
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
  it("shows startup synchronization immediately and distinguishes server sync from refresh", async () => {
    const local = deferred();
    const modified = deferred<number | null>();
    const { target, session, loadCache, button } = await setup(true, false, {
      beforeStart(fixture) {
        fixture.loadCache.mockReturnValueOnce(local.promise);
        fixture.metadata.getModifiedAt.mockReturnValueOnce(modified.promise);
      },
      waitForSync: false,
    });
    await vi.waitFor(() => expect(loadCache).toHaveBeenCalledOnce());
    const status = target.querySelector("#settings-connection-status")!;
    expect(session.localReady).toBe(false);
    expect(status.textContent).toContain("Synchronizing…");
    expect(status.querySelector(".loader")).not.toBeNull();
    expect(status.textContent).not.toContain("with server");
    expect(target.textContent).not.toContain("Restoring local library…");
    local.resolve();
    await vi.waitFor(() => expect(session.syncing).toBe(true));
    flushSync();
    expect(status.textContent).toContain("Synchronizing with server…");
    expect(button("Refresh library").getAttribute("aria-busy")).toBe("false");
    modified.resolve(100);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    flushSync();
    expect(status.textContent?.trim()).toBe("listener@music.example");
    expect(status.querySelector(".loader")).toBeNull();
  });

  it("shows saved offline mode immediately while local data loads, without server requests", async () => {
    const local = deferred();
    const { target, session, metadata, validate, loadCache } = await setup(true, false, {
      beforeStart(fixture) {
        fixture.storage.setItem("navidrome-offline-mode", "true");
        fixture.loadCache.mockReturnValueOnce(local.promise);
      },
      waitForSync: false,
    });
    await vi.waitFor(() => expect(loadCache).toHaveBeenCalledOnce());
    expect(session.localReady).toBe(false);
    const status = target.querySelector("#settings-connection-status")!;
    expect(status.textContent).toContain("Offline mode");
    expect(status.querySelector("use")?.getAttribute("href")).toBe("#icon-offline");
    expect(status.querySelector(".loader")).toBeNull();
    local.resolve();
    await vi.waitFor(() => expect(session.localReady).toBe(true));
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it.each(["unmounted", "hidden", "navigating"] as const)(
    "does not steal navigation when a pending connection's view is %s",
    async (state) => {
      const { target, fill, session, validate, navigate } = await setup(false, false);
      const pending = deferred();
      validate.mockReturnValueOnce(pending.promise);
      fill();
      await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
      if (state === "hidden") target.style.display = "none";
      else if (state === "navigating") window.history.replaceState(null, "", "#/downloads");
      else {
        // Commit another route without destroying App or cancelling its Session.
        const intercept = vi.fn();
        window.navigation.dispatchEvent(
          Object.assign(new Event("navigate"), {
            canIntercept: true,
            navigationType: "push",
            destination: { url: new URL("#/downloads", window.location.href).href },
            intercept,
          }),
        );
        await intercept.mock.calls[0][0].handler();
        expect(target.querySelector(".settings-view")).toBeNull();
      }
      pending.resolve();
      await vi.waitFor(() => expect(session.auth).not.toBeNull());
      await tick();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("displays only the server host and port, without URL userinfo or auth secrets", async () => {
    const { target, session } = await setup(true);
    session.auth = {
      ...credentials,
      host: "https://hidden-user:hidden-secret@music.example:8443/base",
      token: "private-token-value",
      salt: "private-salt-value",
    };
    flushSync();
    expect(target.querySelector("#settings-server-identity")?.textContent).toBe(
      `${credentials.username}@music.example:8443`,
    );
    for (const secret of [
      "hidden-user",
      "hidden-secret",
      "private-token-value",
      "private-salt-value",
    ])
      expect(target.textContent).not.toContain(secret);
  });

  it("keeps the authenticated summary and retry available after refresh errors", async () => {
    const { target, session, metadata, button } = await setup(true);
    metadata.readLibrary.mockRejectedValueOnce(new Error("Library unavailable"));
    button("Refresh library").click();
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    flushSync();
    expect(target.querySelector("#settings-server")?.textContent).toContain("Library unavailable");
    expect(target.querySelector("form")).toBeNull();
    expect(button("Refresh library").disabled).toBe(false);
    button("Refresh library").click();
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    flushSync();
    expect(target.querySelector("#settings-server")?.textContent).not.toContain(
      "Synchronization needs attention",
    );
  });

  it("does not register a service worker without an updater component", async () => {
    await setup(false, false);
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("uses shared cards, labeled native fields, and a native switch", async () => {
    const { target } = await setup();
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
      expect(input.getAttribute("aria-errormessage")).toBeNull();
      expect(server.querySelector(`#server-${name}-error`)).toBeNull();
    }
    expect(server.querySelector("#server-host")?.getAttribute("type")).toBe("text");
    expect(server.querySelector("#server-host")?.getAttribute("placeholder")).toBe(
      "music.example.com",
    );
    expect(server.querySelector("#settings-auth-help")?.textContent).toContain(
      "Sign in to your Navidrome server",
    );
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
      if (symbol) {
        expect(status.textContent).toContain(label);
        expect(status.querySelector("use")?.getAttribute("href")).toBe(`#icon-${symbol}`);
        expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      } else {
        expect(status.textContent).toContain(label);
        expect(status.querySelector(".loader")).not.toBeNull();
      }
    };
    expectStatus("check", "listener@music.example");
    session.status = "error";
    expectStatus("cross", "Connection failed");
    await session.setOfflineMode(true);
    session.status = "error";
    expectStatus("offline", "Offline mode");
    session.status = "connecting";
    expectStatus("offline", "Offline mode");
    session.auth = null;
    expectStatus(null, "Connecting…");
    session.status = "error";
    expectStatus("cross", "Connection failed");
    session.status = "disconnected";
    expectStatus("unlink", "Disconnected");
  });

  it.each([".app-sidebar", "#navigation-dialog"])(
    "offers updates directly in %s and synchronizes both navigation copies",
    async (selector) => {
      const apply = vi.fn(async () => {});
      vi.mocked(registerSW).mockReturnValueOnce(apply);
      const { target } = await setup();
      expect(target.querySelector('[aria-label="App update"]')).toBeNull();
      expect(target.querySelector(".separator")).toBeNull();
      const menu = target.querySelector<HTMLButtonElement>('.app-header [aria-label="Open menu"]')!;
      expect(menu.getAttribute("data-variant")).toBeNull();
      expect(target.querySelector("#navigation-update-hint")).toBeNull();
      const callbacks = vi.mocked(registerSW).mock.calls.at(-1)![0]!;
      callbacks.onRegisteredSW?.("/sw.js", {
        waiting: Object.assign(new EventTarget(), { state: "installed" }),
      } as unknown as ServiceWorkerRegistration);
      flushSync();
      const notices = target.querySelectorAll('[aria-label="App update"]');
      expect(notices).toHaveLength(2);
      expect(menu.getAttribute("data-variant")).toBe("secondary");
      expect(menu.getAttribute("aria-describedby")).toBe("navigation-update-hint");
      expect(menu.getAttribute("data-size")).toBe("text");
      expect(menu.firstElementChild?.matches(".caption.text-subtle")).toBe(true);
      expect(menu.firstElementChild?.textContent).toBe("Update");
      expect(menu.firstElementChild?.nextElementSibling?.tagName.toLowerCase()).toBe("svg");
      for (const owner of [".app-sidebar", "#navigation-dialog"]) {
        const notice = target.querySelector(`${owner} [aria-label="App update"]`)!;
        expect(notice.previousElementSibling?.matches("hr.separator")).toBe(true);
        expect(notice.previousElementSibling?.previousElementSibling?.tagName).toBe("NAV");
        const action = notice.querySelector("button")!;
        expect(action.title).toContain("A new version of Libras is available.");
        expect(action.title).toContain("interrupts playback");
        expect(action.classList.contains("menu-item")).toBe(true);
        expect(action.querySelector(".label.text-subtle")?.textContent).toBe("Update Libras");
        expect(action.querySelector("use")?.getAttribute("href")).toBe("#icon-refresh");
        expect(action.querySelector("svg")?.getAttribute("color")).toBe("var(--text-subtle)");
        expect(action.querySelector(".caption")).toBeNull();
      }
      expect(target.querySelector("#update-popover")).toBeNull();
      expect(target.querySelector('[commandfor="update-popover"]')).toBeNull();
      expect(target.querySelector(".app-status-actions")).toBeNull();
      expect(target.querySelector('.settings-view [aria-label="App update"]')).toBeNull();
      expect(target.querySelector('#player-dialog [aria-label="App update"]')).toBeNull();
      target
        .querySelector<HTMLButtonElement>(`${selector} [aria-label="App update"] button`)!
        .click();
      flushSync();
      expect(apply).toHaveBeenCalledOnce();
      for (const notice of notices) {
        const action = notice.querySelector("button")!;
        expect(action.disabled).toBe(false);
        expect(action.getAttribute("aria-disabled")).toBe("true");
        action.focus();
        expect(document.activeElement).toBe(action);
        action.click();
        expect(apply).toHaveBeenCalledOnce();
        expect(notice.querySelector("button")?.textContent).toContain("Updating…");
        expect(notice.querySelector("button")?.title).toContain("Applying the update");
        expect(notice.querySelector(".loader")?.getAttribute("aria-hidden")).toBe("true");
        expect(notice.querySelectorAll(".loader-bar")).toHaveLength(5);
        expect(notice.querySelector("svg")).toBeNull();
      }
    },
  );

  it("shows update failures below the retry action and clears them when retrying", async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error("Update failed. Please retry."))
      .mockResolvedValue(undefined);
    vi.mocked(registerSW).mockReturnValueOnce(apply);
    const { target } = await setup();
    vi.mocked(registerSW)
      .mock.calls.at(-1)![0]!
      .onRegisteredSW?.("/sw.js", {
        waiting: Object.assign(new EventTarget(), { state: "installed" }),
      } as unknown as ServiceWorkerRegistration);
    flushSync();
    target
      .querySelector<HTMLButtonElement>('.app-sidebar [aria-label="App update"] button')!
      .click();
    await vi.waitFor(() => {
      for (const owner of [".app-sidebar", "#navigation-dialog"]) {
        const notice = target.querySelector(`${owner} [aria-label="App update"]`)!;
        expect(notice.querySelector("button + .caption.text-subtle")?.textContent).toBe(
          "Update failed. Please retry.",
        );
        expect(notice.querySelector("button")?.hasAttribute("title")).toBe(false);
        expect(notice.querySelector("button")?.getAttribute("aria-disabled")).toBe("false");
      }
    });
    target
      .querySelector<HTMLButtonElement>('#navigation-dialog [aria-label="App update"] button')!
      .click();
    flushSync();
    expect(apply).toHaveBeenCalledTimes(2);
    for (const notice of target.querySelectorAll('[aria-label="App update"]')) {
      expect(notice.querySelector(".caption")).toBeNull();
      expect(notice.querySelector(".loader")).not.toBeNull();
    }
  });

  it("shows offline setup failures in navigation without an update action", async () => {
    const { target, button } = await setup();
    vi.mocked(registerSW).mock.calls.at(-1)![0]!.onRegisterError?.(new Error("Failed"));
    flushSync();
    for (const owner of [".app-sidebar", "#navigation-dialog"]) {
      expect(target.querySelector(`${owner} [aria-label="App update"]`)?.textContent).toContain(
        "Offline app setup failed",
      );
    }
    expect(target.querySelector("#update-popover")).toBeNull();
    expect(button("Update Libras")).toBeUndefined();
    expect(target.querySelector('[aria-label="App update"] button')).toBeNull();
    expect(target.querySelector("#navigation-update-hint")).toBeNull();
    expect(
      target.querySelector('.app-header [aria-label="Open menu"]')?.getAttribute("data-variant"),
    ).toBeNull();
  });

  it("offers error details beside Settings, never inside the player", async () => {
    const { target, session, button } = await setup();
    expect(button("Show errors")).toBeUndefined();
    session.error = "Connection failed";
    flushSync();
    const trigger = button("Show errors");
    expect(trigger.getAttribute("commandfor")).toBe("error-popover");
    expect(trigger.getAttribute("command")).toBe("toggle-popover");
    const popover = target.querySelector("#error-popover")!;
    expect(target.querySelectorAll("#error-popover")).toHaveLength(1);
    expect(popover.getAttribute("popover")).toBe("auto");
    expect(popover.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const notice = popover.querySelector('[role="alert"]')!;
    expect(notice.classList.contains("card")).toBe(true);
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
      const { target, metadata, session, playback } = await setup(saved);
      const pending = deferred();
      const queue = deferred();
      const queueCalls = playback.refreshQueue.mock.calls.length;
      playback.refreshQueue.mockReturnValueOnce(queue.promise);
      metadata.getModifiedAt.mockResolvedValue(20);
      metadata.readLibrary.mockImplementationOnce(async (_signal, onProgress) => {
        onProgress?.({ albums: 500, tracks: 1000 });
        await pending.promise;
        return snapshot(credentials);
      });
      const loading = saved
        ? session.refresh()
        : session.connect({ ...credentials, password: "password" });
      if (saved) {
        flushSync();
        const status = target.querySelector("#settings-connection-status")!;
        expect(status.textContent?.trim()).toBe("listener@music.example");
        expect(status.textContent).not.toContain("Synchronizing");
        expect(status.querySelector(".loader")).toBeNull();
        expect(target.querySelector("#settings-refresh")?.textContent).toContain("Refreshing…");
      }
      await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
      flushSync();
      const counter = `${(500).toLocaleString()} albums · ${(1000).toLocaleString()} tracks`;
      expect(
        target
          .querySelector("#settings-library-progress")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
      ).toBe(counter);
      expect(
        target.querySelector("#settings-library-progress")?.classList.contains("text-subtle"),
      ).toBe(true);
      expect(
        target.querySelector("#settings-connection-status #settings-library-progress"),
      ).not.toBeNull();
      expect(target.querySelector("#settings-connection-status")?.textContent).not.toContain(
        "Refreshing…",
      );
      expect(target.querySelector("#settings-refresh")?.textContent).toContain(
        saved ? "Refreshing…" : "Refresh library",
      );
      expect(target.querySelector("#settings-connection-status .loader")).not.toBeNull();
      pending.resolve();
      await vi.waitFor(() => expect(playback.refreshQueue).toHaveBeenCalledTimes(queueCalls + 1));
      flushSync();
      const status = target.querySelector("#settings-connection-status")!;
      expect(
        status
          .querySelector("#settings-library-progress")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
      ).toBe(counter);
      expect(status.textContent).not.toContain("Synchronizing");
      expect(status.textContent).not.toContain("Connected");
      expect(status.querySelector(".loader")).not.toBeNull();
      expect(target.querySelector("#settings-refresh")?.textContent).toContain(
        saved ? "Refreshing…" : "Refresh library",
      );
      expect(target.querySelector("#settings-refresh")?.getAttribute("aria-busy")).toBe(
        String(saved),
      );
      expect(target.querySelector("#settings-refresh")?.getAttribute("aria-disabled")).toBe("true");
      queue.resolve();
      await loading;
      await vi.waitFor(() => expect(session.syncing).toBe(false));
      flushSync();
      expect(status.textContent?.trim()).toBe("listener@music.example");
      expect(status.querySelector("#settings-library-progress")).toBeNull();
      expect(status.querySelector(".loader")).toBeNull();
      expect(status.querySelector("use")?.getAttribute("href")).toBe("#icon-check");
      expect(target.querySelector("#settings-refresh")?.textContent).toContain("Refresh library");
    },
  );
  it("shows read-only connection information and allows disconnect during refresh", async () => {
    const { target, session, auth, metadata, button, offline } = await setup(true);
    const server = target.querySelector("#settings-server")!;
    expect(server.querySelector("#settings-server-identity")?.textContent).toBe(
      `${credentials.username}@${new URL(credentials.host).host}`,
    );
    expect(server.querySelector("#settings-connection-status")?.textContent?.trim()).toBe(
      "listener@music.example",
    );
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
    expect(button("Refreshing…").querySelector("svg, .loader")).toBeNull();
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
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    target.querySelector<HTMLInputElement>("#server-password")!.focus();
    fill("music.example");
    const connect = button("Connecting…");
    expect(connect.disabled).toBe(false);
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    expect(
      [...target.querySelectorAll<HTMLInputElement>("form input")].every((input) => input.disabled),
    ).toBe(true);
    target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    pending.reject(new Error("Unauthorized"));
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
    fill("music.example");
    await vi.waitFor(() => expect(target.querySelector("form")).toBeNull());
    expect(offline().checked).toBe(false);
    expect(offline().disabled).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/library", "push");
    expect(session.auth?.host).toBe(credentials.host);
  });
});

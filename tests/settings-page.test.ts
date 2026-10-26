// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import Settings from "../src/_settings.svelte";
import { createSession, credentials, deferred } from "./session-test-helpers";
import { installNavigation } from "./router-test-helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(saved = false) {
  const navigate = vi.fn();
  installNavigation("/settings", navigate);
  const fixture = createSession(saved);
  fixture.session.start();
  if (saved)
    await vi.waitFor(() => {
      expect(fixture.session.status).toBe("connected");
      expect(fixture.session.syncing).toBe(false);
    });
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(Settings, { target, props: { session: fixture.session } });
  flushSync();
  let mounted = true;
  const destroyUI = async () => {
    if (!mounted) return;
    mounted = false;
    await unmount(component);
  };
  cleanups.push(async () => {
    await destroyUI();
    await fixture.destroy();
  });
  const field = (name: string) => target.querySelector<HTMLInputElement>(`#server-${name}`)!;
  const fill = (host = credentials.host) => {
    for (const [name, value] of [
      ["host", host],
      ["username", credentials.username],
      ["password", "private-password-value"],
    ]) {
      field(name).value = value;
      field(name).dispatchEvent(new Event("input", { bubbles: true }));
    }
    flushSync();
  };
  const submit = () => {
    target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
  };
  return { ...fixture, target, field, fill, submit, navigate, destroyUI };
}

it("keeps Connect focusable while busy, prevents duplicate submission, and exposes errors with the form", async () => {
  const { target, field, fill, submit, validate } = await setup();
  const pending = deferred();
  validate.mockImplementationOnce(() => pending.promise);
  fill();
  field("password").focus();
  const button = target.querySelector<HTMLButtonElement>("#settings-connect")!;
  submit();
  expect(document.activeElement).toBe(button);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(target.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
  expect(
    [...target.querySelectorAll<HTMLInputElement>("form input")].every((input) => input.disabled),
  ).toBe(true);
  expect(target.querySelectorAll("#settings-connection-status .loader-bar")).toHaveLength(5);
  submit();
  await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
  pending.reject(new Error("Unauthorized"));
  await vi.waitFor(() =>
    expect(target.querySelector("#settings-server-error")?.textContent).toBe("Unauthorized"),
  );
  flushSync();
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("false");
  expect(target.querySelector("form")?.getAttribute("aria-describedby")).toContain(
    "settings-server-error",
  );
  expect(target.querySelector("#settings-connection-status #settings-server-error")).not.toBeNull();
  expect(target.querySelector("#settings-connection-status")?.textContent).toContain(
    "Connection failed",
  );
  expect(field("password").type).toBe("password");
  expect(target.textContent).not.toContain("private-password-value");
});

it("keeps restoration visible without pretending to connect or blocking the existing form workflow", async () => {
  const { target, session, field } = await setup();
  session.localReady = false;
  flushSync();
  expect(target.textContent).toContain("Restoring local library…");
  expect(target.querySelector("#settings-connection-status")?.textContent).toContain(
    "Disconnected",
  );
  expect(field("host").disabled).toBe(false);
  expect(target.querySelector<HTMLInputElement>("#settings-offline")?.disabled).toBe(true);
  expect(target.querySelector("select")).toBeNull();
});

it("accepts a bare hostname and navigates after a successful connection without exposing credentials", async () => {
  const { target, fill, submit, session, auth, navigate } = await setup();
  fill("music.example");
  submit();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/library", "push"));
  flushSync();
  expect(session.auth?.host).toBe(credentials.host);
  expect(target.querySelector("form")).toBeNull();
  expect(target.querySelector("#settings-server-address")?.textContent).toBe(credentials.host);
  expect(target.querySelector("#settings-server-username")?.textContent).toBe(credentials.username);
  expect(target.textContent).not.toContain("private-password-value");
  expect(target.textContent).not.toContain(auth.load()!.token);
  expect(target.textContent).not.toContain(auth.load()!.salt);
  expect(auth.storage.getItem("navidrome-auth")).not.toContain("private-password-value");
});

it("does not navigate back when a connection completes after the Settings view is unmounted", async () => {
  const { fill, submit, session, validate, navigate, destroyUI } = await setup();
  const pending = deferred();
  validate.mockImplementationOnce(() => pending.promise);
  fill();
  submit();
  await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
  await destroyUI();
  pending.resolve();
  await vi.waitFor(() => expect(session.auth).not.toBeNull());
  await tick();
  expect(navigate).not.toHaveBeenCalled();
});

it("does not navigate when a pending connection's view is hidden but remains mounted", async () => {
  const { target, fill, submit, session, validate, navigate } = await setup();
  const pending = deferred();
  validate.mockImplementationOnce(() => pending.promise);
  fill();
  submit();
  await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
  target.style.display = "none";
  pending.resolve();
  await vi.waitFor(() => expect(session.auth).not.toBeNull());
  await tick();
  expect(navigate).not.toHaveBeenCalled();
});

it("does not overwrite navigation that starts before the Settings view unmounts", async () => {
  const { fill, submit, session, validate, navigate } = await setup();
  const pending = deferred();
  validate.mockImplementationOnce(() => pending.promise);
  fill();
  submit();
  await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
  window.history.replaceState(null, "", "#/downloads");
  pending.resolve();
  await vi.waitFor(() => expect(session.auth).not.toBeNull());
  await tick();
  expect(navigate).not.toHaveBeenCalled();
});

it("omits URL userinfo and auth secrets from the read-only connection summary", async () => {
  const { target, session } = await setup(true);
  session.auth = {
    ...credentials,
    host: "https://hidden-user:hidden-secret@music.example/base",
    token: "private-token-value",
    salt: "private-salt-value",
  };
  flushSync();
  expect(target.querySelector("#settings-server-address")?.textContent).toBe(
    "https://music.example/base",
  );
  for (const secret of [
    "hidden-user",
    "hidden-secret",
    "private-token-value",
    "private-salt-value",
  ])
    expect(target.textContent).not.toContain(secret);
});

it("clears fields and restores focus to Host after a focused Disconnect action", async () => {
  const { target, auth, field } = await setup(true);
  const disconnect = target.querySelector<HTMLButtonElement>("#settings-disconnect")!;
  disconnect.focus();
  disconnect.click();
  flushSync();
  await tick();
  expect(auth.load()).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(field("host")));
  expect([field("host").value, field("username").value, field("password").value]).toEqual([
    "",
    "",
    "",
  ]);
  expect(target.querySelector<HTMLInputElement>("#settings-offline")?.checked).toBe(true);
});

it("keeps the authenticated summary and retry available after refresh errors", async () => {
  const { target, session, metadata } = await setup(true);
  metadata.readLibrary.mockRejectedValueOnce(new Error("Library unavailable"));
  await session.refresh();
  flushSync();
  expect(target.textContent).toContain("Synchronization needs attention");
  expect(target.textContent).toContain("Library unavailable");
  expect(target.querySelector("#settings-server-address")?.textContent).toBe(credentials.host);
  expect(target.querySelector<HTMLButtonElement>("#settings-refresh")?.disabled).toBe(false);
  expect(target.querySelector("form")).toBeNull();
  await session.refresh();
  flushSync();
  expect(target.textContent).not.toContain("Synchronization needs attention");
});

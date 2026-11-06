// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore, getAccountKey } from "../src/auth";
import { NetworkTransportError } from "../src/network.svelte";
import { SubsonicError, SubsonicHttpError } from "../src/subsonic-client";
import { createSession, credentials, deferred } from "./session-test-helpers";

const fixtures: ReturnType<typeof createSession>[] = [];
function setup() {
  const fixture = createSession();
  fixtures.push(fixture);
  return fixture;
}
const input = { host: credentials.host, username: credentials.username, password: "test-password" };
const keyExtension = [{ name: "apiKeyAuthentication", versions: [1] }];
const identity = {
  version: "1.16.1",
  type: "unknown-open-server",
  serverVersion: "1",
  openSubsonic: true,
};
function response(fields: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }));
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Session login policy", () => {
  it.each([1, 2])(
    "defaults to API key only when version 1 is advertised (version %i)",
    async (version) => {
      const { session, discover } = setup();
      discover.mockResolvedValueOnce([{ name: "apiKeyAuthentication", versions: [version] }]);
      expect(await session.discover(input.host)).toBe(true);
      expect(session.loginMethod).toBe(version === 1 ? "apiKey" : "token");
      for (const method of ["token", "apiKey", "password"] as const) {
        session.setLoginMethod(method);
        expect(session.loginMethod).toBe(method);
        expect(session.loginHost).toBe(input.host);
      }
    },
  );

  it("requires discovery and never submits credentials after a transport discovery failure", async () => {
    const { session, discover, validate, network, loadCache, selection } = setup();
    discover.mockRejectedValueOnce(new NetworkTransportError());
    const prepare = vi.spyOn(network, "prepare");
    expect(await session.connect(input)).toBe(false);
    expect(session.error).toContain("CORS");
    expect(session.loginHost).toBe("");
    expect(prepare).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(loadCache).not.toHaveBeenCalled();
    expect(selection.cache).toBeUndefined();
    expect(await session.discover(input.host)).toBe(true);
    expect(session.loginMethod).toBe("token");
  });

  it("resolves a key's username before preparing or selecting any account cache, then validates ping", async () => {
    const { session, discover, network, loadCache, validate, selection, auth } = setup();
    discover.mockResolvedValueOnce(keyExtension);
    const key = deferred<import("../src/auth").Auth>();
    const resolve = vi.spyOn(network, "resolveApiKey").mockReturnValueOnce(key.promise);
    const pending = session.connect({ host: input.host, method: "apiKey", apiKey: "test-key" });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    expect(loadCache).not.toHaveBeenCalled();
    expect(selection.cache).toBeUndefined();
    expect(auth.load()).toBeNull();
    key.resolve({ ...credentials, credentials: { method: "apiKey", apiKey: "test-key" } });
    expect(await pending).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    expect(selection.cache?.key).toBe(getAccountKey(credentials));
    expect(session.auth?.username).toBe(credentials.username);
    expect(auth.load()?.credentials.method).toBe("apiKey");
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(loadCache.mock.invocationCallOrder[0]);
  });

  it.each(["invalid-key", "malformed-identity", "invalid-ping"])(
    "never falls back or selects a workspace for %s",
    async (failure) => {
      const { session, discover, network, validate, loadCache, selection, auth } = setup();
      discover.mockResolvedValueOnce(keyExtension);
      const resolve = vi.spyOn(network, "resolveApiKey");
      if (failure === "invalid-key")
        resolve.mockRejectedValueOnce(new SubsonicError(44, "Invalid API key"));
      else if (failure === "malformed-identity")
        resolve.mockRejectedValueOnce(new Error("Invalid tokenInfo response"));
      else {
        resolve.mockResolvedValueOnce({
          ...credentials,
          credentials: { method: "apiKey", apiKey: "test-key" },
        });
        validate.mockRejectedValueOnce(new SubsonicError(41, "Unsupported authentication"));
      }
      expect(
        await session.connect({ host: input.host, method: "apiKey", apiKey: "test-key" }),
      ).toBe(false);
      expect(loadCache).toHaveBeenCalledTimes(failure === "invalid-ping" ? 1 : 0);
      expect(selection.cache).toBeUndefined();
      expect(session.passwordConfirmation).toBeUndefined();
      expect(auth.load()).toBeNull();
    },
  );

  it.each([41, 42])(
    "offers a separate confirmation only for token rejection code %i",
    async (code) => {
      const { session, validate, network, auth, storage } = setup();
      const prepare = vi.spyOn(network, "prepare");
      validate.mockRejectedValueOnce(new SubsonicError(code, "Token method unsupported"));
      expect(await session.connect(input)).toBe(false);
      expect(prepare.mock.calls.map(([auth]) => auth.credentials.method)).toEqual(["token"]);
      expect(session.passwordConfirmation).toBe("unsupported");
      expect(auth.load()).toBeNull();
      expect(session.error).toBe(`Token method unsupported (Subsonic code ${code})`);
      expect(await session.confirmPassword()).toBe(true);
      expect(prepare.mock.calls.map(([auth]) => auth.credentials.method)).toEqual([
        "token",
        "password",
      ]);
      expect(new AuthStore(storage).load()?.credentials.method).toBe("password");
      session.disconnect();
      expect(storage.getItem("navidrome-auth")).toBeNull();
      expect(auth.loadAccount()).toEqual({ host: input.host, username: input.username });
    },
  );

  it.each([
    new SubsonicError(40, "Wrong credentials"),
    new SubsonicError(44, "Wrong key"),
    new SubsonicError(0, "Generic failure"),
    new SubsonicError(70, "Not found"),
    new Error("Token authentication unsupported"),
    new DOMException("Timed out", "TimeoutError"),
    new NetworkTransportError(),
    new Error("Invalid Subsonic response"),
    new SubsonicHttpError(401),
    new SubsonicHttpError(403),
  ])("does not downgrade on $name / $message", async (error) => {
    const { session, validate, network } = setup();
    const prepare = vi.spyOn(network, "prepare");
    validate.mockRejectedValueOnce(error);
    expect(await session.connect(input)).toBe(false);
    expect(session.passwordConfirmation).toBeUndefined();
    expect(prepare.mock.calls.map(([auth]) => auth.credentials.method)).toEqual(["token"]);
    expect(await session.confirmPassword()).toBe(false);
    expect(session.error.length > 0).toBe(true);
  });

  it("permits explicit password selection only after a warning/confirmation, then persists it", async () => {
    const { session, validate, network, storage } = setup();
    const prepare = vi.spyOn(network, "prepare");
    expect(await session.connect({ ...input, method: "password" })).toBe(false);
    expect(session.passwordConfirmation).toBe("explicit");
    expect(validate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(await session.confirmPassword()).toBe(true);
    expect(new AuthStore(storage).load()?.credentials.method).toBe("password");
  });

  it.each(["explicit", "fallback"])(
    "never offers or sends a direct password over development HTTP (%s)",
    async (kind) => {
      const { session, validate, network } = setup();
      const prepare = vi.spyOn(network, "prepare");
      if (kind === "fallback")
        validate.mockRejectedValueOnce(new SubsonicError(41, "Unsupported method"));
      expect(
        await session.connect({
          ...input,
          host: "http://localhost:4533",
          method: kind === "explicit" ? "password" : "token",
        }),
      ).toBe(false);
      expect(session.passwordConfirmation).toBeUndefined();
      expect(session.error).toContain("requires HTTPS");
      expect(prepare.mock.calls.every(([auth]) => auth.credentials.method === "token")).toBe(true);
    },
  );

  it.each(["cancel", "method", "host", "disconnect"])(
    "discards pending password secrets after %s",
    async (action) => {
      const { session, network } = setup();
      const prepare = vi.spyOn(network, "prepare");
      await session.connect({ ...input, method: "password" });
      if (action === "cancel") session.cancelLogin(false);
      if (action === "method") session.setLoginMethod("apiKey");
      if (action === "host") await session.discover("https://other.example");
      if (action === "disconnect") session.disconnect();
      expect(await session.confirmPassword()).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(session.auth).toBeNull();
    },
  );

  it.each(["host", "cancel", "disconnect"])(
    "ignores stale discovery results after %s",
    async (action) => {
      const { session, discover, auth } = setup();
      const pending = deferred<typeof keyExtension>();
      discover.mockReturnValueOnce(pending.promise);
      const first = session.discover(input.host);
      if (action === "host") await session.discover("https://other.example");
      else if (action === "cancel") session.cancelLogin();
      else session.disconnect();
      pending.resolve(keyExtension);
      expect(await first).toBe(false);
      expect(session.loginHost).toBe(action === "host" ? "https://other.example" : "");
      expect(session.loginMethod).toBe("token");
      expect(auth.load()).toBeNull();
    },
  );

  it.each(["host", "method", "cancel", "disconnect"])(
    "ignores stale key identity completion after %s",
    async (action) => {
      const { session, network, loadCache, auth, selection } = setup();
      const pending = deferred<import("../src/auth").Auth>();
      const resolve = vi.spyOn(network, "resolveApiKey").mockReturnValueOnce(pending.promise);
      const first = session.connect({ host: input.host, method: "apiKey", apiKey: "test-key" });
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
      if (action === "host") await session.discover("https://other.example");
      if (action === "method") session.setLoginMethod("token");
      if (action === "cancel") session.cancelLogin(false);
      if (action === "disconnect") session.disconnect();
      pending.resolve({ ...credentials, credentials: { method: "apiKey", apiKey: "test-key" } });
      expect(await first).toBe(false);
      expect(loadCache).not.toHaveBeenCalled();
      expect(selection.cache).toBeUndefined();
      expect(auth.load()).toBeNull();
    },
  );

  it("starts with valid legacy credentials even when auth migration storage is full", async () => {
    const { session, auth, storage, selection, network } = setup();
    const open = vi.spyOn(network, "open");
    const original = JSON.stringify({
      host: credentials.host,
      username: credentials.username,
      token: credentials.credentials.token,
      salt: credentials.credentials.salt,
    });
    storage.setItem("navidrome-auth", original);
    const setItem = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementation((key, value) => {
      if (key === "navidrome-auth") throw new DOMException("Storage full", "QuotaExceededError");
      setItem(key, value);
    });
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(session.auth).toEqual(credentials);
    expect(auth.load()).toEqual(credentials);
    expect(selection.cache?.key).toBe(getAccountKey(credentials));
    expect(open).toHaveBeenCalledWith(credentials, []);
    expect(storage.getItem("navidrome-auth")).toBe(original);
    expect(auth.loadAccount()).toEqual({ host: credentials.host, username: credentials.username });
    expect(storage.removeItem).not.toHaveBeenCalledWith("navidrome-auth");
  });

  it("revalidates restored key identity and ping before enabling synchronization", async () => {
    const { session, auth, network, discover, validate, metadata, selection } = setup();
    const saved = {
      ...credentials,
      credentials: { method: "apiKey" as const, apiKey: "test-key" },
    };
    auth.save(saved);
    const resolve = vi.spyOn(network, "resolveApiKey").mockResolvedValueOnce(saved);
    const save = vi.spyOn(auth, "save");
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(discover).toHaveBeenCalledWith(credentials.host);
    expect(resolve).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(validate.mock.invocationCallOrder[0]);
    expect(validate.mock.invocationCallOrder[0]).toBeLessThan(
      metadata.getModifiedAt.mock.invocationCallOrder[0],
    );
    expect(selection.cache?.key).toBe(getAccountKey(credentials));
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["mismatch", "malformed", "transport", "invalid-key", "ping"])(
    "keeps a restored key's saved cache offline on %s failure without identity rewrite or fallback",
    async (failure) => {
      const { session, auth, network, validate, metadata, selection, storage } = setup();
      const saved = {
        ...credentials,
        credentials: { method: "apiKey" as const, apiKey: "test-key" },
      };
      auth.save(saved);
      const resolve = vi.spyOn(network, "resolveApiKey");
      if (failure === "mismatch")
        resolve.mockResolvedValueOnce({ ...saved, username: "different-account" });
      else if (failure === "malformed")
        resolve.mockRejectedValueOnce(
          new Error("The server returned an invalid tokenInfo response."),
        );
      else if (failure === "transport") resolve.mockRejectedValueOnce(new NetworkTransportError());
      else if (failure === "invalid-key")
        resolve.mockRejectedValueOnce(new SubsonicError(44, "Invalid API key"));
      else {
        resolve.mockResolvedValueOnce(saved);
        validate.mockRejectedValueOnce(new SubsonicError(41, "Unsupported authentication"));
      }
      const save = vi.spyOn(auth, "save");
      session.start();
      await vi.waitFor(() => expect(session.status).toBe("error"));
      expect(session.localReady).toBe(true);
      expect(session.offlineMode).toBe(true);
      expect(selection.cache?.key).toBe(getAccountKey(credentials));
      expect(selection.cache?.artists.size).toBe(1);
      expect(session.auth).toEqual(saved);
      expect(auth.load()).toEqual(saved);
      expect(save).not.toHaveBeenCalled();
      expect(metadata.getModifiedAt).not.toHaveBeenCalled();
      expect(metadata.readLibrary).not.toHaveBeenCalled();
      expect(session.passwordConfirmation).toBeUndefined();
      expect(session.error).toContain("saved library is available offline");
      expect(session.error).toContain("disconnect and sign in again");
      expect(JSON.parse(storage.getItem("navidrome-account")!).username).toBe(credentials.username);
      if (failure === "mismatch") expect(session.error).toContain("different account");
      expect(validate).toHaveBeenCalledTimes(failure === "ping" ? 1 : 0);
    },
  );

  it("ignores restored key identity completion after disconnect while retaining the offline cache", async () => {
    const { session, auth, network, validate, metadata, selection } = setup();
    const saved = {
      ...credentials,
      credentials: { method: "apiKey" as const, apiKey: "test-key" },
    };
    auth.save(saved);
    const pending = deferred<typeof saved>();
    const resolve = vi.spyOn(network, "resolveApiKey").mockReturnValueOnce(pending.promise);
    session.start();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const cache = selection.cache;
    expect(session.localReady).toBe(true);
    session.disconnect();
    pending.resolve(saved);
    await new Promise((done) => setTimeout(done, 0));
    expect(session.status).toBe("disconnected");
    expect(selection.cache).toBe(cache);
    expect(auth.load()).toBeNull();
    expect(validate).not.toHaveBeenCalled();
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
  });

  it("restores a saved API-key account in explicit offline mode without discovery, tokenInfo or ping", async () => {
    const { session, auth, network, discover, validate, storage, selection } = setup();
    auth.save({ ...credentials, credentials: { method: "apiKey", apiKey: "test-key" } });
    storage.setItem("navidrome-offline-mode", "true");
    const resolve = vi.spyOn(network, "resolveApiKey");
    session.start();
    await vi.waitFor(() => expect(session.localReady).toBe(true));
    expect(selection.cache?.key).toBe(getAccountKey(credentials));
    expect(discover).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("restores a persisted password without rewriting credentials", async () => {
    const { session, auth, storage } = setup();
    auth.save({
      ...credentials,
      credentials: {
        method: "password",
        username: credentials.username,
        password: "test-password",
      },
    });
    const save = vi.spyOn(auth, "save");
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(save).not.toHaveBeenCalled();
    expect(new AuthStore(storage).load()?.credentials.method).toBe("password");
  });

  it("retries failed restored token discovery explicitly without treating transport failure as legacy support", async () => {
    const { session, auth, discover, metadata } = setup();
    auth.save(credentials);
    discover.mockRejectedValueOnce(new NetworkTransportError());
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("error"));
    expect(session.localReady).toBe(true);
    expect(session.error).toContain("CORS");
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    await session.refresh();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(session.status).toBe("connected");
    expect(metadata.getModifiedAt).toHaveBeenCalledOnce();
  });

  it("integrates formPost token rejection and sends a direct password only after the separate confirmation", async () => {
    const { session, discover, validate, auth } = setup();
    discover.mockRestore();
    validate.mockRestore();
    const requests: { path: string; post: boolean; auth: string[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, options?: RequestInit) => {
        const url = new URL(input);
        const parameters =
          options?.body instanceof URLSearchParams ? options.body : url.searchParams;
        requests.push({
          path: url.pathname,
          post: options?.method === "POST",
          auth: ["apiKey", "u", "p", "t", "s"].filter((name) => parameters.has(name)),
        });
        if (url.pathname.endsWith("getOpenSubsonicExtensions.view"))
          return response({ openSubsonicExtensions: [{ name: "formPost", versions: [1] }] });
        if (parameters.has("t"))
          return response({
            status: "failed",
            error: { code: 42, message: "Token method unsupported" },
          });
        return response(identity);
      }),
    );
    expect(await session.connect(input)).toBe(false);
    expect(session.passwordConfirmation).toBe("unsupported");
    expect(requests.map(({ auth }) => auth)).toEqual([[], ["u", "t", "s"]]);
    expect(auth.load()).toBeNull();
    expect(await session.confirmPassword()).toBe(true);
    expect(requests.map(({ auth }) => auth)).toEqual([[], ["u", "t", "s"], ["u", "p"]]);
    expect(requests.map(({ post }) => post)).toEqual([false, true, true]);
    expect(requests.map(({ path }) => path)).toEqual([
      "/rest/getOpenSubsonicExtensions.view",
      "/rest/ping.view",
      "/rest/ping.view",
    ]);
  });

  it("integrates public discovery, key resolution and OpenSubsonic identity validation without username credentials", async () => {
    const { session, discover, validate, selection } = setup();
    discover.mockRestore();
    validate.mockRestore();
    const paths: string[] = [];
    const authNames: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        paths.push(url.pathname);
        authNames.push(["apiKey", "u", "p", "t", "s"].filter((name) => url.searchParams.has(name)));
        if (url.pathname.endsWith("getOpenSubsonicExtensions.view"))
          return response({ openSubsonicExtensions: keyExtension });
        if (url.pathname.endsWith("tokenInfo.view")) {
          expect(selection.cache).toBeUndefined();
          return response({ tokenInfo: { username: credentials.username } });
        }
        return response(identity);
      }),
    );
    expect(await session.connect({ host: input.host, method: "apiKey", apiKey: "test-key" })).toBe(
      true,
    );
    expect(paths).toEqual([
      "/rest/getOpenSubsonicExtensions.view",
      "/rest/tokenInfo.view",
      "/rest/ping.view",
    ]);
    expect(authNames).toEqual([[], ["apiKey"], ["apiKey"]]);
  });
});

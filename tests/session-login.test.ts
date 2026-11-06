// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore, getAccountKey } from "../src/auth";
import { NetworkTransportError } from "../src/network.svelte";
import { SubsonicClient, SubsonicError } from "../src/subsonic-client";
import { connect, createSession, credentials, deferred } from "./session-test-helpers";

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

describe("Session authenticated workspace integration", () => {
  it.each(["discovery", "key", "ping"])(
    "allows immediate retry after cancelling ignored-abort %s transport",
    async (stage) => {
      const { session, discover, validate, selection, auth } = setup();
      discover.mockRestore();
      validate.mockRestore();
      const pending = deferred<Response>();
      let blocked = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const path = new URL(input).pathname;
          const endpoint =
            stage === "discovery"
              ? "getOpenSubsonicExtensions"
              : stage === "key"
                ? "tokenInfo"
                : "ping";
          if (!blocked && path.endsWith(`${endpoint}.view`)) {
            blocked = true;
            return pending.promise; // Deliberately ignores the abort signal.
          }
          if (path.endsWith("getOpenSubsonicExtensions.view"))
            return response({ openSubsonicExtensions: keyExtension });
          if (path.endsWith("tokenInfo.view"))
            return response({ tokenInfo: { username: credentials.username } });
          return response(identity);
        }),
      );
      const login = { host: input.host, method: "apiKey" as const, apiKey: "test-key" };
      const first = connect(session, login);
      await vi.waitFor(() => expect(blocked).toBe(true));
      session.cancelConnect();
      session.login.cancel();
      expect(session.busy).toBe(false);
      expect(await connect(session, login)).toBe(true);
      const cache = selection.cache;
      pending.resolve(
        response({
          ...identity,
          openSubsonicExtensions: keyExtension,
          tokenInfo: { username: credentials.username },
        }),
      );
      expect(await first).toBe(false);
      expect(selection.cache).toBe(cache);
      expect(session.status).toBe("connected");
      expect(auth.load()?.credentials.method).toBe("apiKey");
    },
  );

  it.each(["cancel", "host", "method", "disconnect", "destroy"])(
    "does not activate a previously verified result after %s",
    async (action) => {
      const { session, selection, loadCache, auth } = setup();
      const verified = await session.login.connect(input);
      expect(verified).toBeDefined();
      if (action === "cancel") {
        session.cancelConnect();
        session.login.cancel();
      }
      if (action === "host") {
        session.cancelConnect();
        await session.login.discover("https://other.example");
      }
      if (action === "method") {
        session.cancelConnect();
        session.login.setMethod("apiKey");
      }
      if (action === "disconnect") session.disconnect();
      if (action === "destroy") session.destroy();
      expect(await session.connect(verified)).toBe(false);
      expect(loadCache).not.toHaveBeenCalled();
      expect(selection.cache).toBeUndefined();
      expect(auth.load()).toBeNull();
    },
  );

  it.each(["load", "retirement"])(
    "cancels %s activation without selecting or disabling the current offline workspace",
    async (stage) => {
      const { session, selection, loadCache, auth, storage } = setup();
      expect(await connect(session, input)).toBe(true);
      session.disconnect();
      const previous = selection.cache!;
      const pending = deferred();
      if (stage === "load") loadCache.mockReturnValueOnce(pending.promise);
      else vi.spyOn(previous, "flush").mockReturnValueOnce(pending.promise);
      const first = connect(session, { ...input, username: "other" });
      await vi.waitFor(() => expect(session.status).toBe("connecting"));
      await vi.waitFor(() => {
        if (stage === "load") expect(loadCache).toHaveBeenCalledTimes(2);
        else expect(previous.flush).toHaveBeenCalled();
      });
      session.cancelConnect();
      session.login.cancel(false);
      expect(session.busy).toBe(false);
      expect(session.status).toBe("disconnected");
      expect(selection.cache).toBe(previous);
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual({ host: input.host, username: input.username });
      expect(storage.getItem("navidrome-offline-mode")).toBe("true");
      previous.setQueue({ tracks: ["offline-edit"], index: 0, position: 1 });
      expect(previous.queueDirty).toBe(true);
      expect(await connect(session, input)).toBe(true);
      pending.resolve();
      expect(await first).toBe(false);
      expect(selection.cache).toBe(previous);
      expect(session.auth?.username).toBe(input.username);
      expect(previous.queueDirty).toBe(true);
    },
  );

  it("waits for verified key identity and ping before loading any account cache", async () => {
    const { session, discover, loadCache, validate, selection, auth } = setup();
    discover.mockResolvedValueOnce(keyExtension);
    const key = deferred<{ username: string }>();
    const resolve = vi
      .spyOn(SubsonicClient.prototype, "tokenInfo")
      .mockReturnValueOnce(key.promise);
    const pending = connect(session, { host: input.host, method: "apiKey", apiKey: "test-key" });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    expect(loadCache).not.toHaveBeenCalled();
    expect(selection.cache).toBeUndefined();
    expect(auth.load()).toBeNull();
    key.resolve({ username: credentials.username });
    expect(await pending).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.invocationCallOrder[0]).toBeLessThan(
      loadCache.mock.invocationCallOrder[0],
    );
    expect(selection.cache?.key).toBe(getAccountKey(credentials));
    expect(session.auth?.username).toBe(credentials.username);
    expect(auth.load()?.credentials.method).toBe("apiKey");
  });

  it.each(["invalid-key", "malformed-identity", "invalid-ping"])(
    "never selects a workspace for %s",
    async (failure) => {
      const { session, validate, loadCache, selection, auth } = setup();
      const resolve = vi.spyOn(SubsonicClient.prototype, "tokenInfo");
      if (failure === "invalid-key")
        resolve.mockRejectedValueOnce(new SubsonicError(44, "Invalid API key"));
      else if (failure === "malformed-identity")
        resolve.mockRejectedValueOnce(new Error("Invalid tokenInfo response"));
      else {
        resolve.mockResolvedValueOnce({ username: credentials.username });
        validate.mockRejectedValueOnce(new SubsonicError(41, "Unsupported authentication"));
      }
      expect(
        await connect(session, { host: input.host, method: "apiKey", apiKey: "test-key" }),
      ).toBe(false);
      expect(loadCache).not.toHaveBeenCalled();
      expect(selection.cache).toBeUndefined();
      expect(session.login.passwordConfirmation).toBeUndefined();
      expect(auth.load()).toBeNull();
    },
  );

  it("persists a separately confirmed password and clears it on disconnect", async () => {
    const { session, storage, auth } = setup();
    expect(await connect(session, { ...input, method: "password" })).toBe(false);
    expect(await session.connect(await session.login.confirmPassword())).toBe(true);
    expect(new AuthStore(storage).load()?.credentials.method).toBe("password");
    session.disconnect();
    expect(storage.getItem("navidrome-auth")).toBeNull();
    expect(auth.loadAccount()).toEqual({ host: input.host, username: input.username });
  });

  it("disconnect discards pending confirmation secrets", async () => {
    const { session, validate } = setup();
    await connect(session, { ...input, method: "password" });
    session.disconnect();
    expect(await session.login.confirmPassword()).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  });

  it.each(["discovery", "key"])("disconnect ignores late %s completion", async (stage) => {
    const { session, discover, loadCache, auth, selection, validate } = setup();
    const pending = deferred<void>();
    const resolve = vi.spyOn(SubsonicClient.prototype, "tokenInfo").mockImplementation(async () => {
      await pending.promise;
      return { username: input.username };
    });
    if (stage === "discovery")
      discover.mockImplementationOnce(async () => {
        await pending.promise;
        return keyExtension;
      });
    const first = connect(session, { host: input.host, method: "apiKey", apiKey: "test-key" });
    await vi.waitFor(() =>
      expect(stage === "discovery" ? discover : resolve).toHaveBeenCalledOnce(),
    );
    session.disconnect();
    pending.resolve();
    expect(await first).toBe(false);
    expect(session.status).toBe("disconnected");
    expect(loadCache).not.toHaveBeenCalled();
    expect(selection.cache).toBeUndefined();
    expect(auth.load()).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  it("starts with valid legacy credentials even when migration storage is full", async () => {
    const { session, auth, storage, selection, network } = setup();
    const prepare = vi.spyOn(network, "prepare");
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
    expect(prepare).toHaveBeenCalledWith(credentials, []);
    expect(storage.getItem("navidrome-auth")).toBe(original);
    expect(auth.loadAccount()).toEqual({ host: credentials.host, username: credentials.username });
    expect(storage.removeItem).not.toHaveBeenCalledWith("navidrome-auth");
  });

  it("revalidates restored key identity and ping before enabling synchronization", async () => {
    const { session, auth, discover, validate, metadata, selection } = setup();
    auth.save({ ...credentials, credentials: { method: "apiKey", apiKey: "test-key" } });
    const resolve = vi
      .spyOn(SubsonicClient.prototype, "tokenInfo")
      .mockResolvedValueOnce({ username: credentials.username });
    const save = vi.spyOn(auth, "save");
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(discover).toHaveBeenCalledOnce();
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
    "keeps the saved key's cache offline on %s failure without identity rewrite or fallback",
    async (failure) => {
      const { session, auth, validate, metadata, selection, storage } = setup();
      const saved = {
        ...credentials,
        credentials: { method: "apiKey" as const, apiKey: "test-key" },
      };
      auth.save(saved);
      const resolve = vi.spyOn(SubsonicClient.prototype, "tokenInfo");
      if (failure === "mismatch") resolve.mockResolvedValueOnce({ username: "different-account" });
      else if (failure === "malformed")
        resolve.mockRejectedValueOnce(
          new Error("The server returned an invalid tokenInfo response."),
        );
      else if (failure === "transport") resolve.mockRejectedValueOnce(new NetworkTransportError());
      else if (failure === "invalid-key")
        resolve.mockRejectedValueOnce(new SubsonicError(44, "Invalid API key"));
      else {
        resolve.mockResolvedValueOnce({ username: credentials.username });
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
      expect(session.login.passwordConfirmation).toBeUndefined();
      expect(session.error).toContain("saved library is available offline");
      expect(session.error).toContain("disconnect and sign in again");
      expect(JSON.parse(storage.getItem("navidrome-account")!).username).toBe(credentials.username);
      if (failure === "mismatch") expect(session.error).toContain("different account");
      expect(validate).toHaveBeenCalledTimes(failure === "ping" ? 1 : 0);
    },
  );

  it("ignores restored key identity completion after disconnect while retaining its offline cache", async () => {
    const { session, auth, validate, metadata, selection } = setup();
    auth.save({ ...credentials, credentials: { method: "apiKey", apiKey: "test-key" } });
    const pending = deferred<{ username: string }>();
    const resolve = vi
      .spyOn(SubsonicClient.prototype, "tokenInfo")
      .mockReturnValueOnce(pending.promise);
    session.start();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const cache = selection.cache;
    expect(session.localReady).toBe(true);
    session.disconnect();
    pending.resolve({ username: credentials.username });
    await new Promise((done) => setTimeout(done, 0));
    expect(session.status).toBe("disconnected");
    expect(selection.cache).toBe(cache);
    expect(auth.load()).toBeNull();
    expect(validate).not.toHaveBeenCalled();
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
  });

  it("restores an explicitly offline key account without discovery, tokenInfo or ping", async () => {
    const { session, auth, discover, validate, storage, selection } = setup();
    auth.save({ ...credentials, credentials: { method: "apiKey", apiKey: "test-key" } });
    storage.setItem("navidrome-offline-mode", "true");
    const resolve = vi.spyOn(SubsonicClient.prototype, "tokenInfo");
    session.start();
    await vi.waitFor(() => expect(session.localReady).toBe(true));
    expect(selection.cache?.key).toBe(getAccountKey(credentials));
    expect(discover).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("restores a persisted password without rewriting it", async () => {
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

  it("explicitly retries failed restored token discovery without treating transport failure as legacy support", async () => {
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

  it("integrates formPost token rejection and sends a password only after separate confirmation", async () => {
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
    expect(await connect(session, input)).toBe(false);
    expect(session.login.passwordConfirmation).toBe("unsupported");
    expect(requests.map(({ auth }) => auth)).toEqual([[], ["u", "t", "s"]]);
    expect(auth.load()).toBeNull();
    expect(await session.connect(await session.login.confirmPassword())).toBe(true);
    expect(requests.map(({ auth }) => auth)).toEqual([[], ["u", "t", "s"], ["u", "p"]]);
    expect(requests.map(({ post }) => post)).toEqual([false, true, true]);
    expect(requests.map(({ path }) => path)).toEqual([
      "/rest/getOpenSubsonicExtensions.view",
      "/rest/ping.view",
      "/rest/ping.view",
    ]);
  });

  it("integrates discovery, key resolution and OpenSubsonic validation before selecting a cache", async () => {
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
        expect(selection.cache).toBeUndefined();
        if (url.pathname.endsWith("tokenInfo.view"))
          return response({ tokenInfo: { username: credentials.username } });
        return response(identity);
      }),
    );
    expect(await connect(session, { host: input.host, method: "apiKey", apiKey: "test-key" })).toBe(
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

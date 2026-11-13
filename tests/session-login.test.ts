// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { SubsonicError } from "../src/subsonic-client";
import { createSession, credentials, deferred } from "./session-test-helpers";

const input = { host: credentials.host, username: credentials.username, password: " secret 音 " };
const fixtures: ReturnType<typeof createSession>[] = [];
function setup(saved = false) {
  const fixture = createSession(saved);
  fixtures.push(fixture);
  fixture.session.start();
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const identity = {
  status: "ok",
  version: "1.16.1",
  type: "test",
  serverVersion: "1",
  openSubsonic: true,
};
const reply = (response: object) => new Response(JSON.stringify({ "subsonic-response": response }));

describe("Session token/password login", () => {
  it("rejects another connection while authentication is pending", async () => {
    const { session, network, validate } = setup();
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    const first = session.connect(input);
    expect(await session.connect(input)).toBe(false);
    await vi.waitFor(() => expect(network.prepare).toHaveBeenCalledOnce());
    pending.resolve();
    expect(await first).toBe(true);
  });

  it("connects token-first without retaining the password or probing capabilities", async () => {
    const { session, network, auth, validate } = setup();
    expect(await session.connect(input)).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    expect(network.prepare).toHaveBeenCalledOnce();
    expect(session.auth?.credentials.method).toBe("token");
    expect(auth.load()).toBeNull();
    expect(auth.loadAccount()).toEqual({ host: input.host, username: input.username });
    expect(JSON.stringify(session.auth)).not.toContain(input.password);
  });

  it.each([41, 42])(
    "automatically retries protocol code %s and reuses the account/cache",
    async (code) => {
      const { session, network, auth, validate, selection } = setup(true);
      await vi.waitFor(() => expect(session.status).toBe("connected"));
      const cache = selection.cache;
      session.disconnect();
      validate.mockRestore();
      const fetcher = vi.fn<typeof fetch>(async (request) => {
        const url = new URL(String(request));
        expect(url.pathname).toBe("/rest/ping.view");
        if (url.searchParams.has("t")) {
          expect(url.searchParams.has("p")).toBe(false);
          return reply({ status: "failed", error: { code, message: "Token unsupported" } });
        }
        expect(url.protocol).toBe("https:");
        expect(url.searchParams.get("u")).toBe(input.username);
        expect(url.searchParams.get("p")).toBe(input.password);
        expect(url.searchParams.has("s")).toBe(false);
        expect(auth.load()).toBeNull();
        return reply(identity);
      });
      vi.stubGlobal("fetch", fetcher);
      const prepare = vi.mocked(network.prepare);
      const before = prepare.mock.calls.length;
      expect(await session.connect(input, true)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(prepare.mock.calls.slice(before).map(([auth]) => auth.credentials.method)).toEqual([
        "token",
        "password",
      ]);
      expect(auth.load()).toEqual({
        host: input.host,
        username: input.username,
        credentials: { method: "password", username: input.username, password: input.password },
      });
      expect(selection.cache).toBe(cache);
      session.disconnect();
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual({ host: input.host, username: input.username });
      expect(selection.cache).toBe(cache);
    },
  );

  it("reloads a memory-only connection as credential-free offline identity", async () => {
    const first = setup();
    expect(await first.session.connect(input)).toBe(true);
    expect(first.auth.load()).toBeNull();
    await first.destroy();
    fixtures.splice(fixtures.indexOf(first), 1);
    const restored = createSession(false, first.storage);
    fixtures.push(restored);
    expect(restored.session.start()).toBeNull();
    await vi.waitFor(() => expect(restored.session.localReady).toBe(true));
    expect(restored.selection.cache?.key).toBe(getAccountKey(input));
    expect(restored.session.offlineMode).toBe(true);
    expect(restored.network.prepare).not.toHaveBeenCalled();
  });

  it("persists remembered credentials only after verification and workspace acceptance", async () => {
    const { session, validate, loadCache, auth } = setup();
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    const connecting = session.connect(input, true);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    expect(auth.load()).toBeNull();
    expect(loadCache).not.toHaveBeenCalled();
    pending.resolve();
    expect(await connecting).toBe(true);
    expect(auth.load()).toEqual(session.auth);
    session.disconnect();
    expect(auth.load()).toBeNull();
  });

  it("rejects a malformed wire response without retrying or storing credentials", async () => {
    const { session, validate, network, auth } = setup();
    validate.mockRestore();
    const fetcher = vi.fn<typeof fetch>(async () =>
      reply({ status: "failed", error: { code: "41" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await session.connect(input)).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(network.prepare).toHaveBeenCalledOnce();
    expect(auth.load()).toBeNull();
    expect(session.status).toBe("error");
  });

  it("blocks direct fallback on development HTTP loopback before preparing password credentials", async () => {
    const { session, validate, network, auth } = setup();
    validate.mockRejectedValueOnce(new SubsonicError(41, "Token unsupported"));
    expect(await session.connect({ ...input, host: "http://localhost:4533" })).toBe(false);
    expect(network.prepare).toHaveBeenCalledOnce();
    expect(session.error).toContain("requires HTTPS");
    expect(auth.load()).toBeNull();
  });

  it("propagates a password rejection without recursively retrying or persisting it", async () => {
    const { session, validate, network, auth } = setup();
    validate.mockRejectedValueOnce(new SubsonicError(41, "Token unsupported"));
    validate.mockRejectedValueOnce(new SubsonicError(42, "Password rejected"));
    expect(await session.connect(input)).toBe(false);
    expect(network.prepare).toHaveBeenCalledTimes(2);
    expect(session.error).toBe("Password rejected");
    expect(auth.load()).toBeNull();
  });

  it.each(["success", "fallback", "failure"])(
    "ignores stale token %s after cancellation and immediate retry",
    async (result) => {
      const { session, validate, network, auth } = setup();
      const pending = deferred();
      validate.mockReturnValueOnce(pending.promise);
      const first = session.connect(input);
      await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
      const candidate = vi.mocked(network.prepare).mock.results[0].value;
      session.cancelConnect();
      expect(candidate.signal.aborted).toBe(true);
      expect(await session.connect(input)).toBe(true);
      const accepted = session.auth;
      if (result === "success") pending.resolve();
      else pending.reject(new SubsonicError(result === "fallback" ? 41 : 40, "Old failure"));
      expect(await first).toBe(false);
      expect(network.prepare).toHaveBeenCalledTimes(2);
      expect(session.status).toBe("connected");
      expect(session.auth).toEqual(accepted);
      expect(auth.load()).toBeNull();
    },
  );

  it.each(["success", "failure"])(
    "cancels password validation with late %s without disturbing an immediate token retry",
    async (result) => {
      const { session, validate, network, auth } = setup();
      const pending = deferred();
      validate.mockRejectedValueOnce(new SubsonicError(42, "Token unsupported"));
      validate.mockReturnValueOnce(pending.promise);
      const first = session.connect(input);
      await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
      const candidate = vi.mocked(network.prepare).mock.results[1].value;
      expect(auth.load()).toBeNull();
      session.cancelConnect();
      expect(candidate.signal.aborted).toBe(true);
      expect(await session.connect(input)).toBe(true);
      if (result === "success") pending.resolve();
      else pending.reject(new SubsonicError(41, "Old failure"));
      expect(await first).toBe(false);
      expect(
        vi.mocked(network.prepare).mock.calls.map(([auth]) => auth.credentials.method),
      ).toEqual(["token", "password", "token"]);
      expect(session.auth?.credentials.method).toBe("token");
      expect(auth.load()).toBeNull();
      expect(session.status).toBe("connected");
    },
  );

  it("cancels workspace hydration without selecting its account or disturbing the retry", async () => {
    const { session, selection, loadCache, auth } = setup();
    const pending = deferred();
    loadCache.mockReturnValueOnce(pending.promise);
    const first = session.connect({ ...input, username: "old-account" });
    await vi.waitFor(() => expect(loadCache).toHaveBeenCalledOnce());
    session.cancelConnect();
    expect(await session.connect(input)).toBe(true);
    const cache = selection.cache;
    pending.resolve();
    expect(await first).toBe(false);
    expect(selection.cache).toBe(cache);
    expect(cache?.key).toBe(getAccountKey(input));
    expect(session.auth?.username).toBe(input.username);
    expect(auth.load()).toBeNull();
  });

  it("restores saved password credentials without token derivation or changing cache identity", async () => {
    const fixture = createSession();
    fixtures.push(fixture);
    const { session, auth, network, selection } = fixture;
    auth.save({
      host: input.host,
      username: input.username,
      credentials: { method: "password", username: input.username, password: input.password },
    });
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(vi.mocked(network.prepare).mock.calls[0][0].credentials.method).toBe("password");
    expect(selection.cache?.key).toBe(getAccountKey(input));
    expect(auth.load()).toEqual(session.auth); // Existing remembered credentials are not silently deleted.
  });

  it("restores the offline account but blocks an insecure saved password before server access", async () => {
    const fixture = createSession();
    fixtures.push(fixture);
    const { session, auth, metadata, selection } = fixture;
    const host = "http://localhost:4533";
    auth.save({
      host,
      username: input.username,
      credentials: { method: "password", username: input.username, password: input.password },
    });
    vi.spyOn(Cache.prototype, "load").mockResolvedValue(undefined);
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("error"));
    expect(session.error).toContain("requires HTTPS");
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(selection.cache?.key).toBe(getAccountKey({ host, username: input.username }));
    expect(auth.load()?.credentials.method).toBe("password");
  });
});

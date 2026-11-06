// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { SubsonicError, SubsonicTransportError } from "../src/subsonic-client";
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

describe("Session token/password login", () => {
  it("connects token-first without retaining the password or probing capabilities", async () => {
    const { session, network, auth, validate } = setup();
    const prepare = vi.mocked(network.prepare);
    expect(await session.connect(input)).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(auth.load()?.credentials.method).toBe("token");
    expect(JSON.stringify(auth.load())).not.toContain(input.password);
    expect(session.login.passwordConfirmation).toBe(false);
  });

  it.each([41, 42])(
    "requires separate confirmation after protocol code %s, then reuses the account/cache",
    async (code) => {
      const { session, network, auth, validate, selection, playback } = setup(true);
      await vi.waitFor(() => expect(session.status).toBe("connected"));
      const cache = selection.cache;
      session.disconnect();
      validate.mockRejectedValueOnce(
        new SubsonicError(code, "Token authentication is unsupported"),
      );
      const prepare = vi.mocked(network.prepare);
      const before = prepare.mock.calls.length;
      expect(await session.connect(input)).toBe(false);
      expect(session.login.passwordConfirmation).toBe(true);
      expect(session.status).toBe("disconnected");
      expect(auth.load()).toBeNull();
      expect(prepare.mock.calls.slice(before).map(([auth]) => auth.credentials.method)).toEqual([
        "token",
      ]);
      expect(selection.cache).toBe(cache);
      expect(await session.connect(input)).toBe(false);
      playback.refreshQueue.mockClear();
      expect(await session.confirmPassword()).toBe(true);
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
      expect(session.login.passwordConfirmation).toBe(false);
      session.disconnect();
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual({ host: input.host, username: input.username });
      expect(selection.cache).toBe(cache);
    },
  );

  it.each([
    new SubsonicError(40, "Wrong username or password"),
    new SubsonicError(0, "Generic failure"),
    new SubsonicError(undefined, "No code"),
    new SubsonicTransportError(),
    new DOMException("Timed out", "TimeoutError"),
    new Error("The server returned HTTP 401."),
    new Error("The server returned an invalid Subsonic response."),
    new Error("Generic failure"),
  ])("never offers a direct password for $message", async (error) => {
    const { session, validate, network, auth } = setup();
    validate.mockRejectedValueOnce(error);
    expect(await session.connect(input)).toBe(false);
    expect(session.login.passwordConfirmation).toBe(false);
    expect(await session.confirmPassword()).toBe(false);
    expect(network.prepare).toHaveBeenCalledOnce();
    expect(auth.load()).toBeNull();
    expect(session.status).toBe("error");
  });

  it.each([
    { status: "failed", error: { code: 40, message: "Wrong username or password" } },
    { status: "malformed", error: { code: 41, message: "Not a valid status" } },
    { status: "failed", error: { code: "41", message: "Not a numeric code" } },
    { status: "failed", error: { code: 41, message: null } },
  ])("does not downgrade malformed or invalid-credential wire responses: %j", async (response) => {
    const { session, validate, network } = setup();
    validate.mockRestore();
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ "subsonic-response": response })),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await session.connect(input)).toBe(false);
    expect(session.login.passwordConfirmation).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(network.prepare).mock.calls[0][0].credentials.method).toBe("token");
  });

  it("canceling confirmation discards the pending password and allows immediate token retry", async () => {
    const { session, validate, network } = setup();
    validate.mockRejectedValueOnce(new SubsonicError(41, "Token unsupported"));
    await session.connect(input);
    session.cancelConnect();
    expect(session.login.passwordConfirmation).toBe(false);
    expect(await session.confirmPassword()).toBe(false);
    expect(await session.connect({ ...input, password: "new-password" })).toBe(true);
    expect(vi.mocked(network.prepare).mock.calls.map(([auth]) => auth.credentials.method)).toEqual([
      "token",
      "token",
    ]);
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
      const accepted = auth.load();
      if (result === "success") pending.resolve();
      else pending.reject(new SubsonicError(result === "fallback" ? 41 : 40, "Old failure"));
      expect(await first).toBe(false);
      expect(session.status).toBe("connected");
      expect(session.login.passwordConfirmation).toBe(false);
      expect(auth.load()).toEqual(accepted);
    },
  );

  it("cancels a confirmed password request without affecting an immediate retry", async () => {
    const { session, validate, auth } = setup();
    validate.mockRejectedValueOnce(new SubsonicError(42, "Token unsupported"));
    await session.connect(input);
    const pending = deferred();
    validate.mockReturnValueOnce(pending.promise);
    const confirming = session.confirmPassword();
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
    session.cancelConnect();
    expect(await session.connect(input)).toBe(true);
    pending.resolve();
    expect(await confirming).toBe(false);
    expect(auth.load()?.credentials.method).toBe("token");
    expect(session.status).toBe("connected");
  });

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
    expect(auth.load()?.username).toBe(input.username);
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
    expect(session.login.passwordConfirmation).toBe(false);
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
    // This test focuses transport policy; do not rely on OPFS fixtures for this account.
    vi.spyOn(Cache.prototype, "load").mockResolvedValue(undefined);
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("error"));
    expect(session.error).toContain("requires HTTPS");
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(selection.cache?.key).toBe(getAccountKey({ host, username: input.username }));
    expect(auth.load()?.credentials.method).toBe("password");
  });
});

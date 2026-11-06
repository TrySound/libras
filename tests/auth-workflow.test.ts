import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthWorkflow, createAuth } from "../src/auth.svelte";
import { normalizeServerHost } from "../src/auth";
import { Network } from "../src/network.svelte";
import {
  SubsonicClient,
  SubsonicError,
  SubsonicHttpError,
  SubsonicTransportError,
} from "../src/subsonic-client";
import { credentials, deferred } from "./session-test-helpers";

const input = { host: credentials.host, username: credentials.username, password: "test-password" };
const keys = [{ name: "apiKeyAuthentication", versions: [1] }];
const workflows: AuthWorkflow[] = [];
function setup() {
  const network = new Network();
  const workflow = new AuthWorkflow(network);
  workflows.push(workflow);
  const discovery = vi
    .spyOn(SubsonicClient.prototype, "getOpenSubsonicExtensions")
    .mockResolvedValue([]);
  const tokenInfo = vi
    .spyOn(SubsonicClient.prototype, "tokenInfo")
    .mockResolvedValue({ username: input.username });
  const validate = vi.spyOn(network, "validate").mockResolvedValue(undefined);
  const prepare = vi.spyOn(network, "prepare");
  return { workflow, network, discovery, tokenInfo, validate, prepare };
}
afterEach(() => {
  for (const workflow of workflows.splice(0)) workflow.cancel();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("AuthWorkflow", () => {
  it.each([1, 2])(
    "defaults to API key only for advertised version 1 (version %i)",
    async (version) => {
      const { workflow, discovery } = setup();
      discovery.mockResolvedValueOnce([{ name: "apiKeyAuthentication", versions: [version] }]);
      expect(await workflow.discover(input.host)).toBe(true);
      expect(workflow.method).toBe(version === 1 ? "apiKey" : "token");
      for (const method of ["token", "apiKey", "password"] as const) {
        workflow.setMethod(method);
        expect(workflow.method).toBe(method);
        expect(workflow.host).toBe(input.host);
      }
    },
  );

  it("does not prepare credentials after discovery failure and permits explicit retry", async () => {
    const { workflow, discovery, prepare } = setup();
    discovery.mockRejectedValueOnce(new SubsonicTransportError());
    expect(await workflow.connect(input)).toBeUndefined();
    expect(workflow.error).toContain("CORS");
    expect(workflow.host).toBe("");
    expect(prepare).not.toHaveBeenCalled();
    expect(await workflow.discover(input.host)).toBe(true);
  });

  it.each([41, 42])(
    "offers a separate password confirmation only after token rejection %i",
    async (code) => {
      const { workflow, validate, prepare } = setup();
      validate.mockRejectedValueOnce(new SubsonicError(code, "Token method unsupported"));
      expect(await workflow.connect(input)).toBeUndefined();
      expect(prepare.mock.calls.map(([auth]) => auth.credentials.method)).toEqual(["token"]);
      expect(workflow.passwordConfirmation).toBe("unsupported");
      expect(workflow.error).toBe(`Token method unsupported (Subsonic code ${code})`);
      const result = await workflow.confirmPassword();
      expect(result?.auth.credentials.method).toBe("password");
      expect(prepare.mock.calls.map(([auth]) => auth.credentials.method)).toEqual([
        "token",
        "password",
      ]);
    },
  );

  it.each([
    new SubsonicError(40, "Wrong credentials"),
    new SubsonicError(44, "Wrong key"),
    new SubsonicError(0, "Generic failure"),
    new SubsonicError(70, "Not found"),
    new Error("Token authentication unsupported"),
    new DOMException("Timed out", "TimeoutError"),
    new SubsonicTransportError(),
    new Error("Invalid Subsonic response"),
    new SubsonicHttpError(401),
    new SubsonicHttpError(403),
  ])("never downgrades on $name / $message", async (error) => {
    const { workflow, validate, prepare } = setup();
    validate.mockRejectedValueOnce(error);
    expect(await workflow.connect(input)).toBeUndefined();
    expect(workflow.passwordConfirmation).toBeUndefined();
    expect(prepare.mock.calls.map(([auth]) => auth.credentials.method)).toEqual(["token"]);
    expect(await workflow.confirmPassword()).toBeUndefined();
    expect(workflow.error).not.toBe("");
  });

  it("requires confirmation for explicit password selection", async () => {
    const { workflow, prepare } = setup();
    expect(await workflow.connect({ ...input, method: "password" })).toBeUndefined();
    expect(workflow.passwordConfirmation).toBe("explicit");
    expect(prepare).not.toHaveBeenCalled();
    expect((await workflow.confirmPassword())?.auth.credentials.method).toBe("password");
  });

  it.each(["explicit", "fallback"])(
    "never offers or sends a password over development HTTP (%s)",
    async (kind) => {
      const { workflow, validate, prepare } = setup();
      if (kind === "fallback") validate.mockRejectedValueOnce(new SubsonicError(41, "Unsupported"));
      expect(
        await workflow.connect({
          ...input,
          host: "http://localhost:4533",
          method: kind === "explicit" ? "password" : "token",
        }),
      ).toBeUndefined();
      expect(workflow.passwordConfirmation).toBeUndefined();
      expect(workflow.error).toContain("requires HTTPS");
      expect(prepare.mock.calls.every(([auth]) => auth.credentials.method === "token")).toBe(true);
    },
  );

  it.each(["cancel", "method", "host"])(
    "discards pending password secrets on %s",
    async (action) => {
      const { workflow, prepare } = setup();
      await workflow.connect({ ...input, method: "password" });
      if (action === "cancel") workflow.cancel(false);
      if (action === "method") workflow.setMethod("apiKey");
      if (action === "host") await workflow.discover("https://other.example");
      expect(await workflow.confirmPassword()).toBeUndefined();
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["host", "method", "cancel"])(
    "ignores stale discovery/key results after %s",
    async (action) => {
      for (const kind of ["discovery", "key"]) {
        const { workflow, discovery, tokenInfo, prepare } = setup();
        const pending = deferred<void>();
        if (kind === "discovery")
          discovery.mockImplementationOnce(async () => {
            await pending.promise;
            return keys;
          });
        else
          tokenInfo.mockImplementationOnce(async () => {
            await pending.promise;
            return { username: input.username };
          });
        const first = workflow.connect({ host: input.host, method: "apiKey", apiKey: "test-key" });
        await vi.waitFor(() =>
          expect(kind === "discovery" ? discovery : tokenInfo).toHaveBeenCalled(),
        );
        if (action === "host") await workflow.discover("https://other.example");
        if (action === "method") workflow.setMethod("token");
        if (action === "cancel") workflow.cancel();
        pending.resolve();
        expect(await first).toBeUndefined();
        expect(prepare).not.toHaveBeenCalled();
        workflow.cancel();
        vi.restoreAllMocks();
      }
    },
  );

  it.each(["invalid-key", "malformed", "ping"])(
    "never falls back from API key on %s",
    async (failure) => {
      const { workflow, tokenInfo, validate, prepare } = setup();
      if (failure === "invalid-key")
        tokenInfo.mockRejectedValueOnce(new SubsonicError(44, "Invalid key"));
      if (failure === "malformed")
        tokenInfo.mockRejectedValueOnce(new Error("Invalid tokenInfo response"));
      if (failure === "ping") validate.mockRejectedValueOnce(new SubsonicError(41, "Unsupported"));
      expect(
        await workflow.connect({ host: input.host, method: "apiKey", apiKey: "test-key" }),
      ).toBeUndefined();
      expect(workflow.passwordConfirmation).toBeUndefined();
      expect(prepare.mock.calls.every(([auth]) => auth.credentials.method === "apiKey")).toBe(true);
    },
  );

  it("returns verified identity and a capability-configured candidate without enabling access", async () => {
    const { workflow, discovery, network, validate, prepare } = setup();
    discovery.mockResolvedValueOnce(keys);
    const result = await workflow.connect({
      host: input.host,
      method: "apiKey",
      apiKey: "test-key",
    });
    expect(result?.auth).toEqual({
      ...credentials,
      credentials: { method: "apiKey", apiKey: "test-key" },
    });
    expect(prepare).toHaveBeenCalledWith(result?.auth, keys);
    expect(Object.keys(result!).sort()).toEqual(["auth", "connection"]);
    expect(validate).toHaveBeenCalledWith(result?.connection);
    expect(network.mode).toBe("offline");
    workflow.cancel();
    expect(result?.connection.signal.aborted).toBe(true);
  });

  it.each(["discovery", "key", "ping"])(
    "reports the original saved-key %s failure without changing workspace access",
    async (stage) => {
      const { workflow, network, discovery, tokenInfo, validate, prepare } = setup();
      const failure = new SubsonicError(44, "Invalid API key");
      if (stage === "discovery") discovery.mockRejectedValueOnce(failure);
      if (stage === "key") tokenInfo.mockRejectedValueOnce(failure);
      if (stage === "ping") validate.mockRejectedValueOnce(failure);
      network.setMode("online");
      await expect(
        workflow.resume({
          ...credentials,
          credentials: { method: "apiKey", apiKey: "test-key" },
        }),
      ).rejects.toBe(failure);
      expect(network.mode).toBe("online");
      expect(workflow.error).toBe("");
      expect(workflow.passwordConfirmation).toBeUndefined();
      expect(prepare).toHaveBeenCalledTimes(stage === "ping" ? 1 : 0);
      if (stage === "ping") expect(prepare.mock.results[0].value.signal.aborted).toBe(true);
    },
  );
});

describe("auth host and credential preparation", () => {
  it("preserves canonical cache host keys and prepares token credentials without access", () => {
    expect(normalizeServerHost(" music.example/base/ ")).toBe("https://music.example/base");
    const auth = createAuth({ ...input, host: " music.example/ " });
    expect(auth).toMatchObject({
      host: credentials.host,
      username: input.username,
      credentials: {
        method: "token",
        username: input.username,
        salt: expect.stringMatching(/^[a-f0-9]{24}$/),
        token: expect.stringMatching(/^[a-f0-9]{32}$/),
      },
    });
    expect(auth.credentials).not.toHaveProperty("password");
  });
  it("rejects unsafe host input without retaining secrets", () => {
    for (const host of [
      "https://user:secret@music.example",
      `${input.host}?apiKey=secret`,
      `${input.host}#p=secret`,
      "ftp://music.example",
    ]) {
      expect(() => normalizeServerHost(host)).toThrow();
      try {
        normalizeServerHost(host);
      } catch (error) {
        expect((error as Error).message).not.toContain("secret");
      }
    }
  });
  it("permits HTTP loopback only in development and never for passwords", () => {
    vi.stubEnv("DEV", true);
    for (const host of ["http://localhost:4533", "http://127.0.0.1", "http://[::1]"]) {
      expect(normalizeServerHost(host)).toBe(host);
      expect(() => normalizeServerHost(host, true)).toThrow("requires HTTPS");
      vi.stubEnv("DEV", false);
      expect(() => normalizeServerHost(host)).toThrow("require HTTPS");
      const factory = vi.fn();
      expect(() => new Network(factory).prepare({ ...credentials, host })).toThrow("require HTTPS");
      expect(factory).not.toHaveBeenCalled();
      vi.stubEnv("DEV", true);
    }
    expect(() => normalizeServerHost("http://music.example")).toThrow("require HTTPS");
  });
});

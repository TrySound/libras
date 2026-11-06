import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthWorkflow } from "../src/auth.svelte";
import { Network } from "../src/network.svelte";
import { SubsonicClient } from "../src/subsonic-client";
import { credentials, deferred } from "./session-test-helpers";

function response(fields: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("AuthWorkflow discovery protocol", () => {
  it.each([404, 405, 501])(
    "permits legacy login only for HTTP %i endpoint absence",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      const workflow = new AuthWorkflow(new Network());
      expect(await workflow.discover(credentials.host)).toBe(true);
      expect(workflow.method).toBe("token");
      workflow.cancel();
    },
  );
  it.each([0, 70, 40, 44])(
    "does not infer missing capabilities from code %i or error text",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          response({
            status: "failed",
            error: { code, message: "Unknown endpoint: not implemented" },
          }),
        ),
      );
      const workflow = new AuthWorkflow(new Network());
      expect(await workflow.discover(credentials.host)).toBe(false);
      expect(workflow.error).toContain(`Subsonic code ${code}`);
      workflow.cancel();
    },
  );
  it.each([401, 403, 500, 502])(
    "does not infer missing capabilities from HTTP %i",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      const workflow = new AuthWorkflow(new Network());
      expect(await workflow.discover(credentials.host)).toBe(false);
      expect(workflow.error).toContain(`HTTP ${status}`);
      workflow.cancel();
    },
  );
  it("distinguishes transport, malformed and explicitly unsupported discovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Unreachable"))
        .mockResolvedValueOnce(response({}))
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );
    const workflow = new AuthWorkflow(new Network());
    expect(await workflow.discover(credentials.host)).toBe(false);
    expect(workflow.error).toContain("CORS");
    expect(await workflow.discover(credentials.host)).toBe(false);
    expect(workflow.error).toContain("invalid extensions response");
    expect(await workflow.discover(credentials.host)).toBe(true);
    workflow.cancel();
  });
  it.each(["discovery", "key"])(
    "cancels late %s responses even if transport ignores abort",
    async (kind) => {
      const pending = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise),
      );
      const network = new Network();
      const workflow = new AuthWorkflow(network);
      if (kind === "key")
        vi.spyOn(SubsonicClient.prototype, "getOpenSubsonicExtensions").mockResolvedValue([]);
      const operation =
        kind === "discovery"
          ? workflow.discover(credentials.host)
          : workflow.connect({ host: credentials.host, method: "apiKey", apiKey: "test-key" });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      workflow.cancel();
      pending.resolve(
        response({ openSubsonicExtensions: [], tokenInfo: { username: "listener" } }),
      );
      expect(await operation).toBe(kind === "discovery" ? false : undefined);
      expect(network.mode).toBe("offline");
    },
  );
  it("preserves discovery, identity verification and formPost with an injected factory", async () => {
    const calls: { path: string; parameters: URLSearchParams; post: boolean }[] = [];
    const extensions = [
      { name: "formPost", versions: [1] },
      { name: "apiKeyAuthentication", versions: [1] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, options?: RequestInit) => {
        const url = new URL(input);
        calls.push({
          path: url.pathname,
          parameters: options?.body instanceof URLSearchParams ? options.body : url.searchParams,
          post: options?.method === "POST",
        });
        if (url.pathname.endsWith("getOpenSubsonicExtensions.view"))
          return response({ openSubsonicExtensions: extensions });
        if (url.pathname.endsWith("tokenInfo.view"))
          return response({ tokenInfo: { username: "listener" } });
        return response({
          version: "1.16.1",
          type: "unknown-open-server",
          serverVersion: "1",
          openSubsonic: true,
        });
      }),
    );
    const factory = vi.fn((auth, options) => new SubsonicClient(auth, options));
    const network = new Network(factory);
    const workflow = new AuthWorkflow(network);
    const result = await workflow.connect({
      host: credentials.host,
      method: "apiKey",
      apiKey: "test-key",
    });
    expect(result?.auth.username).toBe("listener");
    expect(factory).toHaveBeenCalledOnce();
    expect(calls.map(({ path }) => path)).toEqual([
      "/rest/getOpenSubsonicExtensions.view",
      "/rest/tokenInfo.view",
      "/rest/ping.view",
    ]);
    expect(calls.map(({ post }) => post)).toEqual([false, true, true]);
    for (const name of ["apiKey", "u", "p", "t", "s"])
      expect(calls[0].parameters.has(name)).toBe(false);
    for (const call of calls.slice(1)) {
      expect(call.parameters.has("apiKey")).toBe(true);
      for (const name of ["u", "p", "t", "s"]) expect(call.parameters.has(name)).toBe(false);
    }
    workflow.cancel();
  });
});

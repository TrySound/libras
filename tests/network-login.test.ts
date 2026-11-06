import { afterEach, describe, expect, it, vi } from "vitest";
import { Network, NetworkTransportError, normalizeServerHost } from "../src/network.svelte";
import { SubsonicError, SubsonicHttpError } from "../src/subsonic-client";
import { deferred, credentials } from "./session-test-helpers";
import type { Credentials } from "../src/auth";

const host = credentials.host;
function response(fields: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Network login protocol", () => {
  it("discovers without credentials and passes live formPost capabilities into key resolution and metadata", async () => {
    const calls: { path: string; parameters: URLSearchParams; post: boolean }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, options?: RequestInit) => {
        const url = new URL(input);
        const parameters =
          options?.body instanceof URLSearchParams ? options.body : url.searchParams;
        calls.push({ path: url.pathname, parameters, post: options?.method === "POST" });
        if (url.pathname.endsWith("getOpenSubsonicExtensions.view"))
          return response({
            openSubsonicExtensions: [
              { name: "formPost", versions: [1] },
              { name: "apiKeyAuthentication", versions: [1] },
            ],
          });
        if (url.pathname.endsWith("tokenInfo.view"))
          return response({ tokenInfo: { username: "listener" } });
        return response({ indexes: { lastModified: 10 } });
      }),
    );
    const network = new Network();
    const extensions = await network.discover(host);
    const auth = await network.resolveApiKey(host, "test-key", extensions);
    expect(auth.username).toBe("listener");
    const candidate = network.prepare(auth, extensions);
    await candidate.metadata.getModifiedAt();
    expect(calls.map(({ path }) => path)).toEqual([
      "/rest/getOpenSubsonicExtensions.view",
      "/rest/tokenInfo.view",
      "/rest/getIndexes.view",
    ]);
    expect(calls.map(({ post }) => post)).toEqual([false, true, true]);
    for (const name of ["apiKey", "u", "p", "t", "s"])
      expect(calls[0].parameters.has(name)).toBe(false);
    for (const call of calls.slice(1)) {
      expect(call.parameters.has("apiKey")).toBe(true);
      for (const name of ["u", "p", "t", "s"]) expect(call.parameters.has(name)).toBe(false);
    }
    network.setMode("offline");
  });

  it.each([404, 405, 501])(
    "permits legacy discovery only for explicit HTTP %i endpoint absence",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      expect(await new Network().discover(host)).toEqual([]);
    },
  );

  it.each([0, 70, 40, 44])(
    "does not interpret protocol code %i or endpoint text as missing capabilities",
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
      await expect(new Network().discover(host)).rejects.toBeInstanceOf(SubsonicError);
    },
  );

  it.each([401, 403, 500, 502])(
    "does not interpret HTTP %i as missing capabilities",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      await expect(new Network().discover(host)).rejects.toBeInstanceOf(SubsonicHttpError);
    },
  );

  it("keeps transport, malformed, and unsupported responses distinct", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Unreachable"))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const network = new Network();
    await expect(network.discover(host)).rejects.toBeInstanceOf(NetworkTransportError);
    await expect(network.discover(host)).rejects.toThrow("invalid extensions response");
    await expect(network.discover(host)).resolves.toEqual([]);
  });

  it.each(["discovery", "key"])(
    "cancels late %s completions even if the transport ignores abort",
    async (kind) => {
      const pending = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise),
      );
      const network = new Network();
      const operation =
        kind === "discovery" ? network.discover(host) : network.resolveApiKey(host, "test-key", []);
      network.cancelPending();
      pending.resolve(
        response({ openSubsonicExtensions: [], tokenInfo: { username: "listener" } }),
      );
      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
      expect(network.mode).toBe("offline");
    },
  );
});

describe("server address security", () => {
  it("preserves existing canonical cache host keys", () => {
    expect(normalizeServerHost(" music.example/base/ ")).toBe("https://music.example/base");
    expect(normalizeServerHost("https://music.example:4533/base")).toBe(
      "https://music.example:4533/base",
    );
  });

  it("rejects user information, queries, fragments, and other protocols without retaining the input", () => {
    const secret = "never-display-this";
    for (const value of [
      `https://user:${secret}@music.example`,
      `${host}?apiKey=${secret}`,
      `${host}#p=${secret}`,
      "ftp://music.example",
    ]) {
      let message = "";
      try {
        normalizeServerHost(value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.length > 0).toBe(true);
      expect(message.includes(secret)).toBe(false);
    }
  });

  it("permits HTTP loopback only in development, never for direct passwords", () => {
    vi.stubEnv("DEV", true);
    for (const address of ["http://localhost:4533", "http://127.0.0.1", "http://[::1]"]) {
      expect(normalizeServerHost(address)).toBe(address);
      expect(() => normalizeServerHost(address, true)).toThrow("requires HTTPS");
    }
    expect(() => normalizeServerHost("http://music.example")).toThrow("require HTTPS");
    vi.stubEnv("DEV", false);
    for (const address of [
      "http://localhost:4533",
      "http://127.0.0.1",
      "http://[::1]",
      "http://music.example",
    ]) {
      expect(() => normalizeServerHost(address)).toThrow("require HTTPS");
      const network = new Network();
      expect(() => network.prepare({ ...credentials, host: address })).toThrow("require HTTPS");
    }
  });

  it("rejects a credential/account username mismatch before creating a client", () => {
    const factory = vi.fn();
    const network = new Network(factory);
    expect(() => network.prepare({ ...credentials, username: "other" })).toThrow(
      "authentication is invalid",
    );
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("Network authenticated media", () => {
  const methods: Credentials[] = [
    credentials.credentials,
    { method: "apiKey", apiKey: "test-key" },
    { method: "password", username: credentials.username, password: "test-password" },
  ];
  it.each(methods)(
    "uses mutually exclusive $method credentials for metadata, artwork and audio",
    async (method) => {
      const parameters: URLSearchParams[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const url = new URL(input);
          parameters.push(url.searchParams);
          return url.pathname.endsWith("getIndexes.view") ? response({}) : new Response("media");
        }),
      );
      const network = new Network();
      network.setMode("online");
      const active = network.open({ ...credentials, credentials: method });
      await active.metadata.getModifiedAt();
      await active.artwork.read("cover", { size: 100 });
      const audio = await active.audio.read("track", {
        format: "raw",
        signal: new AbortController().signal,
      });
      expect(await audio.text()).toBe("media");
      expect(audio.url).toBe("");
      const expected =
        method.method === "apiKey"
          ? ["apiKey"]
          : method.method === "token"
            ? ["u", "t", "s"]
            : ["u", "p"];
      expect(parameters).toHaveLength(3);
      for (const params of parameters)
        for (const name of ["apiKey", "u", "p", "t", "s"])
          expect(params.has(name)).toBe(expected.includes(name));
      network.setMode("offline");
    },
  );

  it("preserves cancellation when an audio body read fails after disconnect", async () => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(credentials);
    let source!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
              },
            }),
          ),
      ),
    );
    const download = await active.audio.read("track", {
      format: "raw",
      signal: new AbortController().signal,
    });
    network.setMode("offline");
    source.error(new TypeError("Read failed"));
    await expect(download.text()).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["artwork", "audio"])("redacts %s transport and body-read failures", async (kind) => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(credentials);
    const read = async () =>
      kind === "artwork"
        ? active.artwork.read("cover", { size: 100 })
        : (
            await active.audio.read("track", {
              format: "raw",
              signal: new AbortController().signal,
            })
          ).text();
    const unsafe = new TypeError("A credential-bearing URL must not escape");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(unsafe)
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(unsafe);
              },
            }),
          ),
        ),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(read()).rejects.toBeInstanceOf(NetworkTransportError);
    }
    network.setMode("offline");
  });
});

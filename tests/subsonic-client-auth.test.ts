import { describe, expect, it, vi } from "vitest";
import type { Credentials } from "../src/auth";
import {
  SubsonicClient,
  SubsonicError,
  SubsonicHttpError,
  SubsonicTransportError,
  getOpenSubsonicExtensions,
} from "../src/subsonic-client";

const host = "https://music.example/base";
const credentials: Credentials[] = [
  { method: "apiKey", apiKey: "key & 音+secret" },
  { method: "token", username: "listener", token: "token-secret", salt: "salt-secret" },
  { method: "password", username: "listener", password: " enc:secret & 音+ " },
];
const page = {
  artistCount: 1,
  artistOffset: 0,
  albumCount: 1,
  albumOffset: 0,
  songCount: 1,
  songOffset: 0,
};
const identity = { version: "1.16.1", type: "custom", serverVersion: "1", openSubsonic: true };
const extensions = [
  { name: "apiKeyAuthentication", versions: [1] },
  { name: "formPost", versions: [1] },
];
function response(fields: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }));
}
function assertAuth(query: URLSearchParams, value: Credentials) {
  const actual = Object.fromEntries(
    [...query].filter(([key]) => ["u", "p", "t", "s", "apiKey"].includes(key)),
  );
  const expected =
    value.method === "apiKey"
      ? { apiKey: value.apiKey }
      : value.method === "token"
        ? { u: value.username, t: value.token, s: value.salt }
        : { u: value.username, p: value.password };
  expect(actual).toEqual(expected);
  for (const key of Object.keys(expected)) expect(query.getAll(key)).toHaveLength(1);
}

describe("SubsonicClient authentication", () => {
  it.each(credentials)(
    "uses exclusive $method credentials for JSON, writes, artwork and streaming",
    async (value) => {
      const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        response({ ...identity, searchResult3: {} }),
      );
      const client = new SubsonicClient({ host, credentials: value }, { fetch: fetcher });
      await client.ping();
      await client.search3({
        ...page,
        u: "attacker",
        p: "attacker",
        t: "attacker",
        s: "attacker",
        apiKey: "attacker",
        v: "bad",
        c: "bad",
        f: "xml",
      } as typeof page);
      await client.createPlaylist("mix", ["one", "one"]);
      await client.savePlayQueue({ tracks: ["one", "one"], position: 0 });
      for (const index of [0, 1]) {
        const query = new URL(String(fetcher.mock.calls[index][0])).searchParams;
        assertAuth(query, value);
        expect(query.get("v")).toBe("1.16.1");
        expect(query.get("c")).toBe("libras");
        expect(query.get("f")).toBe("json");
      }
      for (const index of [2, 3]) {
        const [url, init] = fetcher.mock.calls[index];
        expect(new URL(String(url)).search).toBe("");
        expect(init?.method).toBe("POST");
        assertAuth(init?.body as URLSearchParams, value);
      }
      expect((fetcher.mock.calls[2][1]?.body as URLSearchParams).getAll("songId")).toEqual([
        "one",
        "one",
      ]);
      expect((fetcher.mock.calls[3][1]?.body as URLSearchParams).getAll("id")).toEqual([
        "one",
        "one",
      ]);
      assertAuth(new URL(client.getCoverArtUrl("cover", 500)).searchParams, value);
      assertAuth(new URL(client.getStreamUrl("track")).searchParams, value);
    },
  );

  it.each(credentials)(
    "prefers advertised form POST for $method JSON, not media URLs",
    async (value) => {
      const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        response(identity),
      );
      const client = new SubsonicClient(
        { host, credentials: value },
        { extensions, fetch: fetcher },
      );
      await expect(client.ping()).resolves.toEqual(identity);
      const [url, init] = fetcher.mock.calls[0];
      expect(new URL(String(url)).search).toBe("");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
      assertAuth(init?.body as URLSearchParams, value);
      assertAuth(new URL(client.getStreamUrl("track")).searchParams, value);
      assertAuth(new URL(client.getCoverArtUrl("cover")).searchParams, value);
    },
  );

  it.each([[{ name: "formPost", versions: [2] }], [{ name: "FormPost", versions: [1] }], []])(
    "does not guess form POST support from %j",
    async (...advertised) => {
      const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        response(identity),
      );
      const client = new SubsonicClient(
        { host, credentials: credentials[0] },
        { fetch: fetcher, extensions: advertised },
      );
      await client.ping();
      expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
    },
  );

  it.each([40, 41, 42, 43, 44, 0])(
    "preserves code %s with no automatic downgrade or retry",
    async (code) => {
      const fetcher = vi.fn(async () =>
        response({ status: "failed", error: { code, message: "Authentication rejected" } }),
      );
      const client = new SubsonicClient({ host, credentials: credentials[0] }, { fetch: fetcher });
      await expect(client.ping()).rejects.toMatchObject({
        name: "SubsonicError",
        code,
        message: "Authentication rejected",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(credentials)(
    "does not expose $method secrets in server or transport errors",
    async (value) => {
      const secrets = Object.entries(value)
        .filter(([key]) => key !== "method")
        .map(([, value]) => value);
      const message = secrets
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          new URLSearchParams({ x: secret }).toString().slice(2),
        ])
        .join("; ");
      const fetcher = vi.fn(async () =>
        response({ status: "failed", error: { code: 42, message } }),
      );
      const client = new SubsonicClient({ host, credentials: value }, { fetch: fetcher });
      const error = await client.ping().catch((error) => error);
      expect(error).toBeInstanceOf(SubsonicError);
      expect(error.code).toBe(42);
      for (const secret of secrets) expect(error.message).not.toContain(secret);
      const transport = new SubsonicClient(
        { host, credentials: value },
        {
          fetch: async () => {
            throw new TypeError(`Failed: ${message}`);
          },
        },
      );
      await expect(transport.ping()).rejects.toMatchObject({
        name: "SubsonicTransportError",
        message: "The server request failed.",
      });
      await expect(transport.ping()).rejects.not.toHaveProperty("cause");
    },
  );

  it.each<Credentials>([
    { method: "password", username: "listener", password: "listener-secret" },
    { method: "password", username: "enc", password: "enc:音" },
    { method: "password", username: "音 +", password: "音 + secret" },
    { method: "password", username: "listener", password: "redacted" },
    {
      method: "token",
      username: "listener",
      token: "listener-secret",
      salt: "listener-secret-salt",
    },
    { method: "token", username: "[a.*]", token: "[a.*]-token", salt: "[a.*]-token-salt" },
    { method: "apiKey", apiKey: "redacted" },
    { method: "apiKey", apiKey: "[key.*] & 音+" },
  ])("redacts overlapping $method secrets in a single non-recursive pass: %j", async (value) => {
    const secrets = Object.entries(value)
      .filter(([key]) => key !== "method")
      .map(([, secret]) => secret);
    const client = new SubsonicClient(
      { host, credentials: value },
      {
        fetch: async (url) => {
          const wire = new URL(String(url)).searchParams;
          const variants = [
            ...secrets,
            ...["u", "p", "t", "s", "apiKey"].flatMap((key) =>
              wire.has(key) ? [wire.get(key)!] : [],
            ),
          ].flatMap((secret) => [
            secret,
            encodeURIComponent(secret),
            new URLSearchParams({ x: secret }).toString().slice(2),
          ]);
          return response({
            status: "failed",
            error: { code: 42, message: `Rejected ${variants.join("; ")}` },
          });
        },
      },
    );
    const variantCount = secrets.length * 6;
    await expect(client.ping()).rejects.toMatchObject({
      code: 42,
      message: `Rejected ${Array(variantCount).fill("[redacted]").join("; ")}`,
    });
  });

  it("escapes literal enc: password prefixes and redacts the wire encoding", async () => {
    const value = { method: "password" as const, username: "listener", password: "enc:音" };
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const password = (init?.body as URLSearchParams).get("p")!;
      expect(password).toBe("enc:656e633ae99fb3");
      return response({ status: "failed", error: { code: 40, message: `Rejected ${password}` } });
    });
    const client = new SubsonicClient({ host, credentials: value }, { fetch: fetcher, extensions });
    await expect(client.ping()).rejects.toMatchObject({ code: 40, message: "Rejected [redacted]" });
  });

  it("replaces invalid JSON errors that could contain response secrets", async () => {
    const client = new SubsonicClient(
      { host, credentials: credentials[0] },
      { fetch: async () => new Response("secret in non-JSON response") },
    );
    await expect(client.ping()).rejects.toThrow(
      "The server returned an invalid Subsonic response.",
    );
  });
});

describe("getOpenSubsonicExtensions", () => {
  it("discovers the documented array unauthenticated, even on an authenticated client", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response({ openSubsonicExtensions: extensions }),
    );
    const client = new SubsonicClient(
      { host, credentials: credentials[0] },
      { fetch: fetcher, extensions },
    );
    expect(await client.getOpenSubsonicExtensions()).toEqual(extensions);
    expect(await getOpenSubsonicExtensions(host, { fetch: fetcher })).toEqual(extensions);
    for (const [input, init] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/base/rest/getOpenSubsonicExtensions.view");
      expect(Object.fromEntries(url.searchParams)).toEqual({ v: "1.16.1", c: "libras", f: "json" });
      expect(init?.method).toBeUndefined();
    }
  });

  it("accepts an empty extension array but not a missing or malformed wrapper", async () => {
    await expect(
      getOpenSubsonicExtensions(host, {
        fetch: async () => response({ openSubsonicExtensions: [] }),
      }),
    ).resolves.toEqual([]);
    for (const fields of [
      {},
      { openSubsonicExtensions: {} },
      { openSubsonicExtensions: [{ name: "formPost", versions: "1" }] },
    ])
      await expect(
        getOpenSubsonicExtensions(host, { fetch: async () => response(fields) }),
      ).rejects.toThrow("invalid");
  });

  it.each([404, 405, 501, 401, 403, 500])(
    "preserves HTTP %s for owning-layer unsupported discovery policy",
    async (status) => {
      const error = await getOpenSubsonicExtensions(host, {
        fetch: async () => new Response(null, { status }),
      }).catch((error) => error);
      expect(error).toBeInstanceOf(SubsonicHttpError);
      expect(error.status).toBe(status);
    },
  );

  it("distinguishes transport, malformed and generic protocol failures, never returning missing capabilities", async () => {
    await expect(
      getOpenSubsonicExtensions(host, {
        fetch: async () => {
          throw new TypeError("CORS");
        },
      }),
    ).rejects.toBeInstanceOf(SubsonicTransportError);
    await expect(
      getOpenSubsonicExtensions(host, { fetch: async () => new Response("HTML") }),
    ).rejects.toThrow("invalid Subsonic response");
    await expect(
      getOpenSubsonicExtensions(host, {
        fetch: async () =>
          response({ status: "failed", error: { code: 0, message: "Unknown method" } }),
      }),
    ).rejects.toMatchObject({ name: "SubsonicError", code: 0 });
  });

  it("honors cancellation before dispatch and after a late discovery response", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => response({ openSubsonicExtensions: [] }));
    await expect(
      getOpenSubsonicExtensions(host, { fetch: fetcher }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    const pendingController = new AbortController();
    const lateFetcher = vi.fn(async () => {
      pendingController.abort();
      return response({ openSubsonicExtensions: [] });
    });
    await expect(
      getOpenSubsonicExtensions(host, { fetch: lateFetcher }, pendingController.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("SubsonicClient.tokenInfo", () => {
  it("validates an API key and resolves only the documented username", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      response({ tokenInfo: { username: "resolved-user", ignored: "not identity" } }),
    );
    const client = new SubsonicClient(
      { host, credentials: credentials[0] },
      { fetch: fetcher, extensions },
    );
    await expect(client.tokenInfo()).resolves.toEqual({ username: "resolved-user" });
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/base/rest/tokenInfo.view");
    assertAuth(fetcher.mock.calls[0][1]?.body as URLSearchParams, credentials[0]);
  });

  it.each([
    {},
    { tokenInfo: {} },
    { tokenInfo: { username: "" } },
    { tokenInfo: { username: 12 } },
  ])("rejects missing or malformed token identity %j", async (fields) => {
    const client = new SubsonicClient(
      { host, credentials: credentials[0] },
      { fetch: async () => response(fields) },
    );
    await expect(client.tokenInfo()).rejects.toThrow("invalid");
  });

  it("preserves invalid-key code 44 without another request or method", async () => {
    const fetcher = vi.fn(async () =>
      response({ status: "failed", error: { code: 44, message: "Invalid API key" } }),
    );
    const client = new SubsonicClient({ host, credentials: credentials[0] }, { fetch: fetcher });
    await expect(client.tokenInfo()).rejects.toMatchObject({ code: 44 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not send tokenInfo with another credential type and honors abort", async () => {
    const fetcher = vi.fn(async () => response({ tokenInfo: { username: "listener" } }));
    const client = new SubsonicClient({ host, credentials: credentials[1] }, { fetch: fetcher });
    await expect(client.tokenInfo()).rejects.toThrow("API-key credentials are required");
    expect(fetcher).not.toHaveBeenCalled();
    const keyClient = new SubsonicClient({ host, credentials: credentials[0] }, { fetch: fetcher });
    const controller = new AbortController();
    controller.abort();
    await expect(keyClient.tokenInfo(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

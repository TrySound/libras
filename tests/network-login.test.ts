import { afterEach, describe, expect, it, vi } from "vitest";
import { Network, NetworkTransportError } from "../src/network.svelte";
import { credentials } from "./session-test-helpers";
import type { Credentials } from "../src/auth";

function response(fields: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      const active = network.accept(network.prepare({ ...credentials, credentials: method }));
      await active.metadata.getModifiedAt();
      await active.artwork.read("cover", { size: 100 });
      const audio = await active.audio.read("track", {
        format: "raw",
        signal: new AbortController().signal,
      });
      expect(await audio.text()).toBe("media");
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

  it.each(["artwork", "audio"])("redacts %s fetch failures", async (kind) => {
    const network = new Network();
    const active = network.accept(network.prepare(credentials));
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
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(unsafe));
    await expect(read()).rejects.toBeInstanceOf(NetworkTransportError);
    network.setMode("offline");
  });
});

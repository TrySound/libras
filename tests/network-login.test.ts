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

  it("keeps native download response consumers, headers and status without exposing the remote URL", async () => {
    const network = new Network();
    const active = network.accept(network.prepare(credentials));
    let reads = 0;
    const cancel = vi.fn();
    const original = new Response(
      new ReadableStream(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new TextEncoder().encode("audio"));
            controller.close();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      {
        status: 206,
        statusText: "Partial Content",
        headers: { "Content-Type": "audio/mpeg", "Content-Length": "5" },
      },
    );
    Object.defineProperty(original, "url", {
      value: `${credentials.host}/rest/stream.view?apiKey=test-key`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => original),
    );
    const download = await active.audio.read("track", {
      format: "raw",
      signal: new AbortController().signal,
    });
    expect(download).toBeInstanceOf(Response);
    expect(download.url).toBe("");
    expect(download.status).toBe(206);
    expect(download.statusText).toBe("Partial Content");
    expect(download.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(download.headers.get("Content-Length")).toBe("5");
    expect(download.bodyUsed).toBe(false);
    expect(download.body?.locked).toBe(false);
    expect(reads).toBe(0);
    expect(await download.text()).toBe("audio");
    expect(download.bodyUsed).toBe(true);
    network.setMode("offline");
  });

  it("forwards cancellation of an unused download to the remote source", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const network = new Network();
    const active = network.accept(network.prepare(credentials));
    const download = await active.audio.read("track", {
      format: "raw",
      signal: new AbortController().signal,
    });
    await download.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    network.setMode("offline");
  });

  it("cancels the adapted remote source if disconnect races with response publication", async () => {
    const cancel = vi.fn();
    const original = new Response(new ReadableStream({ cancel }));
    const network = new Network();
    const active = network.accept(network.prepare(credentials));
    const getReader = original.body!.getReader.bind(original.body!);
    vi.spyOn(original.body!, "getReader").mockImplementation(() => {
      network.setMode("offline");
      return getReader();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => original),
    );
    await expect(
      active.audio.read("track", {
        format: "raw",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["artwork", "audio"])("redacts %s fetch and asynchronous body failures", async (kind) => {
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
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(read()).rejects.toBeInstanceOf(NetworkTransportError);
    network.setMode("offline");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Network, NetworkTransportError } from "../src/network.svelte";
import { deferred } from "./session-test-helpers";

const auth = { host: "https://music.example", username: "listener", token: "token", salt: "salt" };
const success = () => new Response(JSON.stringify({ "subsonic-response": { status: "ok" } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit credential validation", () => {
  it("uses only an authenticated ping without enabling access or fetching metadata", async () => {
    const network = new Network();
    const connection = network.prepare(auth);
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => success());
    vi.stubGlobal("fetch", fetcher);
    await network.validate(connection);
    expect(fetcher).toHaveBeenCalledOnce();
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.pathname).toBe("/rest/ping.view");
    expect(url.searchParams.get("u")).toBe(auth.username);
    expect(url.searchParams.get("t")).toBe(auth.token);
    expect(url.searchParams.get("s")).toBe(auth.salt);
    expect(fetcher.mock.calls[0][1]?.signal).toBe(connection.signal);
    expect(network.mode).toBe("offline");
    expect(connection.signal.aborted).toBe(false);
    network.accept(connection);
    expect(network.mode).toBe("online");
    network.setMode("offline");
  });

  it.each(["credentials", "http", "malformed", "transport"])(
    "rejects %s failures without accepting the connection",
    async (failure) => {
      const network = new Network();
      const connection = network.prepare(auth);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "transport") throw new TypeError("Network failed");
          if (failure === "http") return new Response(null, { status: 401 });
          if (failure === "malformed") return new Response(JSON.stringify({ unexpected: true }));
          return new Response(
            JSON.stringify({
              "subsonic-response": {
                status: "failed",
                error: { code: 40, message: "Wrong username or password" },
              },
            }),
          );
        }),
      );
      const pending = network.validate(connection);
      if (failure === "transport")
        await expect(pending).rejects.toBeInstanceOf(NetworkTransportError);
      else
        await expect(pending).rejects.toThrow(
          failure === "credentials"
            ? "Wrong username or password"
            : failure === "http"
              ? "HTTP 401"
              : "invalid Subsonic response",
        );
      expect(network.mode).toBe("offline");
      network.setMode("offline");
    },
  );

  it.each(["disconnect", "replace"])(
    "rejects a late validation result after %s",
    async (action) => {
      const network = new Network();
      const connection = network.prepare(auth);
      const response = deferred<Response>();
      const fetcher = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", fetcher);
      const pending = network.validate(connection);
      if (action === "disconnect") network.setMode("offline");
      else network.prepare({ ...auth, username: "other" });
      response.resolve(success());
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(network.validate(connection)).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(network.mode).toBe("offline");
      network.setMode("offline");
    },
  );

  it("rejects foreign or copied candidates without making a request", async () => {
    const network = new Network();
    const other = new Network();
    const connection = network.prepare(auth);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(network.validate({ ...connection })).rejects.toThrow("Connection superseded");
    await expect(network.validate(other.prepare(auth))).rejects.toThrow("Connection superseded");
    expect(fetcher).not.toHaveBeenCalled();
    network.setMode("offline");
    other.setMode("offline");
  });
});

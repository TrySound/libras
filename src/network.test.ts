import { describe, expect, it, vi } from "vitest";
import { Network } from "./network.svelte";

const auth = {
  host: "https://music.example",
  username: "listener",
  token: "token",
  salt: "salt",
};

describe("Network connection lifecycle", () => {
  it("starts offline and refuses normal access until explicitly enabled", () => {
    const network = new Network();
    expect(network.mode).toBe("offline");
    expect(() => network.open(auth)).toThrow("Network access is offline");
    network.setMode("online");
    const client = network.open(auth);
    expect(client.signal.aborted).toBe(false);
    network.setMode("offline");
    expect(client.signal.aborted).toBe(true);
    expect(() => client.getStreamUrl("track")).toThrowError(/abort/i);
  });

  it("allows isolated login preparation while offline, enabling access only on acceptance", () => {
    const network = new Network();
    const candidate = network.prepare(auth);
    expect(network.mode).toBe("offline");
    expect(candidate.signal.aborted).toBe(false);
    expect(() => network.open(auth)).toThrow("Network access is offline");
    network.accept(candidate);
    expect(network.mode).toBe("online");
    network.setMode("offline");
    expect(candidate.signal.aborted).toBe(true);
  });

  it("replaces candidates without disturbing the active connection until acceptance", () => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(auth);
    const stale = network.prepare({ ...auth, username: "second" });
    const candidate = network.prepare({ ...auth, username: "third" });
    expect(stale.signal.aborted).toBe(true);
    expect(active.signal.aborted).toBe(false);
    expect(() => network.accept(stale)).toThrowError(/abort/i);
    network.accept(candidate);
    expect(active.signal.aborted).toBe(true);
    expect(candidate.signal.aborted).toBe(false);
    network.setMode("offline");
  });

  it("rejects a candidate owned by another Network", () => {
    const network = new Network();
    const other = new Network();
    const candidate = other.prepare(auth);
    expect(() => network.accept(candidate)).toThrow("Connection superseded");
    expect(network.mode).toBe("offline");
    expect(candidate.signal.aborted).toBe(false);
    other.setMode("offline");
  });

  it("aborts active and candidate work offline and never revives old clients", () => {
    const network = new Network();
    network.setMode("online");
    const active = network.open(auth);
    const candidate = network.prepare(auth);
    network.setMode("offline");
    network.setMode("offline");
    expect(active.signal.aborted).toBe(true);
    expect(candidate.signal.aborted).toBe(true);
    expect(() => network.accept(candidate)).toThrowError(/abort/i);
    network.setMode("online");
    const resumed = network.open(auth);
    expect(resumed).not.toBe(active);
    expect(resumed).not.toBe(candidate);
    expect(resumed.signal.aborted).toBe(false);
    expect(active.signal.aborted).toBe(true);
    network.setMode("offline");
  });

  it("keeps metadata bound to its candidate through acceptance and rejects it after replacement", async () => {
    const network = new Network();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            "subsonic-response": { status: "ok", artists: { index: [] } },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const candidate = network.prepare(auth);
      const metadata = network.metadata(candidate);
      expect(metadata.account).toEqual({ host: auth.host, username: auth.username });
      expect(network.mode).toBe("offline");
      await expect(metadata.listArtists()).resolves.toEqual([]);
      network.accept(candidate);
      await expect(metadata.listArtists()).resolves.toEqual([]);
      const replacement = network.prepare({ ...auth, username: "other" });
      await expect(metadata.listArtists()).resolves.toEqual([]);
      network.accept(replacement);
      const requests = fetch.mock.calls.length;
      await expect(metadata.listArtists()).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).toHaveBeenCalledTimes(requests);
      expect(() => network.metadata(candidate)).toThrowError(/abort/i);
      expect(network.metadata(replacement).account.username).toBe("other");
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });

  it("rejects a late SDK response after network access is revoked", async () => {
    const network = new Network();
    let respond!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      network.setMode("online");
      const client = network.open(auth);
      const request = network.metadata(client).listArtists();
      const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch.mock.calls[0]).toEqual([expect.any(String), { signal: client.signal }]);
      network.setMode("offline");
      respond(new Response(JSON.stringify({ "subsonic-response": { status: "ok" } })));
      await rejection;
    } finally {
      network.setMode("offline");
      vi.unstubAllGlobals();
    }
  });
});

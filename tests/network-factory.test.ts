import { describe, expect, it, vi } from "vitest";
import { Network } from "../src/network.svelte";
import type { SubsonicApi, SubsonicAuth } from "../src/subsonic-client";

const auth = { host: "https://example.test/demo", username: "demo", token: "local", salt: "local" };
function client(identity: SubsonicAuth): SubsonicApi {
  const controller = new AbortController();
  return {
    host: identity.host,
    username: identity.username,
    signal: controller.signal,
    abort: () => controller.abort(),
    ping: vi.fn(async () => ({
      version: "1.16.1",
      type: "test",
      serverVersion: "1",
      openSubsonic: true as const,
    })),
    getIndexes: async () => 1,
    search3: async () => ({ artists: [], albums: [], tracks: [] }),
    getCoverArtUrl: (id) => `https://example.test/covers/${id}`,
    getStreamUrl: (id) => `https://example.test/audio/${id}`,
    getPlayQueue: async () => ({ tracks: [], position: 0 }),
    savePlayQueue: async () => {},
  };
}

describe("Network client composition", () => {
  it("uses a structural client while retaining validation and connection ownership", async () => {
    const instance = client(auth);
    const factory = vi.fn(() => instance);
    const network = new Network(factory);
    const candidate = network.prepare(auth);
    expect(factory).toHaveBeenCalledWith(auth, { fetch: expect.any(Function) });
    expect(network.mode).toBe("offline");
    await network.validate(candidate);
    expect(instance.ping).toHaveBeenCalledOnce();
    const active = network.accept(candidate);
    expect(active.audio.url("track", { format: "raw" })).toBe("https://example.test/audio/track");
    expect(active.artwork.url("art", 100)).toBe("https://example.test/covers/art");
    expect(await active.metadata.readLibrary(new AbortController().signal)).toEqual({
      artists: [],
      albums: [],
      tracks: [],
    });
    network.setMode("offline");
    expect(instance.signal.aborted).toBe(true);
    expect(() => active.audio.url("track", { format: "raw" })).toThrow();
  });

  it("aborts superseded clients without aborting their replacements", async () => {
    const network = new Network((auth) => client(auth));
    const first = network.prepare(auth);
    const second = network.prepare(auth);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    await expect(network.validate(first)).rejects.toMatchObject({ name: "AbortError" });
    network.accept(second);
    network.setMode("offline");
    expect(second.signal.aborted).toBe(true);
  });
});

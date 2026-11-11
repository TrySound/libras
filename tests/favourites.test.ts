import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { Favourites } from "../src/favourites.svelte";
import type { FavouriteState, FavouriteTarget } from "../src/schema";
import { SubsonicError, SubsonicTransportError } from "../src/subsonic-client";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const account = { host: "https://host", username: "user" };
  const cache = new Cache(getAccountKey(account));
  vi.spyOn(cache, "artists", "get").mockReturnValue(
    new Map([["same", { id: "same", name: "Artist", localOnly: false }]]),
  );
  let state: FavouriteState = { fetchedAt: null, artists: [], albums: [], tracks: [] };
  let remote: FavouriteState = { ...state, fetchedAt: 1 };
  vi.spyOn(cache, "favourites", "get").mockImplementation(() => state);
  const publish = vi.spyOn(cache, "setFavourites").mockImplementation((value) => {
    state = structuredClone(value) as FavouriteState;
  });
  const selection = { cache };
  const controller = new AbortController();
  const connection = {
    account,
    signal: controller.signal,
    read: vi.fn(async () => structuredClone(remote)),
    mutate: vi.fn(async (target: FavouriteTarget, selected: boolean) => {
      remote[target.kind] = selected
        ? [...remote[target.kind], { id: target.id, title: target.id }]
        : remote[target.kind].filter((item) => item.id !== target.id);
    }),
  };
  const engine = new Favourites(selection);
  engine.setConnection(connection);
  return { engine, cache, selection, connection, controller, publish };
}
const artist = { kind: "artists", id: "same" } as const;
describe("server-confirmed favourites", () => {
  it("keeps overlapping IDs independent and prevents duplicate pending writes", async () => {
    const s = setup();
    await Promise.all([
      s.engine.toggle(artist),
      s.engine.toggle(artist),
      s.engine.toggle({ kind: "tracks", id: "same" }),
    ]);
    expect(s.connection.mutate).toHaveBeenCalledTimes(2);
    expect(s.engine.has(artist)).toBe(true);
    expect(s.engine.has({ kind: "tracks", id: "same" })).toBe(true);
    expect(s.engine.has({ kind: "albums", id: "same" })).toBe(false);
    await s.engine.toggle(artist);
    expect(s.engine.has(artist)).toBe(false);
    expect(s.engine.has({ kind: "tracks", id: "same" })).toBe(true);
  });
  it.each([true, false])(
    "stores pending intent %s once, including a false removal, and guards duplicates",
    async (intended) => {
      const s = setup();
      if (!intended) await s.engine.toggle(artist);
      const before = s.connection.mutate.mock.calls.length;
      const gate = Promise.withResolvers<void>();
      const apply = s.connection.mutate.getMockImplementation()!;
      s.connection.mutate.mockImplementationOnce(async (...args) => {
        await gate.promise;
        await apply(...args);
      });
      const edit = s.engine.toggle(artist);
      const key = s.engine.key(artist);
      expect(s.engine.pending.has(key)).toBe(true);
      expect(s.engine.pending.get(key)).toBe(intended);
      await s.engine.toggle(artist);
      await vi.waitFor(() => expect(s.connection.mutate).toHaveBeenCalledTimes(before + 1));
      expect(s.engine.has(artist)).toBe(!intended);
      gate.resolve();
      await edit;
      expect(s.engine.pending.has(key)).toBe(false);
      expect(s.engine.has(artist)).toBe(intended);
    },
  );
  it("does not let retired completion remove a newer pending removal for the same key", async () => {
    const s = setup();
    const old = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    const read = s.connection.read.getMockImplementation()!;
    s.connection.read.mockImplementationOnce(async () => {
      await old.promise;
      return read();
    });
    const oldEdit = s.engine.toggle(artist).catch((error) => error);
    await vi.waitFor(() => expect(s.connection.read).toHaveBeenCalledOnce());
    s.engine.setConnection(s.connection);
    await s.engine.refresh(); // Resolve the captured cache's unknown outcome authoritatively.
    s.connection.read.mockImplementationOnce(async () => {
      await current.promise;
      return read();
    });
    const currentEdit = s.engine.toggle(artist);
    const key = s.engine.key(artist);
    await vi.waitFor(() => expect(s.connection.read).toHaveBeenCalledTimes(3));
    expect(s.engine.pending.has(key)).toBe(true);
    expect(s.engine.pending.get(key)).toBe(false);
    old.resolve();
    expect(await oldEdit).toMatchObject({ name: "AbortError" });
    expect(s.engine.pending.has(key)).toBe(true);
    expect(s.engine.pending.get(key)).toBe(false);
    expect(s.engine.error).toBeUndefined();
    current.resolve();
    await currentEdit;
    expect(s.engine.pending.size).toBe(0);
  });
  it("rejects explicit local provenance, never an arbitrary server ID prefix", async () => {
    const s = setup();
    vi.spyOn(s.cache, "artists", "get").mockReturnValue(
      new Map([
        ["synthetic", { id: "synthetic", name: "Display credit", localOnly: true }],
        [
          "local:artist:server",
          { id: "local:artist:server", name: "Real server artist", localOnly: false },
        ],
      ]),
    );
    await expect(s.engine.toggle({ kind: "artists", id: "synthetic" })).rejects.toThrow(
      "local collection",
    );
    expect(s.connection.mutate).not.toHaveBeenCalled();
    await s.engine.toggle({ kind: "artists", id: "local:artist:server" });
    expect(s.connection.mutate).toHaveBeenCalledOnce();
  });

  it("reconciles a transport failure without repeating the write", async () => {
    const s = setup();
    const apply = s.connection.mutate.getMockImplementation()!;
    s.connection.mutate.mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw new SubsonicTransportError();
    });
    await s.engine.toggle(artist);
    expect(s.engine.has(artist)).toBe(true);
    expect(s.connection.mutate).toHaveBeenCalledOnce();
  });
  it("preserves confirmed content and blocks writes after unknown outcome until refresh", async () => {
    const s = setup();
    await s.engine.toggle(artist);
    s.connection.read.mockRejectedValueOnce(new Error("read failed"));
    await expect(s.engine.toggle(artist)).rejects.toThrow("Outcome unknown");
    expect(s.engine.has(artist)).toBe(true);
    await expect(s.engine.toggle(artist)).rejects.toThrow("refresh");
    expect(s.connection.mutate).toHaveBeenCalledTimes(2);
    await s.engine.refresh();
    expect(s.engine.has(artist)).toBe(false);
    expect(s.engine.outcomeUnknown).toBe(false);
  });
  it.each([false, true])(
    "reports structured rejection without local fallback (already selected: %s)",
    async (selected) => {
      const s = setup();
      if (selected) await s.engine.toggle(artist);
      s.publish.mockClear();
      s.connection.read.mockClear();
      s.connection.mutate.mockRejectedValueOnce(new SubsonicError(50, "Not supported"));
      await expect(s.engine.toggle(artist)).rejects.toThrow("Not supported");
      expect(s.publish).not.toHaveBeenCalled();
      expect(s.connection.read).not.toHaveBeenCalled();
      expect(s.engine.pending.size).toBe(0);
      expect(s.engine.has(artist)).toBe(selected);
    },
  );
  it("serializes refreshes and writes so stale reads cannot overwrite edits", async () => {
    const s = setup();
    let release!: () => void;
    s.connection.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ fetchedAt: 1, artists: [], albums: [], tracks: [] });
        }),
    );
    const refresh = s.engine.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    const write = s.engine.toggle(artist);
    expect(s.connection.mutate).not.toHaveBeenCalled();
    release();
    await Promise.all([refresh, write]);
    expect(s.engine.has(artist)).toBe(true);
  });
  it.each(["disconnect", "account", "abort"])(
    "ignores obsolete completion after %s",
    async (reason) => {
      const s = setup();
      let release!: () => void;
      s.connection.read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                fetchedAt: 1,
                artists: [{ id: "late", title: "Late" }],
                albums: [],
                tracks: [],
              });
          }),
      );
      const request = s.engine.refresh();
      await vi.waitFor(() => expect(release).toBeDefined());
      if (reason === "disconnect") s.engine.setConnection(undefined);
      if (reason === "account") s.selection.cache = new Cache("other");
      if (reason === "abort") s.controller.abort();
      release();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(s.publish).not.toHaveBeenCalled();
    },
  );
  it("publishes an authoritative contradiction but does not claim mutation success", async () => {
    const s = setup();
    s.connection.mutate.mockResolvedValueOnce(undefined);
    await expect(s.engine.toggle(artist)).rejects.toThrow("not confirmed");
    expect(s.publish).toHaveBeenCalledOnce();
    expect(s.engine.has(artist)).toBe(false);
    expect(s.engine.outcomeUnknown).toBe(false);
  });
  it("retains the unknown-outcome guard on same-account connection replacement", async () => {
    const s = setup();
    s.connection.read.mockRejectedValueOnce(new Error("Read unavailable"));
    await expect(s.engine.toggle(artist)).rejects.toThrow("Read unavailable");
    s.engine.setConnection(undefined);
    s.engine.setConnection(s.connection);
    await expect(s.engine.toggle(artist)).rejects.toThrow("Outcome unknown");
    expect(s.connection.mutate).toHaveBeenCalledOnce();
    await s.engine.refresh();
    expect(s.engine.outcomeUnknown).toBe(false);
  });
  it("cancels queued work as well as in-flight reads when the connection retires", async () => {
    const s = setup();
    let release!: () => void;
    s.connection.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ fetchedAt: 1, artists: [], albums: [], tracks: [] });
        }),
    );
    const read = s.engine.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    const edit = s.engine.toggle(artist);
    s.engine.setConnection(undefined);
    release();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    await expect(edit).rejects.toMatchObject({ name: "AbortError" });
    expect(s.connection.mutate).not.toHaveBeenCalled();
    expect(s.publish).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated edits while retaining cached membership", async () => {
    const s = setup();
    await s.engine.toggle(artist);
    s.engine.setConnection(undefined);
    await expect(s.engine.toggle(artist)).rejects.toThrow("Reconnect");
    expect(s.engine.has(artist)).toBe(true);
  });
});

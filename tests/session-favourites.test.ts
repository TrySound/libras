// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createSession, createStorage, credentials, deferred } from "./session-test-helpers";
import { getAccountKey } from "../src/auth";
import { installDisk } from "./cache-test-helpers";
import { Cache } from "../src/cache.svelte";
import type { FavouriteState } from "../src/schema";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("refreshes at downloaded-only startup, permits authenticated edits, and retires access on disconnect", async () => {
  const storage = createStorage();
  storage.setItem("navidrome-offline-mode", "true");
  let selected = false;
  const methods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const method = new URL(url).pathname.split("/").pop()!;
      methods.push(method);
      if (method === "star.view") selected = true;
      return new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "ok",
            starred2: { artist: selected ? [{ id: "artist", name: "Favourite" }] : [] },
          },
        }),
      );
    }),
  );
  let state: FavouriteState = { fetchedAt: null, artists: [], albums: [], tracks: [] };
  vi.spyOn(Cache.prototype, "favourites", "get").mockImplementation(() => state);
  vi.spyOn(Cache.prototype, "setFavourites").mockImplementation((value) => {
    state = value as FavouriteState;
  });
  const s = createSession(true, storage, true);
  try {
    s.session.start();
    await vi.waitFor(() => expect(state.fetchedAt).not.toBeNull());
    expect(s.session.offlineMode).toBe(true);
    expect(s.metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(s.playback.refreshQueue).not.toHaveBeenCalled();
    vi.spyOn(s.selection.cache!, "artists", "get").mockReturnValue(
      new Map([["artist", { id: "artist", name: "Artist", localOnly: false }]]),
    );
    await s.favourites!.toggle({ kind: "artists", id: "artist" });
    expect(s.favourites!.has({ kind: "artists", id: "artist" })).toBe(true);
    expect(s.session.offlineMode).toBe(true);
    await s.session.refresh();
    expect(methods.filter((method) => method === "getStarred2.view").length).toBe(3);
    s.session.disconnect();
    expect(s.favourites!.available).toBe(false);
    expect(state.artists).toHaveLength(1);
    await expect(s.favourites!.toggle({ kind: "artists", id: "artist" })).rejects.toThrow(
      "Reconnect",
    );
  } finally {
    await s.destroy();
  }
});

it("retires an account with preserved corrupt favourites after a confirmed server refresh", async () => {
  const disk = installDisk();
  const seed = new Cache(getAccountKey(credentials));
  await seed.load();
  seed.setFavourites({ fetchedAt: 1, artists: [], albums: [], tracks: [] });
  await seed.flush();
  const path = [...disk.files.keys()].find((path) => path.endsWith("/favourites.json"))!;
  disk.files.set(path, "corrupt original bytes");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              starred2: { song: [{ id: "confirmed", title: "Confirmed" }] },
            },
          }),
        ),
    ),
  );
  const s = createSession(true, createStorage(), true);
  s.loadCache.mockRestore(); // Exercise actual OPFS restoration and account retirement.
  try {
    s.session.start();
    await vi.waitFor(() => expect(s.selection.cache?.favourites.tracks[0]?.id).toBe("confirmed"));
    const previous = s.selection.cache!;
    expect(previous.dirty).toBe(true);
    expect(previous.favouritesError).toBeDefined();
    await expect(previous.flush()).rejects.toThrow();
    s.session.disconnect();
    expect(
      await s.session.connect({
        host: credentials.host,
        username: "other-account",
        password: "fixture",
      }),
    ).toBe(true);
    expect(s.selection.cache).not.toBe(previous);
    expect(s.selection.cache?.key).toBe(
      getAccountKey({ host: credentials.host, username: "other-account" }),
    );
    expect(disk.files.get(path)).toBe("corrupt original bytes");
    expect(previous.dirty).toBe(true);
    expect(previous.pendingWrites).toBe(false);
    expect(previous.favouritesError).toBeDefined();
  } finally {
    await s.destroy();
  }
});

it("does not let an unresolved favourites read gate library, queue or refresh completion", async () => {
  const gate = deferred();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate.promise;
      return new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "ok",
            starred2: { song: [{ id: "late", title: "Late" }] },
          },
        }),
      );
    }),
  );
  const s = createSession(true, createStorage(), true);
  try {
    s.session.start();
    await vi.waitFor(() => expect(s.playback.refreshQueue).toHaveBeenCalledOnce());
    expect(s.favourites!.loading).toBe(true);
    expect(s.session.syncing).toBe(false);
    await s.session.refresh();
    expect(s.metadata.readLibrary).toHaveBeenCalledOnce();
    expect(s.playback.refreshQueue).toHaveBeenCalledTimes(2);
    expect(s.session.refreshing).toBe(false);
    expect(s.favourites!.loading).toBe(true);
    s.session.disconnect();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.selection.cache?.favourites.tracks).toEqual([]);
  } finally {
    gate.resolve();
    await s.destroy();
  }
});

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

it.each([false, true])(
  "retains manual refresh ownership across downloaded-only toggle from %s",
  async (offline) => {
    const storage = createStorage();
    storage.setItem("navidrome-offline-mode", String(offline));
    let gate: ReturnType<typeof deferred<void>> | undefined;
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("getStarred2")) {
          reads++;
          await gate?.promise;
        }
        return new Response(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              starred2: {},
              indexes: { lastModified: 100 },
              searchResult3: {},
            },
          }),
        );
      }),
    );
    const s = createSession(true, storage, true);
    try {
      s.session.start();
      await vi.waitFor(() =>
        expect(s.selection.cache?.favourites.fetchedAt).toEqual(expect.any(Number)),
      );
      await vi.waitFor(() => expect(s.session.syncing).toBe(false));
      const before = reads;
      gate = deferred();
      const refresh = s.session.refresh();
      await vi.waitFor(() => expect(s.favourites!.loading).toBe(true));
      await s.session.setOfflineMode(!offline);
      expect(s.session.offlineMode).toBe(!offline);
      expect(s.session.syncing).toBe(true);
      expect(s.session.refreshing).toBe(true);
      const duplicate = s.session.refresh();
      expect(reads).toBe(before + 1);
      gate.resolve();
      await Promise.all([refresh, duplicate]);
      expect(s.session.syncing).toBe(false);
      expect(s.session.refreshing).toBe(false);
      gate = undefined;
      await s.session.refresh();
      expect(reads).toBe(before + 2);
      expect(s.session.syncing).toBe(false);
    } finally {
      gate?.resolve();
      await s.destroy();
    }
  },
);

it("preserves a submitted uncertain write through disconnect and failed same-account reconnect with real Cache", async () => {
  installDisk();
  const library = {
    savedAt: 100,
    lastModified: 100,
    artists: [{ id: "artist", name: "Artist", localOnly: false }],
    albums: [{ id: "album", title: "Album", artistIds: ["artist"], genres: [] }],
    tracks: [{ id: "song", title: "Song", albumId: "album", artistIds: ["artist"], genres: [] }],
  };
  const seed = new Cache(getAccountKey(credentials));
  await seed.load();
  await seed.replaceLibrary(library);
  seed.setFavourites({ fetchedAt: 1, artists: [], albums: [], tracks: [] });
  await seed.flush();
  const submitted = deferred();
  const response = deferred();
  let remoteStarred = false;
  let failReads = false;
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("star.view")) {
        writes++;
        remoteStarred = true;
        submitted.resolve();
        // Model a server-accepted write whose response outlives client cancellation.
        await response.promise;
      }
      if (url.includes("getStarred2") && failReads) throw new Error("Mock transport unavailable");
      return new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "ok",
            indexes: { lastModified: 100 },
            starred2: { song: remoteStarred ? [{ id: "song", title: "Song" }] : [] },
          },
        }),
      );
    }),
  );
  const storage = createStorage();
  storage.setItem("navidrome-offline-mode", "true");
  const s = createSession(true, storage, true);
  s.loadCache.mockRestore();
  s.saveLibrary.mockRestore();
  s.metadata.readLibrary.mockResolvedValue(library);
  try {
    s.session.start();
    await vi.waitFor(() => expect(s.session.localReady).toBe(true));
    await vi.waitFor(() => expect(s.session.syncing).toBe(false));
    const cache = s.selection.cache!;
    expect(cache.tracks.has("song")).toBe(true);
    const edit = s.favourites!.toggle({ kind: "tracks", id: "song" });
    const retiredEdit = edit.catch((error) => error);
    await submitted.promise;
    s.session.disconnect();
    expect(s.favourites!.outcomeUnknown).toBe(true);
    failReads = true;
    expect(
      await s.session.connect({
        host: credentials.host,
        username: credentials.username,
        password: "fixture",
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(s.session.syncing).toBe(false));
    expect(s.selection.cache).toBe(cache);
    expect(s.favourites!.error).toBeDefined();
    expect(s.favourites!.has({ kind: "tracks", id: "song" })).toBe(false);
    await expect(s.favourites!.toggle({ kind: "tracks", id: "song" })).rejects.toThrow(
      "Outcome unknown",
    );
    response.resolve();
    expect(await retiredEdit).toMatchObject({ name: "AbortError" });
    expect(s.favourites!.outcomeUnknown).toBe(true);
    expect(writes).toBe(1);
    failReads = false;
    await s.session.refresh();
    expect(s.favourites!.has({ kind: "tracks", id: "song" })).toBe(true);
    expect(s.favourites!.outcomeUnknown).toBe(false);
    expect(writes).toBe(1);
    await cache.flush();
    const restored = new Cache(getAccountKey(credentials));
    await restored.load();
    expect(restored.favourites.tracks[0]?.id).toBe("song");
  } finally {
    response.resolve();
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

it("does not gate library/queue but retains refresh busy feedback until favourites settle", async () => {
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
    expect(s.session.syncing).toBe(true);
    const duplicate = s.session.refresh();
    expect(s.metadata.readLibrary).not.toHaveBeenCalled();
    expect(s.playback.refreshQueue).toHaveBeenCalledOnce();
    expect(s.session.syncing).toBe(true);
    expect(s.favourites!.loading).toBe(true);
    s.session.disconnect();
    gate.resolve();
    await duplicate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.selection.cache?.favourites.tracks).toEqual([]);
  } finally {
    gate.resolve();
    await s.destroy();
  }
});

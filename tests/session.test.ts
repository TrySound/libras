import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetadataSnapshot } from "../src/metadata.svelte";
import { CacheLoadError, Cache } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { NetworkTransportError } from "../src/network.svelte";
import { createSession, credentials, deferred, snapshot } from "./session-test-helpers";

const fixtures: ReturnType<typeof createSession>[] = [];

function setup(...args: Parameters<typeof createSession>) {
  const fixture = createSession(...args);
  fixtures.push(fixture);
  return fixture;
}

async function connected() {
  const fixture = setup(true);
  fixture.session.start();
  await vi.waitFor(() => expect(fixture.session.status).toBe("connected"));
  return fixture;
}

afterEach(() => {
  for (const { session } of fixtures.splice(0)) session.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = { host: credentials.host, username: credentials.username, password: "password" };

describe("session", () => {
  it("reports failed metadata restoration without preventing offline queue restoration", async () => {
    const { session, metadata, queue, storage, loadCache } = setup(true);
    storage.setItem("navidrome-offline-mode", "true");
    loadCache.mockRejectedValueOnce(new Error("Corrupt library"));
    session.start();
    await vi.waitFor(() => expect(session.localReady).toBe(true));
    expect(session.error).toContain("Could not restore library: Corrupt library");
    expect(queue.activate).toHaveBeenCalledOnce();
    expect(metadata.refresh).not.toHaveBeenCalled();
  });

  it.each(["queue", "images", "downloads"] as const)(
    "keeps %s load failures separate from library refresh warnings",
    async (domain) => {
      const { session, selection, loadCache, queue } = setup(true);
      const failure = new Error(`Corrupt cached ${domain}`);
      const field = (
        { queue: "queueError", images: "imagesError", downloads: "downloadsError" } as const
      )[domain];
      loadCache.mockImplementationOnce(async function (this: Cache) {
        vi.spyOn(this, field, "get").mockReturnValue(failure);
        throw new CacheLoadError({ [domain]: failure });
      });
      session.start();
      await vi.waitFor(() => expect(session.status).toBe("connected"));
      expect(session.localReady).toBe(true);
      expect(session.error).toBe("");
      expect(session.refreshError).toContain(`Corrupt cached ${domain}`);
      expect(queue.activate).toHaveBeenCalledOnce();
      await session.refresh();
      expect(session.refreshError).toContain(`Corrupt cached ${domain}`);
      vi.spyOn(selection.cache!, field, "get").mockReturnValue(undefined);
      expect(session.refreshError).toBe("");
    },
  );

  it("can recover online after a failed metadata restoration", async () => {
    const { session, metadata, queue, loadCache } = setup(true);
    loadCache.mockRejectedValueOnce(new Error("Corrupt library"));
    const refreshed = deferred();
    metadata.refresh.mockReturnValueOnce(refreshed.promise);
    session.start();
    await vi.waitFor(() => expect(session.syncing).toBe(true));
    expect(session.error).toContain("Corrupt library");
    expect(queue.activate).toHaveBeenCalledOnce();
    refreshed.resolve();
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    expect(session.error).toBe("");
    expect(session.status).toBe("connected");
  });

  it("still refreshes the queue when metadata refresh fails", async () => {
    const { session, metadata, queue, covers } = await connected();
    queue.refresh.mockClear();
    covers.refresh.mockClear();
    metadata.refresh.mockRejectedValueOnce(new Error("Library unavailable"));
    await session.refresh();
    expect(queue.refresh).toHaveBeenCalledOnce();
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(session.refreshError).toContain("Library unavailable");
    expect(session.status).toBe("connected");
  });

  it("reports queue storage errors without failing the connection", async () => {
    const { session, queue } = await connected();
    queue.storageError = new Error("Storage unavailable");
    await session.refresh();
    expect(session.refreshError).toContain("Storage unavailable");
    expect(session.status).toBe("connected");
    expect(session.syncing).toBe(false);
  });

  it("does no refresh offline and orders metadata before covers and queue", async () => {
    const offline = setup();
    await offline.session.refresh();
    expect(offline.metadata.refresh).not.toHaveBeenCalled();
    const { session, metadata, covers, queue } = await connected();
    covers.refresh.mockClear();
    queue.refresh.mockClear();
    const pending = deferred();
    metadata.refresh.mockReturnValueOnce(pending.promise);
    const refresh = session.refresh();
    expect(session.syncing).toBe(true);
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(queue.refresh).not.toHaveBeenCalled();
    pending.resolve();
    await refresh;
    expect(covers.refresh).toHaveBeenCalledOnce();
    expect(queue.refresh).toHaveBeenCalledOnce();
    expect(covers.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      queue.refresh.mock.invocationCallOrder[0],
    );
  });

  it("coalesces overlapping refreshes and permits a later refresh", async () => {
    const { session, metadata } = await connected();
    metadata.refresh.mockClear();
    const pending = deferred();
    metadata.refresh.mockReturnValueOnce(pending.promise);
    const first = session.refresh();
    const second = session.refresh();
    expect(metadata.refresh).toHaveBeenCalledOnce();
    pending.resolve();
    await Promise.all([first, second]);
    await session.refresh();
    expect(metadata.refresh).toHaveBeenCalledTimes(2);
  });

  it("clears refresh errors after a successful manual retry", async () => {
    const { session, metadata } = await connected();
    metadata.refresh.mockRejectedValueOnce(new Error("Failed"));
    await session.refresh();
    expect(session.refreshError).toContain("Failed");
    await session.refresh();
    expect(session.refreshError).toBe("");
  });

  it("handles synchronous refresh failures without leaving a stuck request", async () => {
    const { session, metadata } = await connected();
    metadata.refresh.mockImplementationOnce(() => {
      throw new Error("Failed");
    });
    await session.refresh();
    expect(session.syncing).toBe(false);
    expect(session.refreshError).toContain("Failed");
    await session.refresh();
    expect(session.refreshError).toBe("");
  });

  it("does not refresh covers or queue after disconnecting during metadata refresh", async () => {
    const { session, metadata, covers, queue } = await connected();
    covers.refresh.mockClear();
    queue.refresh.mockClear();
    const pending = deferred();
    metadata.refresh.mockReturnValueOnce(pending.promise);
    const refresh = session.refresh();
    session.disconnect();
    pending.resolve();
    await refresh;
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(queue.refresh).not.toHaveBeenCalled();
    expect(session.syncing).toBe(false);
  });

  it("ignores an old refresh failure after a new connection starts refreshing", async () => {
    const { session, metadata, covers } = await connected();
    covers.refresh.mockClear();
    const old = deferred();
    metadata.refresh.mockReturnValueOnce(old.promise);
    const first = session.refresh();
    await session.setOfflineMode(true);
    await session.setOfflineMode(false);
    const current = deferred();
    metadata.refresh.mockReturnValueOnce(current.promise);
    const second = session.refresh();
    old.reject(new Error("Old connection failed"));
    await first;
    expect(session.refreshError).toBe("");
    expect(session.syncing).toBe(true);
    expect(covers.refresh).not.toHaveBeenCalled();
    current.resolve();
    await second;
    expect(session.syncing).toBe(false);
    expect(covers.refresh).toHaveBeenCalledOnce();
  });

  it("hydrates local data before a pending background refresh completes", async () => {
    const { session, metadata, selection, queue } = setup(true);
    const refresh = deferred();
    metadata.getModifiedAt.mockImplementationOnce(async () => {
      await refresh.promise;
      return 100;
    });
    session.start();
    await vi.waitFor(() => expect(session.syncing).toBe(true));
    expect(session.localReady).toBe(true);
    expect(session.busy).toBe(false);
    expect(selection.cache!.artists.size).toBe(1);
    expect(queue.activate).toHaveBeenCalledOnce();
    refresh.resolve();
    await vi.waitFor(() => expect(session.syncing).toBe(false));
  });

  it("finishes local hydration even when startup revalidation fails", async () => {
    const { session, metadata, selection } = setup(true);
    metadata.getModifiedAt.mockRejectedValueOnce(new Error("Server unavailable"));
    session.start();
    await vi.waitFor(() => expect(session.refreshError).toContain("Server unavailable"));
    expect(session.localReady).toBe(true);
    expect(session.syncing).toBe(false);
    expect(session.error).toBe("");
    expect(selection.cache!.artists.size).toBe(1);
  });

  it("keeps local data and connection state after a background refresh failure", async () => {
    const { session, metadata, selection } = await connected();
    const artists = selection.cache!.artists;
    metadata.readLibrary.mockRejectedValueOnce(new Error("Server unavailable"));
    await session.refresh();
    expect(session.localReady).toBe(true);
    expect(session.syncing).toBe(false);
    expect(session.status).toBe("connected");
    expect(session.error).toBe("");
    expect(session.refreshError).toContain("Server unavailable");
    expect(selection.cache!.artists).toBe(artists);
  });

  it("migrates saved credentials to a non-secret account and refreshes without reconnecting", async () => {
    const { session, storage, metadata, tracks, queue, prepareConnection, loadCache } =
      await connected();
    expect(JSON.parse(storage.getItem("navidrome-account")!)).toEqual({
      host: credentials.host,
      username: credentials.username,
    });
    const client = tracks.setConnection.mock.calls.at(-1)![0];
    const refresh = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await refresh.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const pending = session.refresh();
    const overlapping = session.refresh();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    expect(session.busy).toBe(false);
    expect(session.syncing).toBe(true);
    expect(session.localReady).toBe(true);
    refresh.resolve();
    await Promise.all([pending, overlapping]);
    expect(metadata.getModifiedAt).toHaveBeenCalledTimes(2);
    expect(loadCache).toHaveBeenCalledOnce();
    expect(tracks.setConnection.mock.calls.at(-1)![0]).toBe(client);
    expect(queue.refresh).toHaveBeenCalledTimes(2);
    expect(await session.connect(input)).toBe(false);
    expect(prepareConnection).not.toHaveBeenCalled();
  });

  it("disconnects immediately, aborts the client, and preserves every offline data field", async () => {
    const { session, auth, selection, metadata, tracks, covers, queue, playback, storage } =
      await connected();
    const client = tracks.setConnection.mock.calls.at(-1)![0];
    const fields = [
      "artists",
      "albums",
      "tracks",
      "artistAlbums",
      "albumTracks",
      "downloads",
      "images",
      "artistArtwork",
      "albumArtwork",
      "trackArtwork",
    ] as const;
    const data = fields.map((field) => selection.cache![field]);
    const queueState = [
      selection.cache!.queue.tracks,
      selection.cache!.queue.index,
      selection.cache!.queue.position,
    ];
    const refresh = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await refresh.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const pending = session.refresh();
    session.disconnect();
    expect(session.syncing).toBe(false);
    expect(session.localReady).toBe(true);
    expect(client.signal.aborted).toBe(true);
    expect(auth.load()).toBeNull();
    expect(session.auth).toBeNull();
    expect(session.offlineMode).toBe(true);
    expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    expect(session.status).toBe("disconnected");
    fields.forEach((field, index) => expect(selection.cache![field]).toBe(data[index]));
    expect([
      selection.cache!.queue.tracks,
      selection.cache!.queue.index,
      selection.cache!.queue.position,
    ]).toEqual(queueState);
    expect(queue.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(covers.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(tracks.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(playback.suspendNetwork).toHaveBeenCalled();
    refresh.resolve();
    await pending;
    expect(session.status).toBe("disconnected");
    expect(auth.load()).toBeNull();
  });

  it("restores the last account and queue after disconnect without making network requests", async () => {
    const first = await connected();
    first.session.disconnect();
    const { session, selection, metadata, queue, storage, prepareConnection } = setup(
      false,
      first.storage,
    );
    expect(session.start()).toBeNull();
    await vi.waitFor(() => expect(queue.activate).toHaveBeenCalledOnce());
    expect(selection.cache!.account).toEqual({
      host: credentials.host,
      username: credentials.username,
    });
    expect(selection.cache!.artists.get("artist")?.name).toBe(credentials.username);
    expect(selection.cache!.queue.position).toBe(17);
    expect(session.offlineMode).toBe(true);
    await session.setOfflineMode(false);
    expect(session.offlineMode).toBe(true);
    expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(queue.refresh).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "forces offline mode without usable saved credentials (invalid: %s)",
    (invalid) => {
      const { session, storage, auth } = setup();
      if (invalid) storage.setItem("navidrome-auth", "invalid");
      storage.setItem("navidrome-offline-mode", "false");
      expect(session.start()).toBeNull();
      expect(auth.load()).toBeNull();
      expect(session.offlineMode).toBe(true);
      expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    },
  );

  it("allows explicit connection while forced offline and only switches accounts after validation", async () => {
    const { session, selection, auth, metadata, queue, covers, tracks, prepareConnection } =
      await connected();
    session.disconnect();
    const previous = selection.cache!.artists;
    const prepared = deferred<MetadataSnapshot>();
    prepareConnection.mockReturnValueOnce(prepared.promise);
    const next = { host: "https://other.example", username: "other" };
    tracks.activate.mockImplementation(() => {
      expect(selection.cache?.account).toEqual(next);
    });
    const connecting = session.connect({ ...next, password: "secret" });
    await vi.waitFor(() => expect(prepareConnection).toHaveBeenCalledOnce());
    expect(session.offlineMode).toBe(true);
    expect(session.auth).toBeNull();
    expect(selection.cache!.artists).toBe(previous);
    expect(await session.connect(input)).toBe(false);
    prepared.resolve(snapshot(next));
    expect(await connecting).toBe(true);
    expect(selection.cache!.account).toEqual(next);
    expect(selection.cache!.artists.get("artist")?.name).toBe("other");
    expect(selection.cache!.queue.tracks).toEqual(["other"]);
    expect(covers.activate).toHaveBeenCalledTimes(2);
    expect(tracks.activate).toHaveBeenCalledTimes(2);
    expect(queue.activate).toHaveBeenCalledTimes(2);
    expect(session.auth).toMatchObject(next);
    expect(auth.load()).toEqual(session.auth);
    expect(auth.loadAccount()).toEqual(next);
    expect(session.offlineMode).toBe(false);
    expect(session.status).toBe("connected");
  });

  it.each(["same", "different"])(
    "keeps the offline workspace after failed reconnect to a %s account",
    async (account) => {
      const { session, selection, auth, metadata, prepareConnection } = await connected();
      session.disconnect();
      const previous = selection.cache!.artists;
      const previousAccount = selection.cache!.account;
      prepareConnection.mockRejectedValueOnce(
        new NetworkTransportError(new TypeError("Network failed")),
      );
      expect(
        await session.connect({
          ...input,
          username: account === "same" ? credentials.username : "other",
        }),
      ).toBe(false);
      expect(selection.cache!.artists).toBe(previous);
      expect(selection.cache!.account).toBe(previousAccount);
      expect(session.auth).toBeNull();
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual(previousAccount);
      expect(session.offlineMode).toBe(true);
      expect(session.error).toContain("CORS");
    },
  );

  it.each(["disconnect", "destroy"] as const)(
    "ignores a candidate that resolves after %s",
    async (action) => {
      const { session, auth, selection, tracks, prepareConnection, saveLibrary } = setup();
      session.start();
      const prepared = deferred<MetadataSnapshot>();
      prepareConnection.mockReturnValueOnce(prepared.promise);
      const connecting = session.connect(input);
      await vi.waitFor(() => expect(prepareConnection).toHaveBeenCalledOnce());
      const client = prepareConnection.mock.calls[0][0];
      session[action]();
      prepared.resolve(snapshot(credentials));
      expect(await connecting).toBe(false);
      expect(client.signal.aborted).toBe(true);
      expect(auth.load()).toBeNull();
      expect(selection.cache).toBeUndefined();
      expect(saveLibrary).not.toHaveBeenCalled();
      expect(tracks.setConnection.mock.calls.every(([client]) => client === undefined)).toBe(true);
    },
  );

  it.each(["credentials", "metadata"])(
    "preserves the workspace and removes partial credentials when saving %s fails",
    async (stage) => {
      const { session, auth, selection, storage, saveLibrary } = await connected();
      session.disconnect();
      const previous = selection.cache!.artists;
      const account = selection.cache!.account;
      if (stage === "credentials")
        vi.spyOn(auth, "save").mockImplementationOnce(() => {
          throw new TypeError("Storage full");
        });
      else saveLibrary.mockRejectedValueOnce(new TypeError("Storage full"));
      expect(await session.connect({ ...input, username: "other" })).toBe(false);
      expect(session.error).toBe("Storage full");
      expect(selection.cache!.artists).toBe(previous);
      expect(selection.cache?.account).toEqual(account);
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual(account);
      expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    },
  );

  it("does not report invalid connection input as a transport or CORS failure", async () => {
    const { session, metadata, prepareConnection } = setup();
    expect(await session.connect({ ...input, host: "https://" })).toBe(false);
    expect(session.error).toMatch(/URL/i);
    expect(session.error).not.toContain("CORS");
    expect(prepareConnection).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "destroy"] as const)(
    "does not select a candidate when %s interrupts cache persistence",
    async (action) => {
      const { session, auth, selection, saveLibrary } = await connected();
      session.disconnect();
      const previous = selection.cache;
      const saved = deferred();
      saveLibrary.mockReturnValueOnce(saved.promise);
      const connecting = session.connect(input);
      await vi.waitFor(() => expect(saveLibrary).toHaveBeenCalledOnce());
      const signal = saveLibrary.mock.calls[0][1]!;
      expect(saveLibrary.mock.contexts[0]).not.toBe(previous);
      expect(selection.cache).toBe(previous);
      expect(auth.load()).not.toBeNull();
      session[action]();
      expect(signal.aborted).toBe(true);
      saved.resolve();
      expect(await connecting).toBe(false);
      if (action === "disconnect") expect(auth.load()).toBeNull();
      expect(selection.cache).toBe(previous);
    },
  );

  it("does not reconnect when disconnect occurs during startup restoration", async () => {
    const { session, auth, metadata, queue, selection, loadCache } = setup(true);
    const restored = deferred();
    const load = loadCache.getMockImplementation()!;
    loadCache.mockImplementationOnce(async function (this: Cache, signal) {
      await restored.promise;
      await load.call(this, signal);
    });
    session.start();
    const cache = selection.cache;
    const signal = loadCache.mock.calls[0][0]!;
    session.disconnect();
    expect(signal.aborted).toBe(false);
    restored.resolve();
    await vi.waitFor(() => expect(queue.activate).toHaveBeenCalledOnce());
    expect(selection.cache!.queue.position).toBe(17);
    expect(selection.cache).toBe(cache);
    expect(auth.load()).toBeNull();
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(queue.refresh).not.toHaveBeenCalled();
  });

  it("selects and loads a cache before attaching network access", async () => {
    const { session, selection, metadata, loadCache, queue, covers, tracks } = setup(true);
    const loaded = deferred();
    loadCache.mockReturnValueOnce(loaded.promise);
    session.start();
    expect(selection.cache?.account).toEqual({
      host: credentials.host,
      username: credentials.username,
    });
    expect(loadCache.mock.contexts[0]).toBe(selection.cache);
    expect(covers.activate).toHaveBeenCalledOnce();
    expect(tracks.activate).toHaveBeenCalledOnce();
    expect(tracks.activate.mock.invocationCallOrder[0]).toBeLessThan(
      loadCache.mock.invocationCallOrder[0],
    );
    expect(covers.activate.mock.invocationCallOrder[0]).toBeLessThan(
      loadCache.mock.invocationCallOrder[0],
    );
    expect(covers.setConnection.mock.calls.every(([connection]) => connection === undefined)).toBe(
      true,
    );
    expect(session.localReady).toBe(false);
    expect(
      metadata.setConnection.mock.calls.every(([connection]) => connection === undefined),
    ).toBe(true);
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(queue.activate).not.toHaveBeenCalled();
    loaded.resolve();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(session.localReady).toBe(true);
    expect(metadata.setConnection.mock.calls.at(-1)![0]).toBeDefined();
  });

  it("aborts cache loading on destruction without late readiness or errors", async () => {
    const { session, selection, loadCache, metadata, covers, queue } = setup(true);
    const loaded = deferred();
    loadCache.mockReturnValueOnce(loaded.promise);
    session.start();
    const cache = selection.cache;
    const signal = loadCache.mock.calls[0][0]!;
    session.destroy();
    expect(signal.aborted).toBe(true);
    loaded.reject(new DOMException("Stopped", "AbortError"));
    // Drain the rejected load, independent domain restoration and startup callback.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.error).toBe("");
    expect(session.localReady).toBe(false);
    expect(selection.cache).toBe(cache);
    expect(queue.activate).not.toHaveBeenCalled();
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
  });

  it.each(["listener", "other"])(
    "selects the prepared %s cache only after persistence and network acceptance",
    async (username) => {
      const { session, selection, saveLibrary, network, playback } = await connected();
      session.disconnect();
      const previous = selection.cache;
      const save = saveLibrary.getMockImplementation()!;
      const committed = deferred();
      saveLibrary.mockImplementationOnce(async function (this: Cache, value, signal) {
        expect(this).not.toBe(previous);
        expect(selection.cache).toBe(previous);
        await committed.promise;
        await save.call(this, value, signal);
        expect(selection.cache).toBe(previous);
      });
      const accept = vi.mocked(network.accept).getMockImplementation()!;
      vi.spyOn(network, "accept").mockImplementation((connection) => {
        expect(selection.cache).toBe(previous);
        return accept(connection);
      });
      const connecting = session.connect({ ...input, username });
      await vi.waitFor(() => expect(saveLibrary).toHaveBeenCalledOnce());
      expect(selection.cache).toBe(previous);
      committed.resolve();
      expect(await connecting).toBe(true);
      expect(playback.suspend).toHaveBeenCalledOnce();
      expect(selection.cache).toBe(saveLibrary.mock.contexts[0]);
      expect(selection.cache).not.toBe(previous);
      expect(selection.cache?.account?.username).toBe(username);
      expect(selection.cache!.artists.get("artist")?.name).toBe(username);
    },
  );

  it("preserves same-account queue edits made while the candidate cache loads", async () => {
    const { session, selection, loadCache, saveLibrary } = setup(true);
    loadCache.mockRestore();
    saveLibrary.mockRestore();
    installDisk();
    const seed = new Cache({ host: credentials.host, username: credentials.username });
    seed.setQueue({ tracks: ["old"], index: 0, position: 10 });
    await seed.flush();
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    session.disconnect();
    const previous = selection.cache!;
    const loaded = deferred();
    const release = deferred();
    const load = Cache.prototype.load;
    vi.spyOn(Cache.prototype, "load").mockImplementationOnce(async function (this: Cache, signal) {
      await load.call(this, signal);
      loaded.resolve();
      await release.promise;
    });
    const connecting = session.connect(input);
    await loaded.promise;
    previous.setQueue({ tracks: ["edited", "edited"], index: 1, position: 20 });
    release.resolve();
    expect(await connecting).toBe(true);
    expect(selection.cache).not.toBe(previous);
    expect(selection.cache!.queue).toEqual({
      tracks: ["edited", "edited"],
      index: 1,
      position: 20,
    });
    await selection.cache!.flush();
    await previous.flush().catch(() => {});
  });

  it("keeps the selected cache if network acceptance fails after persistence", async () => {
    const { session, selection, auth, network, saveLibrary } = await connected();
    session.disconnect();
    const previous = selection.cache;
    vi.spyOn(network, "accept").mockImplementationOnce(() => {
      throw new Error("Acceptance failed");
    });
    expect(await session.connect({ ...input, username: "other" })).toBe(false);
    expect(saveLibrary).toHaveBeenCalledOnce();
    expect(selection.cache).toBe(previous);
    expect(selection.cache!.account).toEqual(previous?.account);
    expect(auth.load()).toBeNull();
    expect(session.error).toBe("Acceptance failed");
  });

  it("keeps credentials for voluntary offline mode and resumes with a fresh cancellable client", async () => {
    const { session, tracks, metadata, auth, queue, loadCache } = await connected();
    const client = tracks.setConnection.mock.calls.at(-1)![0];
    await session.setOfflineMode(true);
    expect(client.signal.aborted).toBe(true);
    expect(auth.load()).not.toBeNull();
    expect(session.auth).not.toBeNull();
    await session.setOfflineMode(false);
    expect(tracks.setConnection.mock.calls.at(-1)![0]).not.toBe(client);
    expect(loadCache).toHaveBeenCalledOnce();
    expect(metadata.getModifiedAt).toHaveBeenCalledOnce();
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    expect(queue.refresh).toHaveBeenCalledOnce();
    expect(session.status).toBe("connected");
    await session.refresh();
    expect(metadata.readLibrary).toHaveBeenCalledOnce();
    expect(queue.refresh).toHaveBeenCalledTimes(2);
  });
});

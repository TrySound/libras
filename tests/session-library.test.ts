// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import type { Library, LibraryProgress } from "../src/network.svelte";
import { createSession, credentials, deferred } from "./session-test-helpers";
import { installMetadataStorage, snapshot, snapshotPath } from "./library-test-helpers";

const input = { host: credentials.host, username: credentials.username, password: "password" };
const fixtures: ReturnType<typeof createSession>[] = [];

function setup(saved = true) {
  const fixture = createSession(saved);
  fixtures.push(fixture);
  fixture.loadCache.mockRestore();
  fixture.saveLibrary.mockRestore();
  const disk = installMetadataStorage();
  fixture.metadata.getModifiedAt.mockResolvedValue(10);
  fixture.metadata.readLibrary.mockResolvedValue(snapshot());
  return { ...fixture, disk };
}

async function restored(data: unknown = snapshot()) {
  const fixture = setup();
  await fixture.disk.seed(credentials, data);
  fixture.session.start();
  await vi.waitFor(() => {
    expect(fixture.session.status).toBe("connected");
    expect(fixture.session.syncing).toBe(false);
  });
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session library workflow", () => {
  it("loads the candidate cache before validation, then connects before the library refresh finishes", async () => {
    const { session, selection, metadata, validate, auth, playback, disk } = setup(false);
    await disk.seed(credentials, snapshot());
    const validated = deferred();
    const response = deferred<Library>();
    let prepared: Cache | undefined;
    const load = Cache.prototype.load;
    vi.spyOn(Cache.prototype, "load").mockImplementationOnce(async function (this: Cache, signal) {
      await load.call(this, signal);
      prepared = this;
    });
    validate.mockImplementationOnce(async () => {
      expect(prepared?.tracks.get("song")).toEqual(snapshot().tracks[0]);
      expect(selection.cache).toBeUndefined();
      expect(metadata.getModifiedAt).not.toHaveBeenCalled();
      expect(auth.load()).toBeNull();
      await validated.promise;
    });
    metadata.getModifiedAt.mockResolvedValue(20);
    metadata.readLibrary.mockReturnValueOnce(response.promise);
    const connecting = session.connect(input);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    expect(session.status).toBe("connecting");
    expect(session.libraryProgress).toBeUndefined();
    validated.resolve();
    expect(await connecting).toBe(true);
    expect(session.status).toBe("connected");
    expect(session.localReady).toBe(true);
    expect(session.busy).toBe(false);
    expect(session.syncing).toBe(true);
    expect(auth.load()).not.toBeNull();
    expect(selection.cache).toBe(prepared);
    expect(selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    const refreshing = session.refresh();
    response.reject(new Error("Library unavailable"));
    await refreshing;
    expect(session.status).toBe("connected");
    expect(session.error).toBe("");
    expect(session.refreshError).toContain("Library unavailable");
    expect(auth.load()).not.toBeNull();
    expect(selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(playback.refreshQueue).toHaveBeenCalledOnce();
    expect(disk.writes).toBe(0);
  });

  it("accepts a first login with no cached library even when its initial refresh fails", async () => {
    const { session, selection, metadata, auth } = setup(false);
    metadata.getModifiedAt.mockRejectedValue(new Error("Library unavailable"));
    expect(await session.connect(input)).toBe(true);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    expect(session.status).toBe("connected");
    expect(auth.load()).not.toBeNull();
    expect(session.localReady).toBe(true);
    expect(selection.cache!.tracks.size).toBe(0);
    expect(session.refreshError).toContain("Library unavailable");
  });

  it("revalidates rather than refetching an unchanged library after explicit login", async () => {
    const { session, selection, metadata, validate, disk } = setup(false);
    await disk.seed(credentials, snapshot());
    expect(await session.connect(input)).toBe(true);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    expect(validate).toHaveBeenCalledOnce();
    expect(metadata.getModifiedAt).toHaveBeenCalledWith(10);
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    expect(selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(disk.writes).toBe(0);
  });

  it("restores an offline account without validating credentials or requesting a library", async () => {
    const { session, selection, metadata, validate, auth, disk } = setup(false);
    await disk.seed(credentials, snapshot());
    auth.saveAccount(credentials);
    session.start();
    await vi.waitFor(() => expect(session.localReady).toBe(true));
    expect(session.offlineMode).toBe(true);
    expect(selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(validate).not.toHaveBeenCalled();
    expect(metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(metadata.readLibrary).not.toHaveBeenCalled();
  });

  it("revalidates restored metadata without rereading storage, but forces manual refresh", async () => {
    const { session, metadata, selection, disk } = await restored();
    expect(metadata.getModifiedAt).toHaveBeenCalledWith(10);
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    expect(disk.writes).toBe(0);
    const previous = selection.cache!.tracks;
    const response = deferred<Library>();
    metadata.readLibrary.mockReturnValueOnce(response.promise);
    disk.getDirectory.mockClear();
    const refreshing = session.refresh();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    expect(selection.cache!.tracks).toBe(previous);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    response.resolve({ ...snapshot(), tracks: [{ ...snapshot().tracks[0], id: "new" }] });
    await refreshing;
    expect(selection.cache!.tracks.has("song")).toBe(false);
    expect(selection.cache!.albumTracks.get("album")?.map((track) => track.id)).toEqual(["new"]);
    expect(previous.get("song")).toEqual(snapshot().tracks[0]);
    await selection.cache!.flush();
    expect(disk.writes).toBe(1);
  });

  it.each([null, 20])("refreshes at startup when the timestamp is %s", async (modified) => {
    const { session, metadata, disk, selection } = setup();
    const data = { ...snapshot(), lastModified: modified === null ? null : 10 };
    await disk.seed(credentials, data);
    metadata.getModifiedAt.mockResolvedValue(modified);
    session.start();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    expect(selection.cache!.lastModified).toBe(modified);
    await selection.cache!.flush();
    expect(disk.writes).toBe(1);
  });

  it("retains the known timestamp when the server omits an unchanged index", async () => {
    const { session, metadata, disk } = setup();
    await disk.seed(credentials, snapshot());
    metadata.getModifiedAt.mockResolvedValue(null);
    session.start();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    expect(disk.writes).toBe(0);
  });

  it("repairs an invalid library on startup without a separate metadata owner", async () => {
    const { selection, disk, session } = await restored({ invalid: true });
    expect(selection.cache!.tracks.get("song")?.title).toBe("Song");
    await selection.cache!.flush();
    expect(session.refreshError).toBe("");
    expect(JSON.parse(await disk.files.get(await snapshotPath(credentials))!.text())).toMatchObject(
      {
        lastModified: 10,
        tracks: [{ id: "song" }],
      },
    );
  });

  it("reports fetch failures while keeping restored entities and indexes", async () => {
    const { session, selection, metadata, disk } = await restored();
    const cache = selection.cache!;
    const tracks = cache.tracks;
    const albums = cache.albumTracks;
    metadata.readLibrary.mockRejectedValueOnce(new Error("Server unavailable"));
    await session.refresh();
    expect(session.refreshError).toContain("Server unavailable");
    expect(cache.tracks).toBe(tracks);
    expect(cache.albumTracks).toBe(albums);
    expect(session.libraryProgress).toBeUndefined();
    expect(disk.writes).toBe(0);
  });

  it("keeps adopted data after a checkpoint failure and preserves the previous disk snapshot", async () => {
    const { session, selection, metadata, disk } = await restored();
    metadata.readLibrary.mockResolvedValue({ ...snapshot(), tracks: [] });
    disk.failWrites = true;
    await session.refresh();
    expect(selection.cache!.tracks.size).toBe(0);
    await expect(selection.cache!.flush()).rejects.toBeInstanceOf(AggregateError);
    expect(session.refreshError).toContain("Storage full");
    const restoredCache = new Cache(getAccountKey(credentials));
    await restoredCache.load();
    expect(restoredCache.tracks.get("song")).toEqual(snapshot().tracks[0]);
  });

  it("session destruction does not cancel a checkpoint of already adopted data", async () => {
    const { session, selection, metadata, disk } = await restored();
    metadata.getModifiedAt.mockResolvedValue(20);
    await session.refresh();
    disk.beforeWrite = () => session.destroy();
    await selection.cache!.flush();
    expect(
      JSON.parse(await disk.files.get(await snapshotPath(credentials))!.text()).lastModified,
    ).toBe(20);
    expect(disk.writes).toBe(1);
  });

  it("persists library-only data that can be restored offline in a new session", async () => {
    const { session, selection, disk } = setup(false);
    expect(await session.connect(input)).toBe(true);
    await session.refresh();
    await selection.cache!.flush();
    const text = await disk.files.get(await snapshotPath(credentials))!.text();
    expect(text).not.toContain('"account"');
    expect(text).not.toContain('"token"');
    expect(text).not.toContain('"salt"');
    expect(JSON.parse(text)).toEqual({ ...snapshot(), savedAt: selection.cache!.savedAt });
    session.disconnect();
    const next = createSession(false, fixtures.at(-1)!.storage);
    fixtures.push(next);
    next.loadCache.mockRestore();
    next.saveLibrary.mockRestore();
    next.session.start();
    await vi.waitFor(() => expect(next.session.localReady).toBe(true));
    expect(next.selection.cache!.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(next.metadata.getModifiedAt).not.toHaveBeenCalled();
    expect(next.validate).not.toHaveBeenCalled();
  });

  for (const mode of ["connect", "refresh"] as const) {
    it.each(["disconnect", "destroy"] as const)(
      `clears ${mode} progress and rejects late publication after %s`,
      async (action) => {
        const fixture = mode === "refresh" ? await restored() : setup(false);
        const { session, selection, disk } = fixture;
        const reader = fixture.metadata;
        const pending = deferred<Library>();
        let report: ((progress: LibraryProgress) => void) | undefined;
        reader.readLibrary.mockImplementationOnce(async (_signal, onProgress) => {
          report = onProgress;
          return pending.promise;
        });
        const run = mode === "refresh" ? session.refresh() : session.connect(input);
        await vi.waitFor(() => expect(report).toBeDefined());
        const previous = selection.cache?.tracks;
        const completed = session.refresh();
        expect(session.libraryProgress).toEqual({ albums: 0, tracks: 0 });
        report!({ albums: 500, tracks: 1000 });
        expect(session.libraryProgress).toEqual({ albums: 500, tracks: 1000 });
        const signal = reader.readLibrary.mock.calls.at(-1)![0];
        session[action]();
        expect(signal.aborted).toBe(true);
        expect(session.libraryProgress).toBeUndefined();
        report!({ albums: 999, tracks: 999 });
        expect(session.libraryProgress).toBeUndefined();
        pending.resolve(snapshot());
        await run;
        await completed;
        expect(selection.cache?.tracks).toBe(previous);
        expect(disk.writes).toBe(0);
      },
    );
  }

  it("does not fetch a library after disconnect during credential validation", async () => {
    const { session, validate, metadata, disk, selection } = setup(false);
    const validation = deferred();
    validate.mockReturnValueOnce(validation.promise);
    const connecting = session.connect(input);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    session.disconnect();
    validation.resolve();
    expect(await connecting).toBe(false);
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    expect(selection.cache).toBeUndefined();
    expect(disk.writes).toBe(0);
  });

  it("old refresh callbacks cannot clear or overwrite a new connection's progress", async () => {
    const { session, metadata } = await restored();
    const old = deferred<Library>();
    const current = deferred<Library>();
    const reports: ((progress: LibraryProgress) => void)[] = [];
    metadata.readLibrary
      .mockImplementationOnce(async (_signal, progress) => {
        reports.push(progress!);
        return old.promise;
      })
      .mockImplementationOnce(async (_signal, progress) => {
        reports.push(progress!);
        return current.promise;
      });
    const first = session.refresh();
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    await session.setOfflineMode(true);
    await session.setOfflineMode(false);
    const second = session.refresh();
    await vi.waitFor(() => expect(reports).toHaveLength(2));
    reports[1]({ albums: 2, tracks: 4 });
    reports[0]({ albums: 99, tracks: 99 });
    old.resolve(snapshot());
    await first;
    expect(session.libraryProgress).toEqual({ albums: 2, tracks: 4 });
    current.resolve(snapshot());
    await second;
    expect(session.libraryProgress).toBeUndefined();
  });

  it("does not publish an obsolete refresh after accepting a different account", async () => {
    const { session, selection, metadata, disk } = await restored();
    const old = deferred<Library>();
    metadata.readLibrary.mockReturnValueOnce(old.promise);
    const refreshing = session.refresh();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    session.disconnect();
    const other = { ...input, username: "other" };
    const next: LibrarySnapshot = {
      ...snapshot(),
      artists: [{ id: "artist", name: "Other", genres: [] }],
    };
    metadata.readLibrary.mockResolvedValueOnce(next);
    expect(await session.connect(other)).toBe(true);
    await vi.waitFor(() => expect(session.syncing).toBe(false));
    await selection.cache!.flush();
    const accepted = selection.cache!;
    const writes = disk.writes;
    old.resolve(snapshot());
    await refreshing;
    expect(selection.cache).toBe(accepted);
    expect(accepted.artists.get("artist")?.name).toBe("Other");
    expect(disk.writes).toBe(writes);
    expect(session.refreshError).toBe("");
  });
});

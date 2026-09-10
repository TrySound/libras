import { describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./sync.svelte";
import type { MetadataEngine } from "./metadata.svelte";
import type { MetadataConnection } from "./network.svelte";
import { deferred } from "./session-test-helpers";

const connection = {
  account: { host: "https://music.example", username: "listener" },
  signal: new AbortController().signal,
  read: async () => ({ trackIds: [], position: 0 }),
  write: async () => {},
};

function setup() {
  const metadata = {
    account: connection.account,
    signal: connection.signal,
    getModifiedAt: vi.fn(async () => 10),
    readLibrary: vi.fn<MetadataConnection["readLibrary"]>(async () => ({
      artists: [],
      albums: [],
      tracks: [],
    })),
    prepareRefresh: vi.fn<MetadataEngine["prepareRefresh"]>(async () => ({
      existing: undefined as { lastModified: number | null; savedAt: number } | undefined,
      signal: new AbortController().signal,
      commit: vi.fn(async () => {}),
      finish: vi.fn(),
    })),
  };
  const covers = { refresh: vi.fn(async () => {}) };
  const queue = {
    setConnection: vi.fn(),
    refresh: vi.fn(async () => {}),
    error: undefined as unknown,
    storageError: undefined as unknown,
  };
  const sync = new SyncEngine({ metadata, covers, queue });
  return { sync, metadata, covers, queue };
}

describe("sync engine", () => {
  it("prepares a candidate while offline without touching the selected workspace", async () => {
    const { sync, metadata, queue, covers } = setup();
    const snapshot = await sync.prepareConnection(metadata);
    expect(snapshot).toMatchObject({
      account: metadata.account,
      lastModified: 10,
      savedAt: expect.any(Number),
      artists: [],
      albums: [],
      tracks: [],
    });
    expect(metadata.prepareRefresh).not.toHaveBeenCalled();
    expect(queue.refresh).not.toHaveBeenCalled();
    expect(queue.setConnection).not.toHaveBeenCalled();
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(sync.syncing).toBe(false);
  });

  it("aborts candidate library work when stopped and rejects a late result", async () => {
    const { sync, metadata } = setup();
    const response = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await response.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const pending = sync.prepareConnection(metadata);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    const signal = metadata.readLibrary.mock.calls[0][0];
    sync.stop();
    expect(signal.aborted).toBe(true);
    response.resolve();
    await rejected;
    expect(metadata.prepareRefresh).not.toHaveBeenCalled();
    expect(sync.error).toBeUndefined();
  });

  it("supersedes a candidate before its library fetch starts", async () => {
    const { sync, metadata } = setup();
    const timestamp = deferred<number>();
    metadata.getModifiedAt.mockReturnValueOnce(timestamp.promise);
    const first = sync.prepareConnection(metadata);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const replacement = await sync.prepareConnection(metadata);
    timestamp.resolve(10);
    await rejected;
    expect(replacement.account).toEqual(metadata.account);
    expect(metadata.readLibrary).toHaveBeenCalledOnce();
  });

  it("skips unchanged metadata during startup but fetches it on manual refresh", async () => {
    const { sync, metadata } = setup();
    const commit = vi.fn(async () => {});
    metadata.prepareRefresh.mockImplementation(async () => ({
      existing: { savedAt: 100, lastModified: 10 },
      signal: new AbortController().signal,
      commit,
      finish: () => {},
    }));
    sync.start(connection, metadata);
    await sync.refresh(false);
    expect(metadata.getModifiedAt).toHaveBeenCalledWith(10);
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    await sync.refresh();
    expect(metadata.readLibrary).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        account: metadata.account,
        lastModified: 10,
        savedAt: expect.any(Number),
        artists: [],
        albums: [],
        tracks: [],
      }),
      expect.any(Function),
    );
  });

  it("aborts a metadata workflow and finishes local state immediately when stopped", async () => {
    const { sync, metadata } = setup();
    const pending = deferred();
    const finish = vi.fn();
    const commit = vi.fn(async () => {});
    metadata.prepareRefresh.mockResolvedValueOnce({
      existing: undefined,
      signal: new AbortController().signal,
      commit,
      finish,
    });
    metadata.readLibrary.mockImplementationOnce(async () => {
      await pending.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    sync.start(connection, metadata);
    const refresh = sync.refresh();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    const call = metadata.readLibrary.mock.calls[0];
    expect(call[0].aborted).toBe(false);
    sync.stop();
    expect(call[0].aborted).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    pending.resolve();
    await refresh;
    expect(commit).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("refreshes the queue after metadata even if the library request fails", async () => {
    const { sync, metadata, queue } = setup();
    const error = new Error("Library unavailable");
    metadata.readLibrary.mockRejectedValueOnce(error);
    sync.start(connection, metadata);
    await sync.refresh();
    expect(queue.refresh).toHaveBeenCalledOnce();
    expect(sync.error).toBe(error);
  });

  it("reports queue storage failures without treating them as connection failures", async () => {
    const { sync, queue, metadata } = setup();
    queue.storageError = new Error("Storage unavailable");
    sync.start(connection, metadata);
    await sync.refresh();
    expect(sync.error).toBe(queue.storageError);
    expect(sync.syncing).toBe(false);
  });

  it("does no work until enabled and reconciles covers after metadata", async () => {
    const { sync, metadata, covers } = setup();
    await sync.refresh();
    expect(metadata.readLibrary).not.toHaveBeenCalled();
    sync.start(connection, metadata);
    const pending = deferred();
    metadata.getModifiedAt.mockImplementationOnce(async () => {
      await pending.promise;
      return 10;
    });
    const refresh = sync.refresh(false);
    expect(sync.syncing).toBe(true);
    expect(covers.refresh).not.toHaveBeenCalled();
    pending.resolve();
    await refresh;
    expect(covers.refresh).toHaveBeenCalledOnce();
    expect(sync.syncing).toBe(false);
  });

  it("shares an in-flight refresh and allows another after completion", async () => {
    const { sync, metadata } = setup();
    sync.start(connection, metadata);
    const pending = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await pending.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const first = sync.refresh();
    expect(sync.refresh()).toBe(first);
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    pending.resolve();
    await first;
    await sync.refresh();
    expect(metadata.readLibrary).toHaveBeenCalledTimes(2);
  });

  it("reports metadata failures and clears them on a successful retry", async () => {
    const { sync, metadata } = setup();
    sync.start(connection, metadata);
    const error = new Error("Refresh failed");
    metadata.readLibrary.mockRejectedValueOnce(error);
    await sync.refresh();
    expect(sync.error).toBe(error);
    await sync.refresh();
    expect(sync.error).toBeUndefined();
  });

  it("handles synchronous failures without leaving a stuck pending request", async () => {
    const { sync, metadata } = setup();
    sync.start(connection, metadata);
    const error = new Error("Failed");
    metadata.readLibrary.mockImplementationOnce(() => {
      throw error;
    });
    await sync.refresh();
    expect(sync.error).toBe(error);
    expect(sync.syncing).toBe(false);
    await sync.refresh();
    expect(metadata.readLibrary).toHaveBeenCalledTimes(2);
    expect(sync.error).toBeUndefined();
  });

  it("does not reconcile covers after a stopped refresh completes", async () => {
    const { sync, metadata, covers, queue } = setup();
    sync.start(connection, metadata);
    const pending = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await pending.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const refresh = sync.refresh();
    sync.stop();
    pending.resolve();
    await refresh;
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(queue.refresh).not.toHaveBeenCalled();
    expect(sync.syncing).toBe(false);
    expect(sync.error).toBeUndefined();
  });

  it("ignores old completion after stopping and starting a new connection", async () => {
    const { sync, metadata, covers } = setup();
    sync.start(connection, metadata);
    const old = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await old.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const first = sync.refresh();
    await vi.waitFor(() => expect(metadata.readLibrary).toHaveBeenCalledOnce());
    sync.stop();
    expect(sync.syncing).toBe(false);
    sync.start(connection, metadata);
    const current = deferred();
    metadata.readLibrary.mockImplementationOnce(async () => {
      await current.promise;
      return { artists: [], albums: [], tracks: [] };
    });
    const second = sync.refresh();
    old.reject(new Error("Old connection failed"));
    await first;
    expect(sync.error).toBeUndefined();
    expect(sync.syncing).toBe(true);
    expect(sync.refresh()).toBe(second);
    expect(covers.refresh).not.toHaveBeenCalled();
    current.resolve();
    await second;
    expect(covers.refresh).toHaveBeenCalledOnce();
    expect(sync.syncing).toBe(false);
  });
});

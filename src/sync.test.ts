import { describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./sync.svelte";
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
    setConnection: vi.fn(),
    refresh: vi.fn(async (_force = true) => {}),
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
    expect(metadata.refresh).not.toHaveBeenCalled();
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
    expect(metadata.refresh).not.toHaveBeenCalled();
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

  it("refreshes the queue after metadata even if the library request fails", async () => {
    const { sync, metadata, queue } = setup();
    const error = new Error("Library unavailable");
    metadata.refresh.mockRejectedValueOnce(error);
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
    expect(metadata.refresh).not.toHaveBeenCalled();
    sync.start(connection, metadata);
    const pending = deferred();
    metadata.refresh.mockImplementationOnce(async () => {
      await pending.promise;
      return;
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
    metadata.refresh.mockImplementationOnce(async () => {
      await pending.promise;
      return;
    });
    const first = sync.refresh();
    expect(sync.refresh()).toBe(first);
    await vi.waitFor(() => expect(metadata.refresh).toHaveBeenCalledOnce());
    pending.resolve();
    await first;
    await sync.refresh();
    expect(metadata.refresh).toHaveBeenCalledTimes(2);
  });

  it("reports metadata failures and clears them on a successful retry", async () => {
    const { sync, metadata } = setup();
    sync.start(connection, metadata);
    const error = new Error("Refresh failed");
    metadata.refresh.mockRejectedValueOnce(error);
    await sync.refresh();
    expect(sync.error).toBe(error);
    await sync.refresh();
    expect(sync.error).toBeUndefined();
  });

  it("handles synchronous failures without leaving a stuck pending request", async () => {
    const { sync, metadata } = setup();
    sync.start(connection, metadata);
    const error = new Error("Failed");
    metadata.refresh.mockImplementationOnce(() => {
      throw error;
    });
    await sync.refresh();
    expect(sync.error).toBe(error);
    expect(sync.syncing).toBe(false);
    await sync.refresh();
    expect(metadata.refresh).toHaveBeenCalledTimes(2);
    expect(sync.error).toBeUndefined();
  });

  it("does not reconcile covers after a stopped refresh completes", async () => {
    const { sync, metadata, covers, queue } = setup();
    sync.start(connection, metadata);
    const pending = deferred();
    metadata.refresh.mockImplementationOnce(async () => {
      await pending.promise;
      return;
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
    metadata.refresh.mockImplementationOnce(async () => {
      await old.promise;
      return;
    });
    const first = sync.refresh();
    await vi.waitFor(() => expect(metadata.refresh).toHaveBeenCalledOnce());
    sync.stop();
    expect(sync.syncing).toBe(false);
    sync.start(connection, metadata);
    const current = deferred();
    metadata.refresh.mockImplementationOnce(async () => {
      await current.promise;
      return;
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

import { describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./sync.svelte";
import { deferred } from "./session-test-helpers";

const connection = {
  account: { host: "https://music.example", username: "listener" },
  signal: new AbortController().signal,
  read: async () => ({ trackIds: [], position: 0 }),
  write: async () => {},
};

function setup() {
  const metadata = {
    refresh: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    status: "ready" as "ready" | "error",
    error: undefined as unknown,
    warning: undefined as unknown,
  };
  const covers = { refresh: vi.fn(async () => {}) };
  const queue = {
    prepareServerUpdate: vi.fn(async () => ({
      queue: { tracks: [] as string[], index: -1, position: 0 },
      commit: vi.fn(async () => {}),
    })),
    storageError: undefined as unknown,
    setSync: vi.fn(),
    prepareServerWrite: vi.fn<import("./queue.svelte").QueueEngine["prepareServerWrite"]>(
      async () => undefined,
    ),
  };
  const sync = new SyncEngine({ metadata, covers, queue });
  return { sync, metadata, covers, queue };
}

describe("sync engine", () => {
  it.each([
    { ids: ["a", "b", "a"], selected: "a", index: 2, position: 9 },
    { ids: ["a", "a"], selected: "a", index: 0, position: 9 },
    { ids: ["a", "b", "a"], selected: "b", index: 1, position: 9 },
    { ids: ["a", "b", "a"], selected: "missing", index: -1, position: 0 },
    { ids: [], selected: undefined, index: -1, position: 0 },
  ])(
    "maps server selection to a local occurrence: $selected / $index",
    async ({ ids, selected, index, position }) => {
      const { sync, queue } = setup();
      const commit = vi.fn(async () => {});
      queue.prepareServerUpdate.mockResolvedValueOnce({
        queue: { tracks: ["a", "b", "a"], index: 2, position: 3 },
        commit,
      });
      sync.start({
        ...connection,
        read: async () => ({ trackIds: ids, currentTrackId: selected, position: 9 }),
      });
      await sync.refreshQueue();
      expect(commit).toHaveBeenCalledWith({ tracks: ids, index, position });
    },
  );

  it.each([2, -1])("maps local occurrence %s to a server selection", async (index) => {
    const { sync, queue } = setup();
    queue.prepareServerWrite.mockResolvedValueOnce({
      queue: { tracks: ["a", "b", "a"], index, position: index >= 0 ? 4 : 0 },
      commit: async () => {},
    });
    const write = vi.fn(async () => {});
    sync.start({ ...connection, write });
    await sync.writeQueue();
    expect(write).toHaveBeenCalledWith({
      trackIds: ["a", "b", "a"],
      currentTrackId: index >= 0 ? "a" : undefined,
      position: index >= 0 ? 4 : 0,
    });
  });

  it("serializes queue writes and acknowledges them only after server success", async () => {
    const { sync, queue } = setup();
    const response = deferred();
    const commit = vi.fn(async () => {});
    queue.prepareServerWrite.mockResolvedValue({
      queue: { tracks: ["one"], index: 0, position: 2 },
      commit,
    });
    const write = vi.fn(async () => {});
    write.mockReturnValueOnce(response.promise);
    sync.start({ ...connection, write });
    const first = sync.writeQueue();
    const second = sync.writeQueue();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(queue.prepareServerWrite).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    response.resolve();
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge failed queue writes and reports the error", async () => {
    const { sync, queue } = setup();
    const commit = vi.fn(async () => {});
    queue.prepareServerWrite.mockResolvedValue({
      queue: { tracks: ["one"], index: 0, position: 0 },
      commit,
    });
    const error = new Error("Write failed");
    sync.start({
      ...connection,
      write: async () => {
        throw error;
      },
    });
    await sync.writeQueue();
    expect(commit).not.toHaveBeenCalled();
    expect(sync.error).toBe(error);
  });

  it("does not replay queued writes or acknowledge old responses after reconnecting", async () => {
    const { sync, queue } = setup();
    const commit = vi.fn(async () => {});
    queue.prepareServerWrite.mockResolvedValue({
      queue: { tracks: ["one"], index: 0, position: 0 },
      commit,
    });
    const oldResponse = deferred();
    const oldWrite = vi.fn(() => oldResponse.promise);
    sync.start({ ...connection, write: oldWrite });
    const first = sync.writeQueue();
    const queued = sync.writeQueue();
    await vi.waitFor(() => expect(oldWrite).toHaveBeenCalledOnce());
    const newWrite = vi.fn(async () => {});
    sync.start({ ...connection, write: newWrite });
    await sync.writeQueue();
    expect(newWrite).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    oldResponse.resolve();
    await Promise.all([first, queued]);
    expect(oldWrite).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(sync.error).toBeUndefined();
  });

  it("owns queue reads and coalesces requests until local application completes", async () => {
    const { sync, queue } = setup();
    const stored = deferred();
    const commit = vi.fn(async () => stored.promise);
    queue.prepareServerUpdate.mockResolvedValueOnce({
      queue: { tracks: [], index: -1, position: 0 },
      commit,
    });
    const read = vi.fn(async () => ({ trackIds: ["one"], currentTrackId: "one", position: 2 }));
    sync.start({ ...connection, read });
    expect(read).not.toHaveBeenCalled();
    const pending = sync.refreshQueue();
    expect(sync.refreshQueue()).toBe(pending);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(queue.prepareServerUpdate).toHaveBeenCalledWith(
      connection.account,
      expect.any(Function),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ tracks: ["one"], index: 0, position: 2 });
    expect(sync.refreshQueue()).toBe(pending);
    stored.resolve();
    await pending;
  });

  it.each(["resolve", "reject"])("ignores a stopped queue read that later %ss", async (outcome) => {
    const { sync, queue } = setup();
    const commit = vi.fn(async () => {});
    queue.prepareServerUpdate.mockResolvedValueOnce({
      queue: { tracks: [], index: -1, position: 0 },
      commit,
    });
    const remote = deferred<{ trackIds: string[]; position: number }>();
    const read = vi.fn(() => remote.promise);
    sync.start({ ...connection, read });
    const pending = sync.refreshQueue();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    sync.stop();
    if (outcome === "resolve") remote.resolve({ trackIds: [], position: 0 });
    else remote.reject(new Error("Old connection failed"));
    await pending;
    expect(commit).not.toHaveBeenCalled();
    expect(sync.error).toBeUndefined();
  });

  it("owns queue read errors and clears them on a successful manual refresh", async () => {
    const { sync } = setup();
    const error = new Error("Queue unavailable");
    const read = vi.fn(async () => ({ trackIds: [], position: 0 }));
    read.mockRejectedValueOnce(error);
    sync.start({ ...connection, read });
    await sync.refresh();
    expect(sync.error).toBe(error);
    await sync.refresh();
    expect(sync.error).toBeUndefined();
  });

  it("refreshes the queue after metadata even if the library request fails", async () => {
    const { sync, metadata, queue } = setup();
    const error = new Error("Library unavailable");
    metadata.refresh.mockRejectedValueOnce(error);
    sync.start(connection);
    await sync.refresh();
    expect(queue.prepareServerUpdate).toHaveBeenCalledOnce();
    expect(sync.error).toBe(error);
  });

  it("reports queue storage failures without treating them as connection failures", async () => {
    const { sync, queue } = setup();
    queue.storageError = new Error("Storage unavailable");
    sync.start(connection);
    await sync.refresh();
    expect(sync.error).toBe(queue.storageError);
    expect(sync.syncing).toBe(false);
  });

  it("does no work until enabled and reconciles covers after metadata", async () => {
    const { sync, metadata, covers } = setup();
    await sync.refresh();
    expect(metadata.refresh).not.toHaveBeenCalled();
    sync.start(connection);
    const pending = deferred();
    metadata.revalidate.mockReturnValueOnce(pending.promise);
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
    sync.start(connection);
    const pending = deferred();
    metadata.refresh.mockReturnValueOnce(pending.promise);
    const first = sync.refresh();
    expect(sync.refresh()).toBe(first);
    expect(metadata.refresh).toHaveBeenCalledOnce();
    pending.resolve();
    await first;
    await sync.refresh();
    expect(metadata.refresh).toHaveBeenCalledTimes(2);
  });

  it("reports domain warnings and clears them on a successful retry", async () => {
    const { sync, metadata } = setup();
    sync.start(connection);
    metadata.warning = new Error("Refresh failed");
    await sync.refresh();
    expect(sync.error).toBe(metadata.warning);
    metadata.warning = undefined;
    await sync.refresh();
    expect(sync.error).toBeUndefined();
  });

  it("handles synchronous failures without leaving a stuck pending request", async () => {
    const { sync, metadata } = setup();
    sync.start(connection);
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
    sync.start(connection);
    const pending = deferred();
    metadata.refresh.mockReturnValueOnce(pending.promise);
    const refresh = sync.refresh();
    sync.stop();
    pending.resolve();
    await refresh;
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(queue.prepareServerUpdate).not.toHaveBeenCalled();
    expect(sync.syncing).toBe(false);
    expect(sync.error).toBeUndefined();
  });

  it("ignores old completion after stopping and starting a new connection", async () => {
    const { sync, metadata, covers } = setup();
    sync.start(connection);
    const old = deferred();
    metadata.refresh.mockReturnValueOnce(old.promise);
    const first = sync.refresh();
    sync.stop();
    expect(sync.syncing).toBe(false);
    sync.start(connection);
    const current = deferred();
    metadata.refresh.mockReturnValueOnce(current.promise);
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

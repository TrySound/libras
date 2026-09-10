import { describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./sync.svelte";
import { deferred } from "./session-test-helpers";

function setup() {
  const metadata = {
    refresh: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    status: "ready" as "ready" | "error",
    error: undefined as unknown,
    warning: undefined as unknown,
  };
  const covers = { refresh: vi.fn(async () => {}) };
  const sync = new SyncEngine({ metadata, covers });
  return { sync, metadata, covers };
}

describe("sync engine", () => {
  it("does no work until enabled and reconciles covers after metadata", async () => {
    const { sync, metadata, covers } = setup();
    await sync.refresh();
    expect(metadata.refresh).not.toHaveBeenCalled();
    sync.start();
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
    sync.start();
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
    sync.start();
    metadata.warning = new Error("Refresh failed");
    await sync.refresh();
    expect(sync.error).toBe(metadata.warning);
    metadata.warning = undefined;
    await sync.refresh();
    expect(sync.error).toBeUndefined();
  });

  it("handles synchronous failures without leaving a stuck pending request", async () => {
    const { sync, metadata } = setup();
    sync.start();
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
    const { sync, metadata, covers } = setup();
    sync.start();
    const pending = deferred();
    metadata.refresh.mockReturnValueOnce(pending.promise);
    const refresh = sync.refresh();
    sync.stop();
    pending.resolve();
    await refresh;
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(sync.syncing).toBe(false);
    expect(sync.error).toBeUndefined();
  });

  it("ignores old completion after stopping and starting a new connection", async () => {
    const { sync, metadata, covers } = setup();
    sync.start();
    const old = deferred();
    metadata.refresh.mockReturnValueOnce(old.promise);
    const first = sync.refresh();
    sync.stop();
    expect(sync.syncing).toBe(false);
    sync.start();
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

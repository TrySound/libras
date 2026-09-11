import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueEngine } from "../src/queue.svelte";
import { Cache, type CachedQueue } from "../src/cache.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { Network, type RemoteQueue } from "../src/network.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const local = (): CachedQueue => ({ tracks: ["a", "b", "a"], index: 2, position: 12.5 });
const remote = (): RemoteQueue => ({ trackIds: ["remote"], currentTrackId: "remote", position: 9 });
let disk: ReturnType<typeof installDisk>;
const engines: QueueEngine[] = [];
const caches: Cache[] = [];
function client(identity = account) {
  const controller = new AbortController();
  return {
    account: identity,
    signal: controller.signal,
    read: vi.fn(async (): Promise<RemoteQueue> => remote()),
    write: vi.fn(async (_value: RemoteQueue) => {}),
    abort: () => controller.abort(),
  };
}
async function path(identity = account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([identity.host, identity.username])),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `accounts/${hash}/queue.json`;
}
async function seed(queue = local(), identity = account, updatedAt = 42) {
  disk.files.set(await path(identity), JSON.stringify({ value: queue, updatedAt }));
}
async function json(identity = account) {
  return JSON.parse(disk.files.get(await path(identity))!);
}
async function setup(identity = account) {
  const cache = new Cache(identity);
  caches.push(cache);
  const selection = new TestSelection();
  selection.cache = cache;
  const queue = new QueueEngine(selection);
  engines.push(queue);
  await cache.load().catch(() => {});
  queue.activate();
  return { cache, selection, queue };
}
beforeEach(() => {
  disk = installDisk();
});
afterEach(async () => {
  disk.state.failClose = false;
  for (const queue of engines.splice(0)) await queue.destroy();
  for (const cache of caches.splice(0)) await cache.flush().catch(() => {});
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("queue engine using the selected cache", () => {
  it("configures and activates without performing local or network I/O", () => {
    const selection = new TestSelection();
    const queue = new QueueEngine(selection);
    engines.push(queue);
    const connection = client();
    queue.setConnection(connection);
    queue.setConnection(undefined);
    queue.activate();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(connection.read).not.toHaveBeenCalled();
    expect(connection.write).not.toHaveBeenCalled();
  });

  it("publishes a complete normalized queue before playback notifications", async () => {
    const { queue, selection } = await setup();
    const seen: unknown[] = [];
    queue.subscribe(() =>
      seen.push({
        tracks: selection.cache!.queue.tracks,
        index: selection.cache!.queue.index,
        position: selection.cache!.queue.position,
      }),
    );
    const tracks = ["a", "b", "a"];
    queue.update({ tracks, index: 2, position: 12 });
    const publishedTracks = selection.cache!.queue.tracks;
    tracks.push("changed");
    queue.setPosition(15);
    expect(selection.cache!.queue.tracks).toBe(publishedTracks);
    queue.update({ tracks: ["b"], index: 9, position: 20 });
    expect(seen).toEqual([
      { tracks: ["a", "b", "a"], index: 2, position: 12 },
      { tracks: ["a", "b", "a"], index: 2, position: 15 },
      { tracks: ["b"], index: -1, position: 0 },
    ]);
    await queue.flush();
    expect(seen).toHaveLength(3);
  });

  it.each([
    { ids: ["a", "b", "a"], selected: "a", index: 2, position: 9 },
    { ids: ["a", "a"], selected: "a", index: 0, position: 9 },
    { ids: ["a", "b", "a"], selected: "b", index: 1, position: 9 },
    { ids: ["a", "b", "a"], selected: "missing", index: -1, position: 0 },
    { ids: [], selected: undefined, index: -1, position: 0 },
  ])("maps remote selection to occurrence $index", async ({ ids, selected, index, position }) => {
    await seed();
    const { queue, cache } = await setup();
    const connection = client();
    connection.read.mockResolvedValue({ trackIds: ids, currentTrackId: selected, position: 9 });
    queue.setConnection(connection);
    await queue.refresh();
    expect(cache.queue).toEqual({ tracks: ids, index, position });
    expect((await json()).value).toEqual(cache.queue);
  });

  it.each([2, -1])("maps local occurrence %s to server selection", async (index) => {
    const { queue } = await setup();
    const connection = client();
    queue.setConnection(connection);
    queue.update({ tracks: ["a", "b", "a"], index, position: index >= 0 ? 4 : 0 });
    await queue.flush();
    expect(connection.write).toHaveBeenCalledWith({
      trackIds: ["a", "b", "a"],
      currentTrackId: index >= 0 ? "a" : undefined,
      position: index >= 0 ? 4 : 0,
    });
  });

  it("serializes uploads and acknowledges only the sent revision", async () => {
    const { queue, cache } = await setup();
    const connection = client();
    const response = deferred();
    connection.write.mockReturnValueOnce(response.promise);
    queue.setConnection(connection);
    queue.update({ tracks: ["first"], index: 0, position: 0 });
    const first = queue.flush();
    await vi.waitFor(() => expect(connection.write).toHaveBeenCalledOnce());
    queue.update({ tracks: ["second"], index: 0, position: 0 });
    const second = queue.flush();
    await Promise.resolve();
    expect(connection.write).toHaveBeenCalledOnce();
    response.resolve();
    await Promise.all([first, second]);
    expect(connection.write).toHaveBeenCalledTimes(2);
    expect(cache.queue.tracks).toEqual(["second"]);
  });

  it("never uploads a revision newer than the completed checkpoint", async () => {
    const { queue, cache } = await setup();
    const connection = client();
    queue.setConnection(connection);
    queue.update(local());
    let changes = 0;
    disk.state.afterClose = () => {
      if (changes++ < 2) queue.setPosition(20 + changes);
    };
    await queue.flush();
    expect(connection.write).not.toHaveBeenCalled();
    expect(cache.queueDirty).toBe(true);
    disk.state.afterClose = () => {};
    await queue.flush();
    expect(connection.write).toHaveBeenCalledWith(expect.objectContaining({ position: 22 }));
    expect(cache.queueDirty).toBe(false);
  });

  it("does not write another checkpoint after an upload acknowledgement", async () => {
    const { queue } = await setup();
    const connection = client();
    queue.setConnection(connection);
    queue.update(local());
    await queue.flush();
    await queue.flush();
    expect(disk.state.writes).toBe(1);
    expect(connection.write).toHaveBeenCalledOnce();
  });

  it("retains local state and retries a rejected upload explicitly", async () => {
    const { queue, cache } = await setup();
    const connection = client();
    const error = new Error("Upload failed");
    connection.write.mockRejectedValueOnce(error);
    queue.setConnection(connection);
    queue.update(local());
    await queue.flush();
    expect(queue.error).toBe(error);
    expect(cache.queue).toEqual(local());
    await queue.flush();
    expect(queue.error).toBeUndefined();
    expect(connection.write).toHaveBeenCalledTimes(2);
  });

  it("discards queued uploads and late acknowledgements on connection replacement", async () => {
    const { queue, cache } = await setup();
    const old = client();
    const response = deferred();
    old.write.mockReturnValueOnce(response.promise);
    queue.setConnection(old);
    queue.update(local());
    const first = queue.flush();
    await vi.waitFor(() => expect(old.write).toHaveBeenCalledOnce());
    const queued = queue.flush();
    const next = client();
    queue.setConnection(next);
    response.resolve();
    await Promise.all([first, queued]);
    queue.select(0);
    await queue.flush();
    expect(old.write).toHaveBeenCalledOnce();
    expect(next.write).not.toHaveBeenCalled();
    expect(cache.queue.index).toBe(0);
    queue.update(local());
    await queue.flush();
    expect(next.write).toHaveBeenCalledOnce();
  });

  it.each([false, true])("ignores detached reads, including failures (%s)", async (failure) => {
    await seed();
    const { queue, cache } = await setup();
    const connection = client();
    const response = deferred<RemoteQueue>();
    connection.read.mockReturnValueOnce(response.promise);
    queue.setConnection(connection);
    const pending = queue.refresh();
    await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
    queue.setConnection(undefined);
    connection.abort();
    if (failure) response.reject(new Error("Old read failed"));
    else response.resolve(remote());
    await pending;
    expect(queue.error).toBeUndefined();
    expect(cache.queue).toEqual(local());
    expect(disk.state.writes).toBe(0);
  });

  it.each(["local edit", "playback", "detach"])(
    "does not adopt a fetched queue after %s",
    async (action) => {
      await seed();
      const { queue, cache } = await setup();
      const connection = client();
      const response = deferred<RemoteQueue>();
      connection.read.mockReturnValueOnce(response.promise);
      queue.setConnection(connection);
      const pending = queue.refresh();
      await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
      if (action === "local edit") queue.select(0);
      if (action === "playback") queue.setPlaybackActive(true);
      if (action === "detach") queue.setConnection(undefined);
      response.resolve(remote());
      await pending;
      expect(cache.queue.tracks).toEqual(local().tracks);
      expect(cache.queue.index).toBe(action === "local edit" ? 0 : 2);
    },
  );

  it.each(["success", "failure", "local edit", "detach", "playback"])(
    "waits for persistence before publication: %s",
    async (outcome) => {
      await seed();
      const { queue, cache } = await setup();
      const connection = client();
      const closing = deferred();
      const release = deferred();
      disk.state.beforeClose = async () => {
        closing.resolve();
        await release.promise;
      };
      queue.setConnection(connection);
      const notify = vi.fn();
      queue.subscribe(notify);
      const pending = queue.refresh();
      expect(queue.refresh()).toBe(pending);
      await closing.promise;
      expect(queue.refresh()).toBe(pending);
      expect(cache.queue).toEqual(local());
      expect(notify).not.toHaveBeenCalled();
      if (outcome === "local edit") queue.update({ tracks: ["local"], index: 0, position: 0 });
      if (outcome === "detach") queue.setConnection(undefined);
      if (outcome === "playback") queue.setPlaybackActive(true);
      if (outcome === "failure") disk.state.failClose = true;
      release.resolve();
      await pending;
      if (outcome === "success") {
        expect(cache.queue.tracks).toEqual(["remote"]);
        expect(notify).toHaveBeenCalledOnce();
      } else if (outcome === "local edit") expect(cache.queue.tracks).toEqual(["local"]);
      else expect(cache.queue).toEqual(local());
      if (outcome === "failure") {
        expect(queue.storageError).toBeInstanceOf(Error);
        expect(queue.error).toBeUndefined();
      }
      disk.state.failClose = false;
      await queue.flush();
      expect((await json()).value).toEqual(cache.queue);
    },
  );

  it("preserves the last disk snapshot when a fetched queue cannot be written", async () => {
    await seed();
    const original = await json();
    const { queue, cache } = await setup();
    queue.setConnection(client());
    disk.state.failClose = true;
    await queue.refresh();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(cache.queue).toEqual(local());
    expect(await json()).toEqual(original);
  });

  it("keeps offline playback checkpoints local after reconnecting", async () => {
    const { queue, cache } = await setup();
    queue.update(local());
    queue.setPlaybackActive(true);
    await queue.flush();
    const connection = client();
    queue.setConnection(connection);
    queue.setPosition(20);
    await queue.flush();
    await queue.refresh();
    expect(connection.read).toHaveBeenCalledOnce();
    expect(connection.write).not.toHaveBeenCalled();
    expect(cache.queue.tracks).toEqual(local().tracks);
    queue.select(0);
    queue.setPosition(30);
    await queue.flush();
    expect(connection.write).not.toHaveBeenCalled();
    queue.update({ tracks: ["online"], index: 0, position: 0 });
    await queue.flush();
    expect(connection.write).toHaveBeenCalledOnce();
  });

  it("refuses to acknowledge or upload a conflicted checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { queue, cache } = await setup();
    const connection = client();
    queue.setConnection(connection);
    queue.update(local());
    await seed({ tracks: ["newer"], index: 0, position: 0 }, account, 5_000);
    await queue.flush();
    expect(queue.storageError).toBe(cache.queueError);
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(connection.write).not.toHaveBeenCalled();
    expect((await json()).value.tracks).toEqual(["newer"]);
    vi.setSystemTime(6_000);
    queue.update({ tracks: ["edited"], index: 0, position: 0 });
    await queue.flush();
    expect(connection.write).toHaveBeenCalledOnce();
    expect(queue.storageError).toBeUndefined();
  });

  it("does not overwrite another tab's newer queue when acknowledging a server upload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { queue } = await setup();
    const connection = client();
    connection.write.mockImplementationOnce(async () => {
      await seed(local(), account, 5_000);
    });
    queue.setConnection(connection);
    queue.update(local());
    await queue.flush();
    await queue.flush();
    expect((await json()).updatedAt).toBe(5_000);
    expect(connection.write).toHaveBeenCalledOnce();
    queue.setPosition(20);
    await queue.flush();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(connection.write).toHaveBeenCalledOnce();
  });

  it("checkpoints position changes every five seconds without continuous server saves", async () => {
    vi.useFakeTimers();
    await seed();
    const { queue, cache } = await setup();
    const connection = client();
    queue.setConnection(connection);
    for (let i = 1; i <= 21; i++) {
      queue.setPosition(i);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(disk.state.writes).toBe(1);
    expect((await json()).value.position).toBe(20);
    expect(cache.queue.position).toBe(21);
    expect(connection.write).not.toHaveBeenCalled();
    expect(connection.read).not.toHaveBeenCalled();
  });

  it("exposes local write errors separately and preserves optimistic edits", async () => {
    await seed();
    const original = await json();
    const { queue, cache } = await setup();
    const connection = client();
    queue.setConnection(connection);
    disk.state.failClose = true;
    queue.update({ tracks: ["new"], index: 0, position: 2 });
    await queue.flush();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(queue.error).toBeUndefined();
    expect(cache.queue.tracks).toEqual(["new"]);
    expect(await json()).toEqual(original);
    expect(connection.write).not.toHaveBeenCalled();
  });

  it("keeps local state after failed reads and retries only on explicit refresh", async () => {
    await seed();
    const { queue, cache } = await setup();
    const connection = client();
    const error = new Error("Offline");
    connection.read.mockRejectedValueOnce(error);
    queue.setConnection(connection);
    await queue.refresh();
    expect(queue.error).toBe(error);
    expect(cache.queue).toEqual(local());
    await queue.refresh();
    expect(queue.error).toBeUndefined();
    expect(cache.queue.tracks).toEqual(["remote"]);
  });

  it("isolates accounts and ignores a late response after Session selects a different cache", async () => {
    const { queue, selection } = await setup();
    const connection = client();
    const response = deferred<RemoteQueue>();
    connection.read.mockReturnValueOnce(response.promise);
    queue.setConnection(connection);
    const pending = queue.refresh();
    await vi.waitFor(() => expect(connection.read).toHaveBeenCalledOnce());
    const other = { ...account, username: "other" };
    await seed({ tracks: ["other"], index: 0, position: 4 }, other);
    const next = new Cache(other);
    caches.push(next);
    await next.load();
    queue.setConnection(undefined);
    selection.cache = next;
    queue.activate();
    response.resolve(remote());
    await pending;
    expect(selection.cache!.queue.tracks).toEqual(["other"]);
    expect((await json(other)).value.tracks).toEqual(["other"]);
  });

  it("preserves edits made during cache loading and activates without reloading", async () => {
    await seed();
    const cache = new Cache(account);
    caches.push(cache);
    const selection = new TestSelection();
    selection.cache = cache;
    const queue = new QueueEngine(selection);
    engines.push(queue);
    const loaded = cache.load();
    queue.update({ tracks: ["local"], index: 0, position: 3 });
    queue.setConnection(undefined);
    await loaded;
    queue.activate();
    expect(cache.queue.tracks).toEqual(["local"]);
    await queue.flush();
    expect((await json()).value.tracks).toEqual(["local"]);
  });

  it("uses configured network normalization without retaining server replicas or upload markers", async () => {
    await seed();
    const network = new Network();
    const connection = network.accept(
      network.prepare({ ...account, token: "token", salt: "salt" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              "subsonic-response": {
                status: "ok",
                playQueue: {
                  current: "a",
                  position: 12500,
                  entry: [{ id: "a" }, { id: "b" }, { id: "a" }],
                },
              },
            }),
          ),
      ),
    );
    const { queue, cache } = await setup();
    queue.setConnection(connection.queue);
    await queue.refresh();
    expect(cache.queue).toEqual(local());
    expect(await json()).not.toHaveProperty("pendingSync");
    expect(await json()).not.toHaveProperty("server");
    network.setMode("offline");
  });
});

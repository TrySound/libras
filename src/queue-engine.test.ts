import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueEngine } from "./queue.svelte";
import { Storage } from "./storage";
import { Network } from "./network.svelte";
import { Memory } from "./memory.svelte";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
function createConnection(credentials = auth) {
  const network = new Network();
  const connection = network.prepare(credentials);
  const queue = network.accept(connection).queue;
  return {
    account: queue.account,
    signal: queue.signal,
    read: () => queue.read(),
    write: (value: Parameters<typeof queue.write>[0]) => queue.write(value),
    abort: () => network.setMode("offline"),
  };
}
const record = () => ({
  account,
  tracks: ["a", "b", "a"],
  index: 2,
  position: 12.5,
  updatedAt: 42,
});
function response(data: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}
async function fileName(identity = account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${identity.host}\n${identity.username}`),
  );
  return `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
}
function installStorage() {
  const storage = {
    files: new Map<string, File>(),
    failWrites: false,
    writes: 0,
    async seed(data: unknown = record(), identity = account) {
      const name = await fileName(identity);
      storage.files.set(name, new File([JSON.stringify(data)], name));
    },
    async json(identity = account) {
      return JSON.parse(await storage.files.get(await fileName(identity))!.text());
    },
  };
  vi.stubGlobal("navigator", {
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle(name: string) {
            expect(name).toBe("queue");
            return {
              async getFileHandle(name: string, options?: { create?: boolean }) {
                if (!storage.files.has(name) && !options?.create)
                  throw new DOMException("Missing", "NotFoundError");
                if (!storage.files.has(name)) storage.files.set(name, new File([], name));
                return {
                  async getFile() {
                    return storage.files.get(name)!;
                  },
                  async createWritable() {
                    let data = "";
                    return {
                      async write(value: string) {
                        if (storage.failWrites) throw new Error("Storage full");
                        data = value;
                      },
                      async close() {
                        storage.writes++;
                        storage.files.set(name, new File([data], name));
                      },
                      async abort() {},
                    };
                  },
                };
              },
              async removeEntry(name: string) {
                storage.files.delete(name);
              },
            };
          },
        };
      },
    },
  });
  return storage;
}
let storage: ReturnType<typeof installStorage>;
const engines: QueueEngine[] = [];
function engine(memory: Memory) {
  const queue = new QueueEngine(memory);
  engines.push(queue);
  return queue;
}
beforeEach(() => {
  storage = installStorage();
});
afterEach(async () => {
  for (const queue of engines.splice(0)) await queue.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function connectQueue(queue: QueueEngine, client: ReturnType<typeof createConnection>) {
  await queue.restore(new Storage(client.account));
  queue.setConnection(client);
  await queue.refresh();
}

describe("queue engine", () => {
  it.each(["refresh", "acknowledge"])(
    "retains the confirmed snapshot when %s cannot be persisted",
    async (mode) => {
      const server = { tracks: ["confirmed"], index: 0, position: 5 };
      await storage.seed({ ...record(), server });
      const memory = new Memory();
      const queue = engine(memory);
      await queue.restore(new Storage(account));
      const previous = memory.serverQueue;
      const client = createConnection();
      vi.spyOn(client, "read").mockResolvedValue({
        trackIds: ["incoming"],
        currentTrackId: "incoming",
        position: 10,
      });
      vi.spyOn(client, "write").mockImplementation(async () => {
        // The local command is durable; only the acknowledgement write fails.
        storage.failWrites = true;
      });
      queue.setConnection(client);
      if (mode === "refresh") {
        storage.failWrites = true;
        await queue.refresh();
        expect(memory.queueTracks).toEqual(record().tracks);
      } else {
        queue.update({ tracks: ["edited"], index: 0, position: 0 });
        await queue.flush();
        expect(memory.queueTracks).toEqual(["edited"]);
      }
      expect(queue.storageError).toBeInstanceOf(Error);
      expect(memory.serverQueue).toBe(previous);
      expect((await storage.json()).server).toEqual(server);
      storage.failWrites = false;
    },
  );

  it.each([
    { ids: ["a", "b", "a"], selected: "a", index: 2, position: 9 },
    { ids: ["a", "a"], selected: "a", index: 0, position: 9 },
    { ids: ["a", "b", "a"], selected: "b", index: 1, position: 9 },
    { ids: ["a", "b", "a"], selected: "missing", index: -1, position: 0 },
    { ids: [], selected: undefined, index: -1, position: 0 },
  ])(
    "maps server selection to local occurrence $index",
    async ({ ids, selected, index, position }) => {
      await storage.seed();
      const memory = new Memory();
      const queue = engine(memory);
      const client = createConnection();
      vi.spyOn(client, "read").mockResolvedValue({
        trackIds: ids,
        currentTrackId: selected,
        position: 9,
      });
      await connectQueue(queue, client);
      expect(memory.serverQueue).toEqual({ tracks: ids, index, position });
      expect(memory.queueIndex).toBe(index);
    },
  );

  it.each([2, -1])("maps local occurrence %s to server selection", async (index) => {
    const queue = engine(new Memory());
    await queue.restore(new Storage(account));
    const client = createConnection();
    const write = vi.spyOn(client, "write").mockResolvedValue(undefined);
    queue.setConnection(client);
    queue.update({ tracks: ["a", "b", "a"], index, position: index >= 0 ? 4 : 0 });
    await queue.flush();
    expect(write).toHaveBeenCalledWith({
      trackIds: ["a", "b", "a"],
      currentTrackId: index >= 0 ? "a" : undefined,
      position: index >= 0 ? 4 : 0,
    });
  });

  it("serializes writes and preserves an edit made while awaiting acknowledgement", async () => {
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    const client = createConnection();
    const response = deferred();
    const write = vi.spyOn(client, "write").mockResolvedValue(undefined);
    write.mockReturnValueOnce(response.promise);
    queue.setConnection(client);
    queue.update({ tracks: ["first"], index: 0, position: 0 });
    const first = queue.flush();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    queue.update({ tracks: ["second"], index: 0, position: 0 });
    const second = queue.flush();
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    expect(memory.serverQueue).toBeNull();
    response.resolve();
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(memory.serverQueue?.tracks).toEqual(["second"]);
  });

  it("retains the last server snapshot after a rejected write", async () => {
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    const client = createConnection();
    const error = new Error("Write failed");
    vi.spyOn(client, "write").mockRejectedValue(error);
    queue.setConnection(client);
    queue.update({ tracks: ["local"], index: 0, position: 0 });
    await queue.flush();
    expect(queue.error).toBe(error);
    expect(memory.serverQueue).toBeNull();
    expect(memory.queueTracks).toEqual(["local"]);
  });

  it("discards queued writes and stale acknowledgements on connection replacement", async () => {
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    const old = createConnection();
    const response = deferred();
    const oldWrite = vi.spyOn(old, "write").mockReturnValue(response.promise);
    queue.setConnection(old);
    queue.update({ tracks: ["old"], index: 0, position: 0 });
    const first = queue.flush();
    await vi.waitFor(() => expect(oldWrite).toHaveBeenCalledOnce());
    const queued = queue.flush();
    const replacement = createConnection();
    const write = vi.spyOn(replacement, "write").mockResolvedValue(undefined);
    queue.setConnection(replacement);
    queue.update({ tracks: ["new"], index: 0, position: 0 });
    await queue.flush();
    response.resolve();
    await Promise.all([first, queued]);
    expect(oldWrite).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(memory.serverQueue?.tracks).toEqual(["new"]);
    expect(queue.error).toBeUndefined();
  });

  it("coalesces refreshes through persistence completion", async () => {
    const memory = new Memory();
    const queue = engine(memory);
    const stored = deferred<{ written: boolean; value: ReturnType<typeof record> }>();
    const save = vi.fn(() => stored.promise);
    await queue.restore({ account, queue: { account, read: async () => record(), save } });
    const client = createConnection();
    const read = vi
      .spyOn(client, "read")
      .mockResolvedValue({ trackIds: ["remote"], currentTrackId: "remote", position: 0 });
    queue.setConnection(client);
    const pending = queue.refresh();
    expect(queue.refresh()).toBe(pending);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(queue.refresh()).toBe(pending);
    expect(read).toHaveBeenCalledOnce();
    stored.resolve({ written: true, value: record() });
    await pending;
    expect(memory.serverQueue?.tracks).toEqual(["remote"]);
  });

  it.each([false, true])("ignores a detached read (failure: %s)", async (failure) => {
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    const client = createConnection();
    const response = deferred<{ trackIds: string[]; position: number }>();
    const read = vi.spyOn(client, "read").mockReturnValue(response.promise);
    queue.setConnection(client);
    const pending = queue.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    queue.setConnection(undefined);
    if (failure) response.reject(new Error("Old read failed"));
    else response.resolve({ trackIds: ["old"], position: 0 });
    await pending;
    expect(memory.serverQueue).toBeNull();
    expect(queue.error).toBeUndefined();
  });

  it("clears a read error after a successful refresh", async () => {
    const queue = engine(new Memory());
    await queue.restore(new Storage(account));
    const client = createConnection();
    const error = new Error("Read failed");
    const read = vi.spyOn(client, "read").mockResolvedValue({ trackIds: [], position: 0 });
    read.mockRejectedValueOnce(error);
    queue.setConnection(client);
    await queue.refresh();
    expect(queue.error).toBe(error);
    await queue.refresh();
    expect(queue.error).toBeUndefined();
  });

  it("publishes a server write acknowledgement only after local persistence", async () => {
    const memory = new Memory();
    const queue = engine(memory);
    const stored = deferred<{ written: boolean; value: ReturnType<typeof record> }>();
    const save = vi.fn(async () => ({ written: true, value: record() }));
    save.mockImplementationOnce(async () => ({ written: true, value: record() }));
    save.mockImplementationOnce(() => stored.promise);
    await queue.restore({ account, queue: { account, read: async () => record(), save } });
    const connection = createConnection();
    const write = vi.spyOn(connection, "write").mockResolvedValue(undefined);
    queue.setConnection(connection);
    queue.update({ tracks: ["new"], index: 0, position: 5 });
    const pending = queue.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenCalledOnce();
    expect(memory.serverQueue).toBeNull();
    stored.resolve({ written: true, value: record() });
    await pending;
    expect(memory.serverQueue).toEqual({ tracks: ["new"], index: 0, position: 5 });
  });

  it("keeps offline playback checkpoints local after reconnecting", async () => {
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    queue.update({ tracks: ["offline"], index: 0, position: 10 });
    queue.setPlaybackActive(true);
    await queue.flush();
    const connection = createConnection();
    const write = vi.spyOn(connection, "write").mockResolvedValue(undefined);
    const read = vi
      .spyOn(connection, "read")
      .mockResolvedValue({ trackIds: ["server"], currentTrackId: "server", position: 5 });
    queue.setConnection(connection);
    queue.setPosition(20);
    await queue.flush();
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await queue.refresh();
    expect(read).toHaveBeenCalledOnce();
    expect(memory.queueTracks).toEqual(["offline"]);
    expect(memory.serverQueue?.tracks).toEqual(["server"]);
    queue.select(0);
    queue.setPosition(30);
    await queue.flush();
    expect(write).not.toHaveBeenCalled();
    // An explicit new online queue is a server command, unlike session navigation.
    queue.update({ tracks: ["online"], index: 0, position: 0 });
    await queue.flush();
    expect(write).toHaveBeenCalledOnce();
  });

  it("restores the server replica separately and retains it through local checkpoints", async () => {
    const server = { tracks: ["server"], index: 0, position: 30 };
    await storage.seed({ ...record(), server });
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    expect(memory.serverQueue).toEqual(server);
    expect(memory.queueTracks).toEqual(record().tracks);
    queue.setPosition(45);
    await queue.flush();
    expect(await storage.json()).toMatchObject({ position: 45, server });
    const restoredMemory = new Memory();
    const restored = engine(restoredMemory);
    await restored.restore(new Storage(account));
    expect(restoredMemory.serverQueue).toEqual(server);
    expect(restoredMemory.queuePosition).toBe(45);
    await restored.restore(new Storage({ ...account, username: "other" }));
    expect(restoredMemory.serverQueue).toBeNull();
  });

  it.each(["success", "failure", "conflict", "local edit", "detach"])(
    "waits for durable server state before publication: %s",
    async (outcome) => {
      const memory = new Memory();
      const queue = engine(memory);
      const committed = deferred<{ written: boolean; value: ReturnType<typeof record> }>();
      const store = {
        account,
        queue: {
          account,
          read: vi.fn(async () => record()),
          save: vi.fn(async () => ({ written: true, value: record() })),
        },
      };
      await queue.restore(store);
      const client = createConnection();
      vi.spyOn(client, "read").mockResolvedValue({
        trackIds: ["remote"],
        currentTrackId: "remote",
        position: 9,
      });
      queue.setConnection(client);
      const notify = vi.fn();
      queue.subscribe(notify);
      store.queue.save.mockReturnValueOnce(committed.promise);
      const pending = queue.refresh();
      await vi.waitFor(() => expect(store.queue.save).toHaveBeenCalledOnce());
      expect(memory.queueTracks).toEqual(record().tracks);
      expect(notify).not.toHaveBeenCalled();
      expect(store.queue.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tracks: ["remote"],
          index: 0,
          position: 9,
        }),
      );
      if (outcome === "local edit") queue.update({ tracks: ["local"], index: 0, position: 0 });
      if (outcome === "detach") queue.setConnection(undefined);
      if (outcome === "failure") committed.reject(new Error("Disk unavailable"));
      else committed.resolve({ written: outcome !== "conflict", value: record() });
      await pending;
      if (outcome === "success") {
        expect(memory.queueTracks).toEqual(["remote"]);
        expect(memory.queuePosition).toBe(9);
        expect(notify).toHaveBeenCalledOnce();
      } else if (outcome === "local edit") {
        expect(memory.queueTracks).toEqual(["local"]);
        expect(notify).toHaveBeenCalledOnce();
      } else {
        expect(memory.queueTracks).toEqual(record().tracks);
        expect(notify).not.toHaveBeenCalled();
      }
      if (outcome === "failure" || outcome === "conflict")
        expect(queue.storageError).toBeInstanceOf(Error);
    },
  );

  it("uses injected storage and retains engine-owned conflict handling", async () => {
    const saved = record();
    const store = {
      account,
      read: vi.fn(async () => saved),
      save: vi.fn(async () => ({
        written: false,
        value: { ...saved, updatedAt: Date.now() + 1000 },
      })),
    };
    const disk = { account, queue: store };
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(disk);
    expect(store.read).toHaveBeenCalledOnce();
    expect(memory.queueIndex).toBe(2);
    queue.update({ tracks: ["edited"], index: 0, position: 2 });
    await queue.flush();
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        tracks: ["edited"],
        index: 0,
        position: 2,
      }),
    );
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(memory.queueTracks).toEqual(["edited"]);
    expect(storage.writes).toBe(0);
  });

  it("preserves the queue when a server response arrives after credentials are detached", async () => {
    await storage.seed();
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    const client = createConnection(auth);
    let resolve!: (value: { trackIds: string[]; currentTrackId: string; position: number }) => void;
    vi.spyOn(client, "read").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    queue.setConnection(client);
    const loading = queue.refresh();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    queue.setConnection(undefined);
    client.abort();
    resolve({ trackIds: ["late"], currentTrackId: "late", position: 0 });
    await loading;
    expect(memory.queueTracks).toEqual(["a", "b", "a"]);
    expect(memory.queueIndex).toBe(2);
    expect(memory.queuePosition).toBe(12.5);
    expect(storage.writes).toBe(0);
  });

  it("configures without I/O and synchronizes only on an explicit command", async () => {
    const getDirectory = vi.spyOn(navigator.storage, "getDirectory");
    const client = createConnection(auth);
    const load = vi
      .spyOn(client, "read")
      .mockResolvedValue({ trackIds: ["a"], currentTrackId: "a", position: 0 });
    const memory = new Memory();
    const queue = engine(memory);
    queue.setConnection(client);
    queue.setConnection(undefined);
    queue.setConnection(client);
    expect(getDirectory).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    await queue.restore(new Storage(account));
    expect(load).not.toHaveBeenCalled();
    await queue.refresh();
    expect(load).toHaveBeenCalledOnce();
    expect(memory.queueTracks).toEqual(["a"]);
    load.mockResolvedValue({ trackIds: ["b"], currentTrackId: "b", position: 0 });
    await queue.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    expect(memory.queueTracks).toEqual(["b"]);
  });

  it("publishes the complete normalized queue before notifying playback subscribers", () => {
    const memory = new Memory();

    const queue = engine(memory);
    const observed: unknown[] = [];
    queue.subscribe(() => {
      observed.push({
        tracks: memory.queueTracks,
        index: memory.queueIndex,
        position: memory.queuePosition,
      });
    });
    const input = ["a", "b", "a"];
    queue.update({ tracks: input, index: 2, position: 12 });
    const published = memory.queueTracks;
    input.push("changed");
    queue.setPosition(15);
    expect(memory.queueTracks).toBe(published);
    queue.update({ tracks: ["b"], index: 9, position: 20 });
    expect(published).toEqual(["a", "b", "a"]);
    expect(observed).toEqual([
      { tracks: ["a", "b", "a"], index: 2, position: 12 },
      { tracks: ["a", "b", "a"], index: 2, position: 15 },
      { tracks: ["b"], index: -1, position: 0 },
    ]);
  });

  it("reports a newer disk queue instead of acknowledging or uploading a skipped write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const client = createConnection(auth);
    vi.spyOn(client, "read").mockResolvedValue({
      trackIds: ["a"],
      currentTrackId: "a",
      position: 0,
    });
    const save = vi.spyOn(client, "write").mockResolvedValue(undefined);
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await connectQueue(queue, client);
    queue.update({ tracks: ["local"], index: 0, position: 0 });
    const newer = { ...record(), updatedAt: 5000, pendingSync: true };
    await storage.seed(newer);
    await queue.flush();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(queueMemory.queueTracks).toEqual(["local"]);
    expect(await storage.json()).toEqual(newer);
    expect(save).not.toHaveBeenCalled();
    await queue.flush();
    expect(save).not.toHaveBeenCalled();
    expect(queue.storageError).toBeInstanceOf(Error);
    vi.setSystemTime(6000);
    queue.update({ tracks: ["edited"], index: 0, position: 0 });
    await queue.flush();
    expect(queue.storageError).toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
    expect(await storage.json()).toMatchObject({ tracks: ["edited"] });
  });

  it("preserves a newer disk queue that appears while a server save is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const client = createConnection(auth);
    vi.spyOn(client, "read").mockResolvedValue({
      trackIds: ["a"],
      currentTrackId: "a",
      position: 0,
    });
    const newer = { ...record(), updatedAt: 5000, pendingSync: true };
    const save = vi.spyOn(client, "write").mockImplementation(async () => {
      await storage.seed(newer);
    });
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await connectQueue(queue, client);
    queue.update({ tracks: ["local"], index: 0, position: 0 });
    await queue.flush();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(await storage.json()).toEqual(newer);
    await queue.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(queue.storageError).toBeInstanceOf(Error);
  });

  it("restores IDs, duplicate occurrence index and position without a client or network", async () => {
    await storage.seed();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const memory = new Memory();

    const queue = engine(memory);
    await queue.restore(new Storage(account));
    expect(memory.queueTracks).toEqual(["a", "b", "a"]);
    expect(memory.queueIndex).toBe(2);
    expect(memory.queuePosition).toBe(12.5);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists offline edits and empty queues without credentials or track descriptions", async () => {
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.setConnection(undefined);
    await queue.restore(new Storage(account));
    queue.update({ tracks: ["a", "b", "a"], index: 2, position: 30 });
    queue.setPosition(35);
    await queue.flush();
    const saved = await storage.json();
    expect(saved).toMatchObject({
      account,
      tracks: ["a", "b", "a"],
      index: 2,
      position: 35,
    });
    expect(JSON.stringify(saved)).not.toMatch(/token|salt|title|playing|https:.*rest/);
    const restoredMemory = new Memory();
    const restored = engine(restoredMemory);
    await restored.restore(new Storage(account));
    expect(restoredMemory.queueTracks).toEqual(["a", "b", "a"]);
    expect(restoredMemory.queueIndex).toBe(2);
    expect(restoredMemory.queuePosition).toBe(35);
    await connectQueue(queue, createConnection(auth));
    queue.update({ tracks: [], position: 0 });
    await queue.flush();
    const empty = await storage.json();
    expect(empty).toMatchObject({
      tracks: [],
      index: -1,
      position: 0,
    });
    expect(JSON.stringify(empty)).not.toMatch(/token|salt|title|playing|https:.*rest/);
  });

  it("keeps local cache visible while loading a clean server queue and persists the result", async () => {
    await storage.seed();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.restore(new Storage(account));
    const connected = connectQueue(queue, createConnection(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(queueMemory.queueIndex).toBe(2);
    resolve(
      response({ playQueue: { current: "remote", position: 9000, entry: [{ id: "remote" }] } }),
    );
    await connected;
    expect(queueMemory.queueTracks).toEqual(["remote"]);
    expect(queueMemory.queueIndex).toBe(0);
    expect(queueMemory.queuePosition).toBe(9);
    expect(await storage.json()).not.toHaveProperty("pendingSync");
  });

  it("retains a cached duplicate occurrence when the server queue has not changed", async () => {
    await storage.seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          playQueue: {
            current: "a",
            position: 12500,
            entry: [{ id: "a" }, { id: "b" }, { id: "a" }],
          },
        }),
      ),
    );
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await connectQueue(queue, createConnection(auth));
    expect(queueMemory.queueIndex).toBe(2);
    expect((await storage.json()).index).toBe(2);
  });

  it("ignores legacy pending uploads and restores the server queue", async () => {
    await storage.seed({ ...record(), pendingSync: true });
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await connectQueue(queue, createConnection(auth));
    expect(fetcher).toHaveBeenCalledOnce();
    const [url] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("getPlayQueue");
    expect(queueMemory.queueIndex).toBe(-1);
    expect(await storage.json()).not.toHaveProperty("pendingSync");
  });

  it("does not overwrite a local selection with a late server restore", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    const connected = connectQueue(queue, createConnection(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    queue.update({ tracks: ["local"], index: 0, position: 2 });
    resolve(response({ playQueue: { current: "remote", entry: [{ id: "remote" }] } }));
    await connected;
    expect(queueMemory.queueTracks[queueMemory.queueIndex]).toBe("local");
    expect(queueMemory.queuePosition).toBe(2);
  });

  it("does not overwrite edits made during initial local restoration", async () => {
    await storage.seed();
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    const restored = queue.restore(new Storage(account));
    queue.update({ tracks: ["local"], index: 0, position: 3 });
    await restored;
    expect(queueMemory.queueTracks[queueMemory.queueIndex]).toBe("local");
    expect(await storage.json()).toMatchObject({ tracks: ["local"] });
  });

  it("does not replay a cancelled upload through a fresh connection", async () => {
    await storage.seed({ ...record(), pendingSync: true });
    const network = new Network();
    const client = network.accept(network.prepare(auth));
    const memory = new Memory();
    const queue = engine(memory);
    await queue.restore(new Storage(account));
    queue.setConnection(client.queue);
    let respond!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      ),
    );
    queue.update({ tracks: ["a", "b", "a"], index: 2, position: 15 });
    const syncing = queue.flush();
    await vi.waitFor(() => expect(respond).toBeDefined());
    network.setMode("offline");
    queue.setConnection(undefined);
    respond(response());
    await syncing;
    expect(client.signal.aborted).toBe(true);
    expect(await storage.json()).not.toHaveProperty("pendingSync");
    expect(memory.queueIndex).toBe(2);
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    network.setMode("online");
    const active = network.open(auth);
    queue.setConnection(active.queue);
    await queue.refresh();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([
      expect.stringContaining("getPlayQueue"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
    expect(await storage.json()).not.toHaveProperty("pendingSync");
    network.setMode("offline");
    queue.setConnection(undefined);
  });

  it("preserves dirty state if a server acknowledgement arrives after another edit", async () => {
    await storage.seed({ ...record(), pendingSync: true });
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.restore(new Storage(account));
    queue.setConnection(createConnection(auth));
    queue.update({ tracks: ["a", "b", "a"], index: 2, position: 15 });
    const pending = queue.flush();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    queue.setPosition(20);
    resolve(response());
    await pending;
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    await queue.flush();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await storage.json()).toMatchObject({ position: 20 });
  });

  it("retains the local queue after a failed pull and retries the pull explicitly", async () => {
    await storage.seed({ ...record(), pendingSync: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Offline");
      }),
    );
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    const client = createConnection(auth);
    await connectQueue(queue, client);
    expect(queue.error).toBeInstanceOf(Error);
    expect((await storage.json()).pendingSync).toBe(true);
    await queue.setConnection(undefined);
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    queue.setConnection(client);
    await queue.refresh();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await storage.json()).not.toHaveProperty("pendingSync");
  });

  it("checkpoints continuous position changes locally without continuous server saves", async () => {
    vi.useFakeTimers();
    await storage.seed();
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.restore(new Storage(account));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (let i = 1; i <= 21; i++) {
      queue.setPosition(i);
      await vi.advanceTimersByTimeAsync(250);
    }
    // Finish pending OPFS work without changing its position checkpoint.
    await vi.waitFor(() => expect(storage.writes).toBeGreaterThan(0));
    expect((await storage.json()).position).toBeGreaterThanOrEqual(20);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the last complete file after write failure and exposes a separate storage error", async () => {
    await storage.seed();
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.restore(new Storage(account));
    storage.failWrites = true;
    queue.update({ tracks: ["new"], index: 0, position: 2 });
    await queue.flush();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(await storage.json()).toEqual(record());
    expect(queueMemory.queueTracks[queueMemory.queueIndex]).toBe("new");
  });

  it.each(["index", "position", "account"])("rejects invalid persisted %s", async (field) => {
    const invalid = record();
    if (field === "index") invalid.index = 10;
    if (field === "position") invalid.position = -10;
    if (field === "account") invalid.account = { ...account, username: "other" };
    await storage.seed(invalid);
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.restore(new Storage(account));
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(queueMemory.queueTracks).toEqual([]);
    expect(queueMemory.queueIndex).toBe(-1);
  });

  it("isolates accounts and ignores late server responses from the previous account", async () => {
    const other = { ...account, username: "other" };
    await storage.seed({ ...record(), account: other, tracks: ["other"], index: 0 }, other);
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    const connected = connectQueue(queue, createConnection(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await queue.restore(new Storage(other));
    resolve(response({ playQueue: { current: "remote", entry: [{ id: "remote" }] } }));
    await connected;
    expect(queueMemory.queueTracks[queueMemory.queueIndex]).toBe("other");
    expect((await storage.json(other)).tracks).toEqual(["other"]);
  });

  it("does not invalidate local restoration when network policy changes", async () => {
    await storage.seed();
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    const restored = queue.restore(new Storage(account));
    const offline = queue.setConnection(undefined);
    await Promise.all([restored, offline]);
    expect(queueMemory.queueIndex).toBe(2);
    expect(queueMemory.queuePosition).toBe(12.5);
    queue.setPosition(20);
    await queue.flush();
    expect((await storage.json()).position).toBe(20);
  });

  it("notifies explicit listeners for queue changes but not persistence bookkeeping", async () => {
    const queueMemory = new Memory();
    const queue = engine(queueMemory);
    await queue.restore(new Storage(account));
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    queue.update({ tracks: ["a"], index: 0, position: 1 });
    queue.setPosition(2);
    expect(listener).toHaveBeenCalledTimes(2);
    await queue.flush();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    queue.setPosition(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

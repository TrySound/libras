import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueEngine } from "./queue-engine";
import { SubsonicClient } from "./subsonic-client";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
const record = () => ({
  account,
  tracks: ["a", "b", "a"],
  index: 2,
  position: 12.5,
  updatedAt: 42,
  pendingSync: false,
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
function engine() {
  const queue = new QueueEngine();
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

describe("queue engine", () => {
  it("restores IDs, duplicate occurrence index and position without a client or network", async () => {
    await storage.seed();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const queue = engine();
    await queue.restore(account);
    expect(queue.tracks).toEqual(["a", "b", "a"]);
    expect(queue.index).toBe(2);
    expect(queue.current).toBe("a");
    expect(queue.position).toBe(12.5);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists offline edits and empty queues without credentials or track descriptions", async () => {
    const queue = engine();
    await queue.setNetwork("offline");
    await queue.setClient(new SubsonicClient(auth));
    queue.update({ tracks: ["a", "b", "a"], index: 2, position: 35 });
    await queue.flush();
    const saved = await storage.json();
    expect(saved).toMatchObject({
      account,
      tracks: ["a", "b", "a"],
      index: 2,
      position: 35,
      pendingSync: true,
    });
    expect(JSON.stringify(saved)).not.toMatch(/token|salt|title|playing|https:.*rest/);
    const restored = engine();
    await restored.restore(account);
    expect(restored.index).toBe(2);
    expect(restored.position).toBe(35);
    queue.update({ tracks: [], position: 0 });
    await queue.flush();
    expect(await storage.json()).toMatchObject({
      tracks: [],
      index: -1,
      position: 0,
      pendingSync: true,
    });
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
    const queue = engine();
    await queue.restore(account);
    const connected = queue.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(queue.index).toBe(2);
    resolve(
      response({ playQueue: { current: "remote", position: 9000, entry: [{ id: "remote" }] } }),
    );
    await connected;
    expect(queue.tracks).toEqual(["remote"]);
    expect(queue.index).toBe(0);
    expect(queue.position).toBe(9);
    expect((await storage.json()).pendingSync).toBe(false);
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
    const queue = engine();
    await queue.setClient(new SubsonicClient(auth));
    expect(queue.index).toBe(2);
    expect((await storage.json()).index).toBe(2);
  });

  it("uploads unsynced local changes on reconnect instead of restoring the server queue", async () => {
    await storage.seed({ ...record(), pendingSync: true });
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const queue = engine();
    await queue.setClient(new SubsonicClient(auth));
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("savePlayQueue");
    const body = new URLSearchParams(String(options.body));
    expect(body.getAll("id")).toEqual(["a", "b", "a"]);
    expect(body.get("current")).toBe("a");
    expect(body.get("position")).toBe("12500");
    expect(queue.index).toBe(2);
    expect((await storage.json()).pendingSync).toBe(false);
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
    const queue = engine();
    const connected = queue.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    queue.update({ tracks: ["local"], index: 0, position: 2 });
    resolve(response({ playQueue: { current: "remote", entry: [{ id: "remote" }] } }));
    await connected;
    expect(queue.current).toBe("local");
    expect(queue.position).toBe(2);
  });

  it("does not overwrite edits made during initial local restoration", async () => {
    await storage.seed();
    const queue = engine();
    const restored = queue.restore(account);
    queue.update({ tracks: ["local"], index: 0, position: 3 });
    await restored;
    expect(queue.current).toBe("local");
    expect(await storage.json()).toMatchObject({ tracks: ["local"], pendingSync: true });
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
    const queue = engine();
    const connected = queue.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    queue.setPosition(20);
    resolve(response());
    await connected;
    await queue.setNetwork("offline");
    expect(await storage.json()).toMatchObject({ position: 20, pendingSync: true });
  });

  it("retains unsynced changes after a failed save and uploads them when online again", async () => {
    await storage.seed({ ...record(), pendingSync: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Offline");
      }),
    );
    const queue = engine();
    await queue.setClient(new SubsonicClient(auth));
    expect(queue.error).toBeInstanceOf(Error);
    expect((await storage.json()).pendingSync).toBe(true);
    await queue.setNetwork("offline");
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    await queue.setNetwork("online");
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await storage.json()).pendingSync).toBe(false);
  });

  it("checkpoints continuous position changes locally without continuous server saves", async () => {
    vi.useFakeTimers();
    await storage.seed();
    const queue = engine();
    await queue.restore(account);
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
    const queue = engine();
    await queue.restore(account);
    storage.failWrites = true;
    queue.update({ tracks: ["new"], index: 0, position: 2 });
    await queue.flush();
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(queue.error).toBeUndefined();
    expect(await storage.json()).toEqual(record());
    expect(queue.current).toBe("new");
  });

  it.each(["index", "position", "account"])("rejects invalid persisted %s", async (field) => {
    const invalid = record();
    if (field === "index") invalid.index = 10;
    if (field === "position") invalid.position = -10;
    if (field === "account") invalid.account = { ...account, username: "other" };
    await storage.seed(invalid);
    const queue = engine();
    await queue.restore(account);
    expect(queue.storageError).toBeInstanceOf(Error);
    expect(queue.tracks).toEqual([]);
    expect(queue.index).toBe(-1);
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
    const queue = engine();
    const connected = queue.setClient(new SubsonicClient(auth));
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await queue.restore(other);
    resolve(response({ playQueue: { current: "remote", entry: [{ id: "remote" }] } }));
    await connected;
    expect(queue.current).toBe("other");
    expect((await storage.json(other)).tracks).toEqual(["other"]);
  });

  it("does not invalidate local restoration when network policy changes", async () => {
    await storage.seed();
    const queue = engine();
    const restored = queue.restore(account);
    const offline = queue.setNetwork("offline");
    await Promise.all([restored, offline]);
    expect(queue.index).toBe(2);
    expect(queue.position).toBe(12.5);
    queue.setPosition(20);
    await queue.flush();
    expect((await storage.json()).position).toBe(20);
  });

  it("notifies explicit listeners for queue changes but not persistence bookkeeping", async () => {
    const queue = engine();
    await queue.restore(account);
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

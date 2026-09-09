import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, parseSnapshot, type MetadataSnapshot, type QueueRecord } from "./storage";
import { jsonFileName } from "./json-store";

const account = { host: "https://music.example.com", username: "listener" };
const snapshot = (): MetadataSnapshot => ({
  account,
  lastModified: 10,
  savedAt: 100,
  artists: [{ id: "artist", name: "Artist", genres: [] }],
  albums: [{ id: "album", title: "Album", artistId: "artist", genres: [] }],
  tracks: [{ id: "song", title: "Song", artistId: "artist", albumId: "album", genres: [] }],
});

function installStorage() {
  const files = new Map<string, string>();
  const state = { writes: 0, fail: false, beforeWrite: () => {} };
  const getDirectory = vi.fn(async () => ({
    async getDirectoryHandle(directory: string) {
      expect(["metadata", "queue"]).toContain(directory);
      return {
        async getFileHandle(name: string, options?: { create?: boolean }) {
          const path = `${directory}/${name}`;
          if (!files.has(path) && !options?.create)
            throw new DOMException("Missing", "NotFoundError");
          if (!files.has(path)) files.set(path, "");
          return {
            async getFile() {
              return new File([files.get(path)!], name);
            },
            async createWritable() {
              let pending = "";
              return {
                async write(value: string) {
                  state.beforeWrite();
                  if (state.fail) throw new Error("Storage full");
                  pending = value;
                },
                async close() {
                  files.set(path, pending);
                  state.writes++;
                },
                async abort() {},
              };
            },
          };
        },
        async removeEntry(name: string) {
          files.delete(`${directory}/${name}`);
        },
      };
    },
  }));
  const lock = vi.fn(async (_name: string, run: () => Promise<unknown>) => run());
  vi.stubGlobal("navigator", { storage: { getDirectory }, locks: { request: lock } });
  return { files, state, getDirectory, lock };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("queue storage", () => {
  const record = (): QueueRecord => ({
    account,
    tracks: ["a", "b", "a"],
    index: 2,
    position: 12.5,
    updatedAt: 42,
    pendingSync: true,
  });

  it("shares Storage with metadata without sharing files or changing queue format", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const queue = storage.queue(account);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await queue.read()).toBeNull();
    expect(await queue.save(record())).toEqual({ written: true, value: record() });
    await storage.metadata(account).save(snapshot());
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    expect(disk.files.size).toBe(2);
    expect(JSON.parse(disk.files.get(`queue/${name}`)!)).toEqual(record());
    expect(disk.lock).toHaveBeenCalledWith(`music-web-queue:${name}`, expect.any(Function));
    expect(await new Storage().queue(account).read()).toEqual(record());
    expect(await storage.metadata(account).read()).toEqual(snapshot());
  });

  it("serializes shared handles, reports conflicts, and permits equal-timestamp sync acknowledgements", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const first = storage.queue(account);
    const second = storage.queue({ ...account });
    const newer = { ...record(), updatedAt: 100 };
    expect(await Promise.all([first.save(newer), second.save(record())])).toEqual([
      { written: true, value: newer },
      { written: false, value: newer },
    ]);
    expect(disk.state.writes).toBe(1);
    const synced = { ...newer, pendingSync: false };
    expect(await second.save(synced)).toEqual({ written: true, value: synced });
    expect(await first.read()).toEqual(synced);
  });

  it("captures account identity and rejects foreign writes before I/O", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const identity = { ...account };
    const queue = storage.queue(identity);
    identity.username = "other";
    await expect(queue.save({ ...record(), account: identity })).rejects.toThrow(
      "different account",
    );
    expect(disk.getDirectory).not.toHaveBeenCalled();
    await queue.save(record());
    expect(await storage.queue(identity).read()).toBeNull();
    expect(await queue.read()).toEqual(record());
  });

  it("does not hide corrupt or foreign reads and retains explicit repair on write", async () => {
    const disk = installStorage();
    const queue = new Storage().queue(account);
    const path = `queue/${await jsonFileName(`${account.host}\n${account.username}`)}`;
    for (const invalid of [
      "broken JSON",
      JSON.stringify({ ...record(), account: { ...account, username: "other" } }),
    ]) {
      disk.files.set(path, invalid);
      await expect(queue.read()).rejects.toThrow();
      expect(disk.files.get(path)).toBe(invalid);
      await queue.save(record());
      expect(await queue.read()).toEqual(record());
    }
  });

  it.each([{ index: 3 }, { index: -1, position: 2 }, { position: -1 }])(
    "rejects invalid selection %j without replacing the saved queue",
    async (invalid) => {
      installStorage();
      const queue = new Storage().queue(account);
      await queue.save(record());
      await expect(queue.save({ ...record(), ...invalid })).rejects.toThrow();
      expect(await queue.read()).toEqual(record());
    },
  );

  it("preserves the complete queue on write failure and allows later writes", async () => {
    const disk = installStorage();
    const queue = new Storage().queue(account);
    await queue.save(record());
    const empty = { ...record(), tracks: [], index: -1, position: 0, updatedAt: 100 };
    disk.state.fail = true;
    await expect(queue.save(empty)).rejects.toThrow("Storage full");
    expect(await queue.read()).toEqual(record());
    disk.state.fail = false;
    expect(await queue.save(empty)).toEqual({ written: true, value: empty });
    expect(await queue.read()).toEqual(empty);
  });
});

describe("metadata storage", () => {
  it("is lazy and retains existing account paths, lock names, and snapshot format", async () => {
    const disk = installStorage();
    const store = new Storage();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await store.metadata(account).read()).toBeNull();
    expect(await store.metadata(account).save(snapshot())).toEqual(snapshot());
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    expect(JSON.parse(disk.files.get(`metadata/${name}`)!)).toEqual(snapshot());
    expect(disk.lock).toHaveBeenCalledWith(`music-web-metadata:${name}`, expect.any(Function));
    expect(await new Storage().metadata(account).read()).toEqual(snapshot());
    expect(await store.metadata({ ...account, username: "other" }).read()).toBeNull();
  });

  it("shares write ordering across metadata handles from the same Storage instance", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const first = storage.metadata(account);
    const second = storage.metadata({ ...account });
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const newer = { ...snapshot(), savedAt: 200 };
    expect(await Promise.all([first.save(newer), second.save(snapshot())])).toEqual([newer, newer]);
    expect(disk.state.writes).toBe(1);
    expect(await second.read()).toEqual(newer);
  });

  it("captures account identity and rejects writes for another account before I/O", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const identity = { ...account };
    const metadata = storage.metadata(identity);
    identity.username = "other";
    expect(metadata.account).toEqual(account);
    expect(Object.isFrozen(metadata.account)).toBe(true);
    await expect(metadata.save({ ...snapshot(), account: identity })).rejects.toThrow(
      "different account",
    );
    expect(disk.getDirectory).not.toHaveBeenCalled();
    await metadata.save(snapshot());
    expect(await storage.metadata(identity).read()).toBeNull();
    expect(await metadata.read()).toEqual(snapshot());
  });

  it.each([
    [
      { lastModified: 20, savedAt: 50 },
      { lastModified: 10, savedAt: 100 },
    ],
    [
      { lastModified: 10, savedAt: 200 },
      { lastModified: 10, savedAt: 100 },
    ],
    [
      { lastModified: null, savedAt: 200 },
      { lastModified: null, savedAt: 100 },
    ],
  ])(
    "returns the newer stored snapshot instead of acknowledging an overwrite",
    async (previous, next) => {
      const disk = installStorage();
      const store = new Storage();
      const winner = { ...snapshot(), ...previous };
      await store.metadata(account).save(winner);
      expect(await store.metadata(account).save({ ...snapshot(), ...next })).toEqual(winner);
      expect(disk.state.writes).toBe(1);
      expect(await store.metadata(account).read()).toEqual(winner);
    },
  );

  it("keeps the last complete snapshot after cancellation or write failure", async () => {
    const disk = installStorage();
    const store = new Storage();
    await store.metadata(account).save(snapshot());
    const next = { ...snapshot(), savedAt: 200 };
    let valid = true;
    disk.state.beforeWrite = () => {
      valid = false;
    };
    expect(await store.metadata(account).save(next, () => valid)).toBeUndefined();
    expect(await store.metadata(account).read()).toEqual(snapshot());
    disk.state.beforeWrite = () => {};
    disk.state.fail = true;
    await expect(store.metadata(account).save(next)).rejects.toThrow("Storage full");
    expect(await store.metadata(account).read()).toEqual(snapshot());
    expect(disk.state.writes).toBe(1);
  });

  it("preserves corrupt and foreign records on read but allows explicit repair on save", async () => {
    const disk = installStorage();
    const store = new Storage();
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    disk.files.set(`metadata/${name}`, "broken JSON");
    await expect(store.metadata(account).read()).rejects.toThrow();
    expect(disk.files.get(`metadata/${name}`)).toBe("broken JSON");
    await store.metadata(account).save(snapshot());
    const foreign = JSON.stringify({ ...snapshot(), account: { ...account, username: "other" } });
    disk.files.set(`metadata/${name}`, foreign);
    await expect(store.metadata(account).read()).rejects.toThrow("different account");
    expect(disk.files.get(`metadata/${name}`)).toBe(foreign);
    await store.metadata(account).save(snapshot());
    expect(await store.metadata(account).read()).toEqual(snapshot());
  });

  it("shares complete graph validation between prepared and persisted snapshots", async () => {
    const disk = installStorage();
    const store = new Storage();
    const invalid = { ...snapshot(), artists: [] };
    expect(() => parseSnapshot(invalid)).toThrow("Unknown artist");
    await expect(store.metadata(account).save(invalid)).rejects.toThrow("Unknown artist");
    expect(disk.files.size).toBe(0);
    const duplicate = snapshot();
    duplicate.tracks.push(duplicate.tracks[0]);
    expect(() => parseSnapshot(duplicate)).toThrow("Duplicate metadata ID");
  });
});

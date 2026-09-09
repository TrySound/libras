import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, parseSnapshot, type MetadataSnapshot } from "./storage";
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
      expect(directory).toBe("metadata");
      return {
        async getFileHandle(name: string, options?: { create?: boolean }) {
          if (!files.has(name) && !options?.create)
            throw new DOMException("Missing", "NotFoundError");
          if (!files.has(name)) files.set(name, "");
          return {
            async getFile() {
              return new File([files.get(name)!], name);
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
                  files.set(name, pending);
                  state.writes++;
                },
                async abort() {},
              };
            },
          };
        },
        async removeEntry(name: string) {
          files.delete(name);
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

describe("metadata storage", () => {
  it("is lazy and retains existing account paths, lock names, and snapshot format", async () => {
    const disk = installStorage();
    const store = new Storage();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await store.metadata(account).read()).toBeNull();
    expect(await store.metadata(account).save(snapshot())).toEqual(snapshot());
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    expect(JSON.parse(disk.files.get(name)!)).toEqual(snapshot());
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
    disk.files.set(name, "broken JSON");
    await expect(store.metadata(account).read()).rejects.toThrow();
    expect(disk.files.get(name)).toBe("broken JSON");
    await store.metadata(account).save(snapshot());
    const foreign = JSON.stringify({ ...snapshot(), account: { ...account, username: "other" } });
    disk.files.set(name, foreign);
    await expect(store.metadata(account).read()).rejects.toThrow("different account");
    expect(disk.files.get(name)).toBe(foreign);
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

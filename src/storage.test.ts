import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "./storage";
import { hashedFileName } from "./json-store";
import type { TrackFileDescriptor } from "./schema";

const account = { host: "https://music.example.com", username: "listener" };
function installStorage() {
  const files = new Map<string, string | Blob>();
  const state = {
    writes: 0,
    fail: false,
    beforeWrite: (_path: string) => {},
    afterRead: (_path: string) => {},
    afterClose: (_path: string) => {},
  };
  const getDirectory = vi.fn(async () => ({
    async getDirectoryHandle(directory: string) {
      expect(directory).toBe("tracks");
      return {
        async getFileHandle(name: string, options?: { create?: boolean }) {
          const path = `${directory}/${name}`;
          if (!files.has(path) && !options?.create)
            throw new DOMException("Missing", "NotFoundError");
          if (!files.has(path)) files.set(path, "");
          return {
            async getFile() {
              const value = files.get(path)!;
              const file = value instanceof File ? value : new File([value], name);
              state.afterRead(path);
              return file;
            },
            async createWritable() {
              let pending: string | Blob = "";
              const write = (value: string | Blob) => {
                state.beforeWrite(path);
                if (state.fail) throw new Error("Storage full");
                pending = value;
              };
              const close = () => {
                files.set(path, pending);
                state.writes++;
                state.afterClose(path);
              };
              return Object.assign(
                new WritableStream<Uint8Array>({
                  write: (chunk) => write(new Blob([pending, chunk.slice().buffer as ArrayBuffer])),
                  close,
                }),
                {
                  write: async (value: string | Blob) => write(value),
                  close: async () => close(),
                  abort: async () => {},
                },
              );
            },
          };
        },
        async removeEntry(name: string) {
          files.delete(`${directory}/${name}`);
        },
      };
    },
  }));
  const lock = vi.fn(
    async (
      _name: string,
      options: LockOptions | (() => Promise<unknown>),
      callback?: () => Promise<unknown>,
    ) => {
      if (typeof options === "function") return options();
      options.signal?.throwIfAborted();
      return callback!();
    },
  );
  vi.stubGlobal("navigator", { storage: { getDirectory }, locks: { request: lock } });
  return { files, state, getDirectory, lock };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("configured storage", () => {
  it("binds domain utilities to one immutable account without performing I/O", async () => {
    const disk = installStorage();
    const storage = new Storage(account);

    expect(storage.account).toEqual(account);
    expect(Object.isFrozen(storage.account)).toBe(true);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await storage.audio.entries()).toEqual([]);
  });

  it("copies its typed account before freezing it", () => {
    const input = { ...account };
    const storage = new Storage(input);
    input.username = "other";
    expect(storage.account).toEqual(account);
  });
});

it.each([0, 1])(
  "preserves a replacement audio record during stale repair (timestamp delta: %s)",
  async (delta) => {
    const disk = installStorage();
    const audio = new Storage(account).audio;
    const descriptor: TrackFileDescriptor = {
      ...account,
      key: `${account.host}\n${account.username}\ntrack\nmp3-v1`,
      format: "mp3",
      contentType: "audio/mpeg",
    };
    const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
    await audio.save(descriptor, track, new Response("old audio"), new AbortController().signal);
    const [old] = await audio.entries();
    const newer = { ...old, downloadedAt: old.downloadedAt + delta, size: 12 };
    const path = `tracks/${old.fileName}`;
    disk.files.set(path, "x");
    disk.state.afterRead = (readPath) => {
      if (readPath === path) {
        disk.state.afterRead = () => {};
        disk.files.set(path, "new complete");
        disk.files.set("tracks/downloads.json", JSON.stringify([newer]));
      }
    };
    await audio.read(descriptor, track);
    expect(await audio.entries()).toEqual([newer]);
  },
);

describe("audio storage", () => {
  const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
  const descriptor = (identity = account): TrackFileDescriptor => ({
    ...identity,
    key: `${identity.host}\n${identity.username}\ntrack\nmp3-v1`,
    format: "mp3",
    contentType: "audio/mpeg",
  });

  it("reads old download records while discarding unused artwork metadata", async () => {
    const disk = installStorage();
    const audio = new Storage(account).audio;
    await audio.save(descriptor(), track, new Response("audio"), new AbortController().signal);
    const records = await audio.entries();
    disk.files.set(
      "tracks/downloads.json",
      JSON.stringify(
        records.map((record) => ({
          ...record,
          track: { ...record.track, coverArt: "legacy-cover" },
        })),
      ),
    );
    const restored = await new Storage(account).audio.list();
    expect(restored).toEqual(records);
    expect(restored[0].track).not.toHaveProperty("coverArt");
  });

  it("refreshes a configured instance after another workspace updates the shared catalog", async () => {
    installStorage();
    const first = new Storage(account).audio;
    const second = new Storage({ ...account, username: "other" }).audio;
    const saved = descriptor({ ...account, username: "other" });

    expect(await first.list()).toEqual([]);
    await second.save(saved, track, new Response("audio"), new AbortController().signal);
    expect(await first.list()).toEqual([expect.objectContaining({ key: saved.key })]);
  });

  it("shares a lazy cross-account catalog and streams files through the existing locks", async () => {
    const disk = installStorage();
    const storage = new Storage(account);
    const first = storage.audio;
    const second = storage.audio;
    expect(first).toBe(second);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await first.entries()).toEqual([]);
    const signal = new AbortController().signal;
    const own = descriptor();
    const otherAccount = { ...account, username: "other" };
    const other = descriptor(otherAccount);
    const otherAudio = new Storage(otherAccount).audio;
    const response = new Response("first audio");
    expect(await (await second.save(own, track, response, signal)).text()).toBe("first audio");
    expect(response.bodyUsed).toBe(true);
    await otherAudio.save(other, track, new Response("other audio"), signal);
    expect((await second.list()).map((record) => record.key).sort()).toEqual(
      [own.key, other.key].sort(),
    );
    expect(await (await first.read(own, track))!.text()).toBe("first audio");
    expect(await (await otherAudio.read(other, track))!.text()).toBe("other audio");
    await expect(first.read(other, track)).rejects.toThrow("different account");
    await expect(first.save(other, track, new Response("foreign audio"), signal)).rejects.toThrow(
      "different account",
    );
    expect(await new Storage(account).audio.list()).toHaveLength(2);
    const name = await hashedFileName(own.key, ".audio");
    expect(disk.files.has(`tracks/${name}`)).toBe(true);
    expect(disk.files.has("tracks/downloads.json")).toBe(true);
    expect(disk.lock).toHaveBeenCalledWith(
      `music-web-audio:${name}`,
      { signal },
      expect.any(Function),
    );
    expect(disk.lock).toHaveBeenCalledWith("music-web-downloads-index", expect.any(Function));
  });

  it("adopts legacy audio without renaming files or changing their recorded modification dates", async () => {
    const disk = installStorage();
    const entry = descriptor();
    const name = await hashedFileName(entry.key, ".audio");
    disk.files.set(`tracks/${name}`, new File(["legacy"], name, { lastModified: 123 }));
    const audio = new Storage(account).audio;
    expect(await (await audio.read(entry, track))!.text()).toBe("legacy");
    expect(await audio.entries()).toEqual([
      expect.objectContaining({ key: entry.key, fileName: name, downloadedAt: 123, size: 6 }),
    ]);
    expect([...disk.files.keys()].sort()).toEqual(
      [`tracks/${name}`, "tracks/downloads.json"].sort(),
    );
  });
});

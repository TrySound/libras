import { vi } from "vitest";
import { clearTestTimers } from "./cache-test-helpers";
import type { LibrarySnapshot } from "../src/cache.svelte";
import type { Account } from "../src/schema";

export const account = { host: "https://music.example.com", username: "listener" };
export function snapshot(): LibrarySnapshot {
  return {
    lastModified: 10,
    savedAt: 100,
    artists: [{ id: "artist", name: "Artist", genres: [] }],
    albums: [{ id: "album", title: "Album", artistId: "artist", genres: [] }],
    tracks: [{ id: "song", title: "Song", albumId: "album", artistId: "artist", genres: [] }],
  };
}
export async function snapshotPath(identity: Account) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([identity.host, identity.username])),
  );
  return `accounts/${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}/library.json`;
}
export function installMetadataStorage() {
  clearTestTimers();
  const storage = {
    files: new Map<string, File>(),
    failWrites: false,
    beforeWrite: undefined as (() => void) | undefined,
    writes: 0,
    async seed(identity: Account, data: unknown) {
      const path = await snapshotPath(identity);
      storage.files.set(path, new File([JSON.stringify(data)], path));
    },
  };
  function directoryHandle(directory: string): unknown {
    return {
      async getDirectoryHandle(name: string) {
        return directoryHandle(directory ? `${directory}/${name}` : name);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = `${directory}/${name}`;
        if (!storage.files.has(path) && !options?.create)
          throw new DOMException("Missing", "NotFoundError");
        if (!storage.files.has(path)) storage.files.set(path, new File([], path));
        return {
          async getFile() {
            return storage.files.get(path)!;
          },
          async createWritable() {
            let data = "";
            return {
              async write(value: string) {
                storage.beforeWrite?.();
                if (storage.failWrites) throw new Error("Storage full");
                data = value;
              },
              async close() {
                storage.writes++;
                storage.files.set(path, new File([data], path));
              },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name: string) {
        storage.files.delete(`${directory}/${name}`);
      },
    };
  }
  const getDirectory = vi.fn(async () => directoryHandle(""));
  vi.stubGlobal("navigator", { storage: { getDirectory } });
  return Object.assign(storage, { getDirectory });
}

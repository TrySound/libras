import { expect, vi } from "vitest";

export function installDisk() {
  const files = new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const state = {
    failClose: false,
    beforeRead: async (_path: string) => {},
    beforeWrite: (_path: string) => {},
    beforeClose: async (_path: string) => {},
    afterClose: (_path: string) => {},
    writes: 0,
  };
  function directory(path: string): unknown {
    return {
      async getDirectoryHandle(name: string) {
        // OPFS does not accept a slash-delimited path as a directory name.
        expect(name).not.toContain("/");
        return directory(path ? `${path}/${name}` : name);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const key = `${path}/${name}`;
        if (!files.has(key) && !blobs.has(key) && !options?.create)
          throw new DOMException("Missing", "NotFoundError");
        if (!files.has(key) && !blobs.has(key)) files.set(key, "");
        return {
          async getFile() {
            const file = new File([files.get(key) ?? blobs.get(key)!], name);
            await state.beforeRead(key);
            return file;
          },
          async createWritable() {
            let pending: string | Blob = "";
            return {
              async write(value: string | Blob) {
                state.beforeWrite(key);
                pending = value;
              },
              async close() {
                await state.beforeClose(key);
                if (state.failClose) throw new Error("Storage full");
                if (typeof pending === "string") files.set(key, pending);
                else {
                  blobs.set(key, pending);
                  files.delete(key);
                }
                state.writes++;
                state.afterClose(key);
              },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name: string) {
        files.delete(`${path}/${name}`);
        blobs.delete(`${path}/${name}`);
      },
    };
  }
  const getDirectory = vi.fn(async () => directory(""));
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, action: () => Promise<unknown>) => {
    const result = (tails.get(name) ?? Promise.resolve()).then(action);
    tails.set(
      name,
      result.catch(() => {}),
    );
    return result;
  });
  vi.stubGlobal("navigator", { storage: { getDirectory }, locks: { request } });
  return { files, blobs, state, getDirectory };
}

import { expect, vi } from "vitest";

export function installDisk() {
  const files = new Map<string, string>();
  const state = {
    failClose: false,
    beforeRead: async (_path: string) => {},
    beforeWrite: (_path: string) => {},
    beforeClose: async (_path: string) => {},
    afterClose: () => {},
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
        if (!files.has(key) && !options?.create) throw new DOMException("Missing", "NotFoundError");
        if (!files.has(key)) files.set(key, "");
        return {
          async getFile() {
            const file = new File([files.get(key)!], name);
            await state.beforeRead(key);
            return file;
          },
          async createWritable() {
            let pending = "";
            return {
              async write(value: string) {
                state.beforeWrite(key);
                pending = value;
              },
              async close() {
                await state.beforeClose(key);
                if (state.failClose) throw new Error("Storage full");
                files.set(key, pending);
                state.writes++;
                state.afterClose();
              },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name: string) {
        files.delete(`${path}/${name}`);
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
  return { files, state, getDirectory };
}

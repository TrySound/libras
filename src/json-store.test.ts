import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { OpfsJsonStore, jsonFileName } from "./json-store";

function setup(locks = false) {
  const files = new Map<string, string>();
  const state = {
    files,
    failClose: false,
    readError: undefined as Error | undefined,
    beforeWrite: undefined as (() => void) | undefined,
    writes: 0,
    abort: vi.fn(async () => {}),
  };
  const tails = new Map<string, Promise<unknown>>();
  const request = vi.fn((name: string, action: () => Promise<unknown>) => {
    const result = (tails.get(name) ?? Promise.resolve()).then(action);
    tails.set(
      name,
      result.catch(() => {}),
    );
    return result;
  });
  vi.stubGlobal("navigator", {
    ...(locks ? { locks: { request } } : {}),
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle(directory: string) {
            return {
              async getFileHandle(name: string, options?: { create?: boolean }) {
                const path = `${directory}/${name}`;
                if (!files.has(path) && !options?.create)
                  throw new DOMException("Missing", "NotFoundError");
                if (!files.has(path)) files.set(path, "");
                return {
                  async getFile() {
                    if (state.readError) throw state.readError;
                    return new File([files.get(path)!], name);
                  },
                  async createWritable() {
                    let pending = "";
                    return {
                      async write(value: string) {
                        state.beforeWrite?.();
                        pending = value;
                      },
                      async close() {
                        if (state.failClose) throw new Error("Close failed");
                        state.writes++;
                        files.set(path, pending);
                      },
                      abort: state.abort,
                    };
                  },
                };
              },
              async removeEntry(name: string) {
                files.delete(`${directory}/${name}`);
              },
            };
          },
        };
      },
    },
  });
  const store = () =>
    new OpfsJsonStore({
      directory: "test",
      fileName: "state.json",
      lockName: "existing-lock",
      parse: (value: unknown) => v.parse(v.object({ count: v.number() }), value),
    });
  return { files, state, store, request };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OPFS JSON store", () => {
  it("returns null for missing files and validates stored and outgoing data", async () => {
    const { store, files } = setup();
    const file = store();
    expect(await file.read()).toBeNull();
    expect(await file.update(() => ({ count: 1 }))).toEqual({ written: true, value: { count: 1 } });
    expect(await file.read()).toEqual({ count: 1 });
    await expect(file.update(() => ({ count: "invalid" as unknown as number }))).rejects.toThrow();
    expect(JSON.parse(files.get("test/state.json")!)).toEqual({ count: 1 });
  });

  it.each(["not-json", '{"count":"invalid"}'])(
    "preserves corrupt data by default: %s",
    async (contents) => {
      const { store, files } = setup();
      files.set("test/state.json", contents);
      const file = store();
      await expect(file.read()).rejects.toThrow();
      await expect(file.update(() => ({ count: 1 }))).rejects.toThrow();
      expect(files.get("test/state.json")).toBe(contents);
      expect(await file.update(() => ({ count: 2 }), { recoverReadError: () => null })).toEqual({
        written: true,
        value: { count: 2 },
      });
    },
  );

  it("awaits asynchronous validation before committing", async () => {
    const { files } = setup();
    const file = new OpfsJsonStore({
      directory: "test",
      fileName: "state.json",
      lockName: "existing-lock",
      parse: async (value) => v.parse(v.object({ count: v.number() }), value),
    });
    await file.update(() => ({ count: 1 }));
    expect(await file.read()).toEqual({ count: 1 });
    await expect(file.update(() => ({ count: "invalid" as unknown as number }))).rejects.toThrow();
    expect(files.get("test/state.json")).toBe('{"count":1}');
  });

  it("propagates read failures without treating an inaccessible file as empty", async () => {
    const { store, state, files } = setup();
    files.set("test/state.json", '{"count":1}');
    state.readError = new DOMException("Denied", "NotAllowedError");
    const file = store();
    const change = vi.fn(() => ({ count: 2 }));
    await expect(file.read()).rejects.toThrow("Denied");
    await expect(file.update(change)).rejects.toThrow("Denied");
    expect(change).not.toHaveBeenCalled();
    expect(files.get("test/state.json")).toBe('{"count":1}');
    state.readError = undefined;
    expect(await file.read()).toEqual({ count: 1 });
  });

  it("preserves the original write error even when abort fails", async () => {
    const { store, state, files } = setup();
    state.beforeWrite = () => {
      throw new Error("Write failed");
    };
    state.abort.mockRejectedValue(new Error("Abort failed"));
    await expect(store().update(() => ({ count: 1 }))).rejects.toThrow("Write failed");
    expect(files.size).toBe(0);
  });

  it("reports skipped writes and keeps the latest observed value", async () => {
    const { store, state } = setup();
    const file = store();
    await file.update(() => ({ count: 2 }));
    expect(await file.update(() => undefined)).toEqual({ written: false, value: { count: 2 } });
    expect(state.writes).toBe(1);
  });

  it.each([false, true])("serializes reads and updates (locks: %s)", async (locks) => {
    const { store, request } = setup(locks);
    const file = store();
    await Promise.all(
      Array.from({ length: 5 }, () => file.update((old) => ({ count: (old?.count ?? 0) + 1 }))),
    );
    const update = file.update((old) => ({ count: old!.count + 1 }));
    expect(await file.read()).toEqual({ count: 6 });
    await update;
    if (locks) expect(request).toHaveBeenCalledWith("existing-lock", expect.any(Function));
  });

  it("rereads under a shared lock across store instances", async () => {
    const { store } = setup(true);
    const first = store();
    const second = store();
    await Promise.all(
      [first, second, first, second].map((file) =>
        file.update((old) => ({ count: (old?.count ?? 0) + 1 })),
      ),
    );
    expect(await first.read()).toEqual({ count: 4 });
  });

  it.each([false, true])(
    "aborts failed closes, preserves committed data, and permits retry (existing: %s)",
    async (existing) => {
      const { store, state, files } = setup();
      const file = store();
      if (existing) await file.update(() => ({ count: 1 }));
      state.failClose = true;
      await expect(file.update(() => ({ count: 2 }))).rejects.toThrow("Close failed");
      expect(state.abort).toHaveBeenCalledOnce();
      expect(files.get("test/state.json")).toBe(existing ? '{"count":1}' : undefined);
      state.failClose = false;
      await file.update(() => ({ count: 3 }));
      expect(await file.read()).toEqual({ count: 3 });
    },
  );

  it.each([false, true])("aborts stale writes before close (existing: %s)", async (existing) => {
    const { store, state, files } = setup();
    const file = store();
    if (existing) await file.update(() => ({ count: 1 }));
    let valid = true;
    state.beforeWrite = () => {
      valid = false;
    };
    expect(await file.update(() => ({ count: 2 }), { valid: () => valid })).toEqual({
      written: false,
      value: existing ? { count: 1 } : null,
    });
    expect(state.abort).toHaveBeenCalledOnce();
    expect(files.get("test/state.json")).toBe(existing ? '{"count":1}' : undefined);
  });

  it("does not create a file for already-stale work", async () => {
    const { store, files } = setup();
    expect(await store().update(() => ({ count: 1 }), { valid: () => false })).toEqual({
      written: false,
      value: null,
    });
    expect(files.size).toBe(0);
  });

  it("keeps the existing SHA-256 account filename format", async () => {
    expect(await jsonFileName("account")).toBe(
      "9af211329b2fc82e5efe906062c730082819b23fe8394bc435e0b1bf0458eb54.json",
    );
  });
});

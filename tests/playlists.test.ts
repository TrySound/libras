import { describe, expect, it, vi } from "vitest";
import { Cache, type CachedPlaylists } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { Playlists, PlaylistConflictError } from "../src/playlists.svelte";
import type { PlaylistConnection } from "../src/network.svelte";

function setup() {
  const account = { host: "https://host", username: "user" };
  const cache = new Cache(getAccountKey(account));
  let state: CachedPlaylists = { listedAt: null, summaries: [], details: [] };
  vi.spyOn(cache, "playlists", "get").mockImplementation(() => state);
  vi.spyOn(cache, "setPlaylists").mockImplementation((value) => {
    state = value as CachedPlaylists;
  });
  const selection: { cache: Cache | undefined } = { cache };
  const controller = new AbortController();
  let ids = ["a", "a", "b"];
  const summary = { id: "p", name: "Mix" };
  const read = vi.fn(async () => ({ summary, entries: ids.map((id) => ({ id, title: id })) }));
  const connection = {
    account,
    signal: controller.signal,
    list: vi.fn(async () => [summary]),
    read,
    create: vi.fn(async () => summary),
    rename: vi.fn(async () => {}),
    append: vi.fn(async (_id: string, added: readonly string[]) => {
      ids = [...ids, ...added];
    }),
    remove: vi.fn(async (_id: string, indexes: readonly number[]) => {
      ids = ids.filter((_, index) => !indexes.includes(index));
    }),
    replace: vi.fn(async (_id: string, replacement: readonly string[]) => {
      ids = [...replacement];
    }),
    delete: vi.fn(async () => {}),
  } satisfies PlaylistConnection;
  const engine = new Playlists(selection);
  engine.setConnection(connection);
  return {
    engine,
    selection,
    cache,
    controller,
    connection,
    get ids() {
      return ids;
    },
    set ids(value: string[]) {
      ids = value;
    },
  };
}

describe("server-backed playlists", () => {
  it("keeps duplicate occurrences and removes only the chosen index", async () => {
    const scope = setup();
    await scope.engine.refresh();
    expect(scope.cache.playlists.details).toEqual([]);
    await scope.engine.open("p");
    expect(scope.cache.playlists.details[0].entries.map((entry) => entry.id)).toEqual([
      "a",
      "a",
      "b",
    ]);
    await scope.engine.edit("p", ["a", "a", "b"], { kind: "remove", indexes: [1] });
    expect(scope.ids).toEqual(["a", "b"]);
    expect(scope.cache.playlists.details[0].entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    scope.engine.destroy();
  });

  it("blocks destructive stale edits unless replacement explicitly overwrites", async () => {
    const scope = setup();
    scope.ids = ["b", "a", "a"];
    await expect(
      scope.engine.edit("p", ["a", "a", "b"], { kind: "replace", ids: ["a"] }),
    ).rejects.toBeInstanceOf(PlaylistConflictError);
    expect(scope.connection.replace).not.toHaveBeenCalled();
    await scope.engine.edit("p", ["a", "a", "b"], { kind: "replace", ids: ["a"], overwrite: true });
    expect(scope.ids).toEqual(["a"]);
    scope.engine.destroy();
  });

  it("ignores late responses after a cache switch", async () => {
    const scope = setup();
    let resolve!: (value: {
      summary: { id: string; name: string };
      entries: { id: string; title: string }[];
    }) => void;
    scope.connection.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const opening = scope.engine.open("p");
    scope.selection.cache = new Cache("other-account");
    scope.engine.setConnection(undefined);
    resolve({ summary: { id: "p", name: "Mix" }, entries: [] });
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(scope.cache.playlists.details).toEqual([]);
    scope.engine.destroy();
  });

  it("never retries an uncertain append", async () => {
    const scope = setup();
    scope.connection.append.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      scope.engine.edit("p", ["a", "a", "b"], { kind: "append", ids: ["a"] }),
    ).rejects.toThrow("timeout");
    expect(scope.connection.append).toHaveBeenCalledOnce();
    expect(scope.cache.playlists.details).toEqual([]);
    scope.engine.destroy();
  });
});

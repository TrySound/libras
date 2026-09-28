import { describe, expect, it, vi } from "vitest";
import { Cache, type CachedPlaylists } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { Playlists, PlaylistConflictError } from "../src/playlists.svelte";
import type { PlaylistAction, PlaylistConnection } from "../src/network.svelte";

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
    mutate: vi.fn(async (action: PlaylistAction) => {
      switch (action.kind) {
        case "create":
          return summary;
        case "append":
          ids = [...ids, ...action.ids];
          break;
        case "remove":
          ids = ids.filter((_, index) => !action.indexes.includes(index));
          break;
        case "replace":
          ids = [...action.ids];
          break;
      }
      return undefined;
    }),
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
  it("creates and deletes through the shared action API", async () => {
    const scope = setup();
    const created = await scope.engine.create("Mix");
    expect(created).toEqual({ id: "p", name: "Mix" });
    expect(scope.connection.mutate).toHaveBeenCalledWith({ kind: "create", name: "Mix" });
    await scope.engine.apply({ kind: "delete", id: "p", expected: ["a", "a", "b"] });
    expect(scope.connection.mutate).toHaveBeenLastCalledWith({
      kind: "delete",
      id: "p",
      expected: ["a", "a", "b"],
    });
    expect(scope.cache.playlists.summaries).toEqual([]);
    scope.engine.destroy();
  });

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
    await scope.engine.apply({ kind: "remove", id: "p", expected: ["a", "a", "b"], indexes: [1] });
    expect(scope.ids).toEqual(["a", "b"]);
    expect(scope.cache.playlists.details[0].entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    scope.engine.destroy();
  });

  it("blocks destructive stale edits unless replacement explicitly overwrites", async () => {
    const scope = setup();
    scope.ids = ["b", "a", "a"];
    await expect(
      scope.engine.apply({ kind: "replace", id: "p", expected: ["a", "a", "b"], ids: ["a"] }),
    ).rejects.toBeInstanceOf(PlaylistConflictError);
    expect(scope.connection.mutate).not.toHaveBeenCalled();
    await scope.engine.apply({
      kind: "replace",
      id: "p",
      expected: ["a", "a", "b"],
      ids: ["a"],
      overwrite: true,
    });
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
    scope.connection.mutate.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      scope.engine.apply({ kind: "append", id: "p", expected: ["a", "a", "b"], ids: ["a"] }),
    ).rejects.toThrow("timeout");
    expect(scope.connection.mutate).toHaveBeenCalledOnce();
    expect(scope.cache.playlists.details).toEqual([]);
    scope.engine.destroy();
  });
});

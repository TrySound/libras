import { vi } from "vitest";
import { AuthStore } from "../src/auth";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { Network, type MetadataConnection } from "../src/network.svelte";
import type { MetadataSnapshot } from "../src/metadata.svelte";
import { Cache } from "../src/cache.svelte";
import type { Account } from "../src/schema";
import { Session } from "../src/session.svelte";

export const credentials = {
  host: "https://music.example",
  username: "listener",
  token: "token",
  salt: "salt",
};

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function snapshot(account: Account): MetadataSnapshot {
  return {
    account: { host: account.host, username: account.username },
    savedAt: 100,
    lastModified: 10,
    artists: [{ id: "artist", name: account.username, genres: [] }],
    albums: [],
    tracks: [],
  };
}

export function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

export function createSession(saved = false, storage = createStorage()) {
  const selection = new TestSelection();
  const auth = new AuthStore(storage);
  if (saved) auth.save(credentials);
  const loadCache = vi
    .spyOn(Cache.prototype, "load")
    .mockReset()
    .mockImplementation(async function (this: Cache, signal) {
      signal?.throwIfAborted();
      vi.spyOn(this, "artists", "get").mockReturnValue(
        new Map(snapshot(this.account!).artists.map((artist) => [artist.id, artist])),
      );
      vi.spyOn(this, "savedAt", "get").mockReturnValue(100);
      vi.spyOn(this, "queue", "get").mockReturnValue({
        tracks: [this.account!.username],
        index: 0,
        position: 17,
      });
    });
  const saveLibrary = vi
    .spyOn(Cache.prototype, "replaceLibrary")
    .mockReset()
    .mockImplementation(async function (this: Cache, value, signal) {
      signal?.throwIfAborted();
      vi.spyOn(this, "artists", "get").mockReturnValue(
        new Map(value.artists.map((artist) => [artist.id, artist])),
      );
      vi.spyOn(this, "savedAt", "get").mockReturnValue(value.savedAt);
    });
  const metadata = {
    prepareConnection: vi.fn(async (connection: MetadataConnection) =>
      snapshot(connection.account),
    ),
    getModifiedAt: vi.fn(async () => 100),
    readLibrary: vi.fn(async () => ({ artists: [], albums: [], tracks: [] })),
    setConnection: vi.fn(),
    refresh: vi.fn(async (force = true) => {
      await metadata.getModifiedAt();
      if (force) await metadata.readLibrary();
    }),
  };
  const covers = {
    activate: vi.fn(),
    refresh: vi.fn(async () => {}),
    setConnection: vi.fn(),
  };
  const queue = {
    error: undefined,
    get storageError() {
      return selection.cache?.queueError;
    },
    setConnection: vi.fn(),
    activate: vi.fn(),
    refresh: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const tracks = { activate: vi.fn(), setConnection: vi.fn() };
  const playback = { suspend: vi.fn(), suspendNetwork: vi.fn() };
  const network = new Network();
  const accept = network.accept.bind(network);
  vi.spyOn(network, "accept").mockImplementation((candidate) => {
    const active = accept(candidate);
    return {
      ...active,
      metadata: {
        account: active.account,
        signal: active.signal,
        getModifiedAt: metadata.getModifiedAt,
        readLibrary: metadata.readLibrary,
      },
    };
  });
  const prepareConnection = metadata.prepareConnection;
  const session = new Session({
    selection,
    network,
    auth,
    metadata,
    covers,
    queue,
    tracks,
    playback,
    preferences: storage,
  });
  return {
    session,
    network,
    selection,
    auth,
    metadata,
    covers,
    queue,
    tracks,
    playback,
    storage,
    prepareConnection,
    loadCache,
    saveLibrary,
  };
}

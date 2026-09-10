import { vi } from "vitest";
import { AuthStore } from "./auth";
import { Memory } from "./memory.svelte";
import { Network, type MetadataConnection } from "./network.svelte";
import { Storage, type MetadataSnapshot } from "./storage";
import type { Account } from "./schema";
import { Session } from "./session.svelte";

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
  const memory = new Memory();
  const auth = new AuthStore(storage);
  if (saved) auth.save(credentials);
  const metadata = {
    savedAt: undefined as number | undefined,
    restore: vi.fn(async (storage: Pick<Storage, "account">) => {
      const account = storage.account;
      memory.artists = new Map(snapshot(account).artists.map((artist) => [artist.id, artist]));
      metadata.savedAt = 100;
    }),
    prepareConnection: vi.fn(async (connection: MetadataConnection) =>
      snapshot(connection.account),
    ),
    saveConnection: vi.fn(
      async (value: MetadataSnapshot, _storage: Storage, _signal: AbortSignal) => value,
    ),
    acceptConnection: vi.fn((value: MetadataSnapshot, _storage: Storage) => {
      memory.artists = new Map(value.artists.map((artist) => [artist.id, artist]));
      metadata.savedAt = value.savedAt;
    }),
    getModifiedAt: vi.fn(async () => 100),
    readLibrary: vi.fn(async () => ({ artists: [], albums: [], tracks: [] })),
    setConnection: vi.fn(),
    refresh: vi.fn(async (force = true) => {
      await metadata.getModifiedAt();
      if (force) await metadata.readLibrary();
    }),
  };
  const covers = {
    restore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    setConnection: vi.fn(),
  };
  const queue = {
    error: undefined,
    storageError: undefined as unknown,
    setConnection: vi.fn(),
    restore: vi.fn(async (storage: Pick<Storage, "account">) => {
      const account = storage.account;
      memory.queueTracks = [account.username];
      memory.queueIndex = 0;
      memory.queuePosition = 17;
    }),
    refresh: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const tracks = { restore: vi.fn(async () => {}), setConnection: vi.fn() };
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
    memory,
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
    memory,
    auth,
    metadata,
    covers,
    queue,
    tracks,
    playback,
    storage,
    prepareConnection,
  };
}

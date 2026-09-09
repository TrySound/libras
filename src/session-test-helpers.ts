import { vi } from "vitest";
import { AuthStore } from "./auth";
import { Memory } from "./memory.svelte";
import type { MetadataSnapshot, MetadataStatus } from "./metadata-engine";
import type { MetadataAccount } from "./schema";
import type { SubsonicClient } from "./subsonic-client";
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

export function snapshot(account: MetadataAccount): MetadataSnapshot {
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
    status: "idle" as MetadataStatus,
    error: undefined as unknown,
    warning: undefined as unknown,
    restore: vi.fn(async (account: MetadataAccount) => {
      memory.account = { ...account };
      memory.artists = new Map(snapshot(account).artists.map((artist) => [artist.id, artist]));
      metadata.savedAt = 100;
      metadata.status = "ready";
    }),
    prepareConnection: vi.fn(async (client: SubsonicClient) => snapshot(client)),
    saveConnection: vi.fn(async (value: MetadataSnapshot, _signal: AbortSignal) => value),
    acceptConnection: vi.fn((value: MetadataSnapshot) => {
      memory.account = value.account;
      memory.artists = new Map(value.artists.map((artist) => [artist.id, artist]));
      metadata.savedAt = value.savedAt;
      metadata.status = "ready";
    }),
    revalidate: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    setClient: vi.fn(),
    setNetwork: vi.fn(),
  };
  const covers = {
    restore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    setClient: vi.fn(),
  };
  const queue = {
    restore: vi.fn(async (account: MetadataAccount) => {
      memory.queueTracks = [account.username];
      memory.queueIndex = 0;
      memory.queuePosition = 17;
    }),
    setClient: vi.fn(),
    setNetwork: vi.fn(),
    synchronize: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const tracks = { setClient: vi.fn() };
  const playback = { suspend: vi.fn(), suspendNetwork: vi.fn() };
  const session = new Session({ memory, auth, metadata, covers, queue, tracks, playback, storage });
  return { session, memory, auth, metadata, covers, queue, tracks, playback, storage };
}

import { vi } from "vitest";
import { AuthStore, getAccountKey } from "../src/auth";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { Network, type MetadataConnection } from "../src/network.svelte";
import { CoverEngine } from "../src/cover.svelte";
import { TrackEngine } from "../src/track.svelte";
import { Playback } from "../src/playback.svelte";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
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

export function snapshot(account: Account): LibrarySnapshot {
  return {
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
  const loaded = new WeakSet<Cache>();
  const loadCache = vi
    .spyOn(Cache.prototype, "load")
    .mockReset()
    .mockImplementation(async function (this: Cache, signal) {
      signal?.throwIfAborted();
      if (loaded.has(this)) return;
      loaded.add(this);
      const account = [
        auth.loadAccount() ?? credentials,
        ...prepare.mock.calls.map(([credentials]) => credentials),
      ].find((account) => getAccountKey(account) === this.key)!;
      vi.spyOn(this, "artists", "get").mockReturnValue(
        new Map(snapshot(account).artists.map((artist) => [artist.id, artist])),
      );
      vi.spyOn(this, "savedAt", "get").mockReturnValue(100);
      vi.spyOn(this, "lastModified", "get").mockReturnValue(100);
      vi.spyOn(this, "queue", "get").mockReturnValue({
        tracks: [account.username],
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
  const coverEngine = new CoverEngine(selection);
  const trackEngine = new TrackEngine({ selection });
  const player = new Playback({
    selection,
    tracks: trackEngine,
    covers: coverEngine,
  });
  const metadata = {
    getModifiedAt: vi.fn<MetadataConnection["getModifiedAt"]>(async () => 100),
    readLibrary: vi.fn<MetadataConnection["readLibrary"]>(async () => ({
      artists: [],
      albums: [],
      tracks: [],
    })),
  };
  const covers = {
    activate: vi.spyOn(coverEngine, "activate").mockImplementation(() => {}),
    refresh: vi.spyOn(coverEngine, "refresh").mockResolvedValue(undefined),
    setConnection: vi.spyOn(coverEngine, "setConnection").mockImplementation(() => {}),
  };
  const tracks = {
    activate: vi.spyOn(trackEngine, "activate").mockImplementation(() => {}),
    setConnection: vi.spyOn(trackEngine, "setConnection").mockImplementation(() => {}),
  };
  const playback = {
    setConnection: vi.spyOn(player, "setConnection").mockImplementation(() => {}),
    activate: vi.spyOn(player, "activate").mockImplementation(() => {}),
    refreshQueue: vi.spyOn(player, "refreshQueue").mockResolvedValue(undefined),
    flushQueue: vi.spyOn(player, "flushQueue").mockResolvedValue(undefined),
    suspend: vi.spyOn(player, "suspend").mockImplementation(() => {}),
    suspendNetwork: vi.spyOn(player, "suspendNetwork").mockImplementation(() => {}),
  };
  const network = new Network();
  const prepare = vi.spyOn(network, "prepare");
  const validate = vi.spyOn(network, "validate").mockResolvedValue(undefined);
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
  const session = new Session({
    selection,
    network,
    auth,
    covers: coverEngine,
    tracks: trackEngine,
    playback: player,
    preferences: storage,
  });
  return {
    async destroy() {
      session.destroy();
      await player.destroy();
      covers.activate.mockRestore();
      coverEngine.destroy();
      trackEngine.destroy();
    },
    session,
    network,
    selection,
    auth,
    metadata,
    covers,
    tracks,
    playback,
    storage,
    validate,
    loadCache,
    saveLibrary,
  };
}

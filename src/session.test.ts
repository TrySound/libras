import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetadataStatus } from "./metadata-engine";
import { Memory } from "./memory.svelte";
import { Session } from "./session.svelte";
import type { SubsonicAuth } from "./subsonic-client";

const credentials = {
  host: "https://music.example",
  username: "listener",
  token: "token",
  salt: "salt",
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const sessions: Session[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
});

function setup() {
  const memory = new Memory();
  const auth = {
    load: vi.fn<() => SubsonicAuth | null>(() => credentials),
    create: vi.fn(() => credentials),
    save: vi.fn(),
    clear: vi.fn(),
  };
  const metadata = {
    status: "ready" as MetadataStatus,
    savedAt: 100 as number | undefined,
    error: undefined as unknown,
    warning: undefined as unknown,
    restore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    setNetwork: vi.fn(),
    setClient: vi.fn(),
  };
  const covers = {
    restore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    setClient: vi.fn(),
  };
  const queue = {
    restore: vi.fn(async () => {}),
    setNetwork: vi.fn(),
    setClient: vi.fn(),
    synchronize: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const tracks = {
    ready: vi.fn(async () => {}),
    getStatus: vi.fn(() => "idle" as const),
    setClient: vi.fn(),
  };
  const playback = { pause: vi.fn() };
  const storage = { getItem: vi.fn(() => "false"), setItem: vi.fn() };
  const session = new Session({ memory, auth, metadata, covers, queue, tracks, playback, storage });
  sessions.push(session);
  return { session, memory, auth, metadata, covers, queue, tracks, playback, storage };
}

const input = { host: credentials.host, username: credentials.username, password: "password" };

describe("session", () => {
  it.each([false, true])(
    "requires connection when saved authentication is absent or invalid (invalid: %s)",
    (invalid) => {
      const { session, auth, metadata } = setup();
      auth.load.mockImplementation(() => {
        if (invalid) throw new Error("Invalid auth");
        return null;
      });
      expect(session.start()).toBeNull();
      expect(auth.clear).toHaveBeenCalledTimes(invalid ? 1 : 0);
      expect(metadata.restore).not.toHaveBeenCalled();
      expect(session.status).toBe("disconnected");
    },
  );

  it("restores the workspace before connecting and refreshes without reconnecting", async () => {
    const { session, metadata, covers, queue, tracks, auth } = setup();
    const restoration = deferred();
    covers.restore.mockReturnValueOnce(restoration.promise);
    expect(session.start()).toEqual(credentials);
    expect(metadata.restore).toHaveBeenCalledWith({
      host: credentials.host,
      username: credentials.username,
    });
    expect(queue.restore).not.toHaveBeenCalled();
    expect(metadata.revalidate).not.toHaveBeenCalled();
    restoration.resolve();
    await vi.waitFor(() => expect(session.status).toBe("connected"));
    expect(queue.restore.mock.invocationCallOrder[0]).toBeLessThan(
      metadata.revalidate.mock.invocationCallOrder[0],
    );
    expect(auth.save).toHaveBeenCalledWith(credentials);
    expect(tracks.setClient).toHaveBeenCalledWith(session.client);
    covers.refresh.mockClear();
    await session.refresh();
    expect(metadata.refresh).toHaveBeenCalledOnce();
    expect(metadata.revalidate).toHaveBeenCalledOnce();
    expect(metadata.setClient).toHaveBeenCalledOnce();
    expect(metadata.restore).toHaveBeenCalledOnce();
    expect(queue.synchronize).toHaveBeenCalledOnce();
    expect(tracks.setClient).toHaveBeenCalledOnce();
    expect(covers.refresh).toHaveBeenCalledOnce();
    expect(auth.save).toHaveBeenCalledOnce();
  });

  it("waits for the first successful metadata load before restoring the queue and attaching playback", async () => {
    const { session, metadata, queue, tracks } = setup();
    metadata.savedAt = undefined;
    const refresh = deferred();
    metadata.revalidate.mockReturnValueOnce(refresh.promise);
    const connecting = session.connect(input);
    await vi.waitFor(() => expect(metadata.revalidate).toHaveBeenCalledOnce());
    expect(queue.restore).not.toHaveBeenCalled();
    expect(tracks.setClient).not.toHaveBeenCalled();
    refresh.resolve();
    expect(await connecting).toBe(true);
    expect(queue.restore).toHaveBeenCalledOnce();
    expect(tracks.setClient).toHaveBeenCalledOnce();
  });

  it("attaches cached playback before revalidation, but does not save failed credentials", async () => {
    const { session, metadata, tracks, auth } = setup();
    const refresh = deferred();
    metadata.revalidate.mockImplementationOnce(async () => {
      expect(tracks.setClient).toHaveBeenCalledOnce();
      metadata.status = "refreshing";
      await refresh.promise;
      metadata.warning = new Error("Server unavailable");
      metadata.status = "ready";
    });
    const connecting = session.connect(input);
    await vi.waitFor(() => expect(metadata.revalidate).toHaveBeenCalledOnce());
    expect(session.status).toBe("connecting");
    expect(auth.save).not.toHaveBeenCalled();
    refresh.resolve();
    expect(await connecting).toBe(true);
    expect(session.status).toBe("error");
    expect(session.refreshError).toBe("Background refresh failed: Server unavailable");
    expect(tracks.setClient).toHaveBeenCalledOnce();
    expect(auth.save).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reports uncached connection errors without retaining a foreign client (previous connection: %s)",
    async (previous) => {
      const { session, metadata, tracks, auth } = setup();
      if (previous) await session.connect(input);
      auth.create.mockReturnValue({ ...credentials, host: "https://other.example" });
      auth.save.mockClear();
      tracks.setClient.mockClear();
      metadata.savedAt = undefined;
      metadata.revalidate.mockImplementationOnce(async () => {
        metadata.status = "error";
        metadata.error = new TypeError("Failed to fetch");
      });
      expect(await session.connect(input)).toBe(false);
      expect(session.error).toContain("CORS");
      expect(session.client).toBeUndefined();
      expect(tracks.setClient).not.toHaveBeenCalled();
      expect(auth.save).not.toHaveBeenCalled();
      await session.refresh();
      expect(metadata.refresh).not.toHaveBeenCalled();
    },
  );

  it("starts offline and resumes network work once without rebuilding the workspace", async () => {
    const { session, memory, storage, metadata, covers, queue, playback, auth } = setup();
    storage.getItem.mockReturnValue("true");
    memory.queueTracks = ["track"];
    memory.queueIndex = 0;
    session.start();
    await vi.waitFor(() => expect(playback.pause).toHaveBeenCalledOnce());
    expect(metadata.setNetwork).toHaveBeenCalledWith("offline");
    expect(queue.setNetwork).toHaveBeenCalledWith("offline");
    expect(session.status).toBe("disconnected");
    expect(auth.save).not.toHaveBeenCalled();
    covers.refresh.mockClear();
    metadata.revalidate.mockClear();
    queue.synchronize.mockClear();
    await session.setOfflineMode(false);
    expect(storage.setItem).toHaveBeenCalledWith("navidrome-offline-mode", "false");
    expect(metadata.setNetwork.mock.calls).toEqual([["offline"], ["online"]]);
    expect(queue.setNetwork.mock.calls).toEqual([["offline"], ["online"]]);
    expect(metadata.revalidate).toHaveBeenCalledOnce();
    expect(queue.synchronize).toHaveBeenCalledOnce();
    expect(covers.refresh).toHaveBeenCalledOnce();
    expect(metadata.restore).toHaveBeenCalledOnce();
    expect(session.status).toBe("connected");
  });

  it("does not let delayed startup replace an explicit connection", async () => {
    const { session, auth, metadata, covers, queue } = setup();
    const restoration = deferred();
    covers.restore.mockReturnValueOnce(restoration.promise);
    session.start();
    const next = { ...credentials, host: "https://other.example" };
    auth.create.mockReturnValue(next);
    expect(await session.connect({ ...input, host: next.host })).toBe(true);
    restoration.resolve();
    await restoration.promise;
    await Promise.resolve();
    expect(metadata.revalidate).toHaveBeenCalledOnce();
    expect(queue.restore).toHaveBeenCalledOnce();
    expect(session.auth).toEqual(next);
  });

  it.each([false, true])(
    "ignores an obsolete revalidation completion (reject: %s)",
    async (reject) => {
      const { session, auth, metadata } = setup();
      const first = deferred();
      metadata.revalidate.mockReturnValueOnce(first.promise);
      const oldConnection = session.connect(input);
      await vi.waitFor(() => expect(metadata.revalidate).toHaveBeenCalledOnce());
      const next = { ...credentials, host: "https://other.example" };
      auth.create.mockReturnValue(next);
      expect(await session.connect({ ...input, host: next.host })).toBe(true);
      if (reject) first.reject(new Error("Old failure"));
      else first.resolve();
      expect(await oldConnection).toBe(false);
      expect(session.status).toBe("connected");
      expect(session.error).toBe("");
      expect(auth.save.mock.calls).toEqual([[next]]);
    },
  );

  it("ignores a delayed offline scan after returning online", async () => {
    const { session, memory, tracks, playback, metadata, covers, queue } = setup();
    await session.connect(input);
    memory.queueTracks = ["track"];
    memory.queueIndex = 0;
    const scan = deferred();
    const persistence = deferred();
    queue.flush.mockReturnValueOnce(persistence.promise);
    tracks.ready.mockReturnValueOnce(scan.promise);
    const offline = session.setOfflineMode(true);
    await vi.waitFor(() => expect(tracks.ready).toHaveBeenCalledOnce());
    expect(queue.flush).toHaveBeenCalledOnce();
    expect(metadata.revalidate).toHaveBeenCalledOnce();
    covers.refresh.mockClear();
    await session.setOfflineMode(false);
    scan.resolve();
    await offline;
    expect(playback.pause).not.toHaveBeenCalled();
    expect(covers.refresh).toHaveBeenCalledOnce();
    expect(session.status).toBe("connected");
    persistence.resolve();
  });

  it("does not configure engines or persist after destruction", async () => {
    const { session, metadata, tracks, covers, auth } = setup();
    const pending = deferred();
    metadata.restore.mockReturnValueOnce(pending.promise);
    const connecting = session.connect(input);
    session.destroy();
    pending.resolve();
    expect(await connecting).toBe(false);
    expect(tracks.setClient).not.toHaveBeenCalled();
    expect(covers.refresh).not.toHaveBeenCalled();
    expect(auth.save).not.toHaveBeenCalled();
  });
});

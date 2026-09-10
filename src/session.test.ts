import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetadataSnapshot } from "./storage";
import { NetworkTransportError } from "./network.svelte";
import { createSession, credentials, deferred, snapshot } from "./session-test-helpers";

const fixtures: ReturnType<typeof createSession>[] = [];

function setup(...args: Parameters<typeof createSession>) {
  const fixture = createSession(...args);
  fixtures.push(fixture);
  return fixture;
}

async function connected() {
  const fixture = setup(true);
  fixture.session.start();
  await vi.waitFor(() => expect(fixture.session.status).toBe("connected"));
  return fixture;
}

afterEach(() => {
  for (const { session } of fixtures.splice(0)) session.destroy();
});

const input = { host: credentials.host, username: credentials.username, password: "password" };

describe("session", () => {
  it("hydrates local data before a pending background refresh completes", async () => {
    const { session, metadata, memory, queue } = setup(true);
    const refresh = deferred();
    metadata.revalidate.mockReturnValueOnce(refresh.promise);
    session.start();
    await vi.waitFor(() => expect(session.syncing).toBe(true));
    expect(session.localReady).toBe(true);
    expect(session.busy).toBe(false);
    expect(memory.artists.size).toBe(1);
    expect(queue.restore).toHaveBeenCalledOnce();
    refresh.resolve();
    await vi.waitFor(() => expect(session.syncing).toBe(false));
  });

  it("finishes local hydration even when startup revalidation fails", async () => {
    const { session, metadata, memory } = setup(true);
    metadata.revalidate.mockRejectedValueOnce(new Error("Server unavailable"));
    session.start();
    await vi.waitFor(() => expect(session.refreshError).toContain("Server unavailable"));
    expect(session.localReady).toBe(true);
    expect(session.syncing).toBe(false);
    expect(session.error).toBe("");
    expect(memory.artists.size).toBe(1);
  });

  it("keeps local data and connection state after a background refresh failure", async () => {
    const { session, metadata, memory } = await connected();
    const artists = memory.artists;
    metadata.refresh.mockRejectedValueOnce(new Error("Server unavailable"));
    await session.refresh();
    expect(session.localReady).toBe(true);
    expect(session.syncing).toBe(false);
    expect(session.status).toBe("connected");
    expect(session.error).toBe("");
    expect(session.refreshError).toContain("Server unavailable");
    expect(memory.artists).toBe(artists);
  });

  it("migrates saved credentials to a non-secret account and refreshes without reconnecting", async () => {
    const { session, storage, metadata, tracks, queue } = await connected();
    expect(JSON.parse(storage.getItem("navidrome-account")!)).toEqual({
      host: credentials.host,
      username: credentials.username,
    });
    const client = tracks.setConnection.mock.calls.at(-1)![0];
    const refresh = deferred();
    metadata.refresh.mockReturnValueOnce(refresh.promise);
    const pending = session.refresh();
    const overlapping = session.refresh();
    expect(metadata.refresh).toHaveBeenCalledOnce();
    expect(session.busy).toBe(false);
    expect(session.syncing).toBe(true);
    expect(session.localReady).toBe(true);
    refresh.resolve();
    await Promise.all([pending, overlapping]);
    expect(metadata.revalidate).toHaveBeenCalledOnce();
    expect(metadata.restore).toHaveBeenCalledOnce();
    expect(tracks.setConnection.mock.calls.at(-1)![0]).toBe(client);
    expect(queue.synchronize).toHaveBeenCalledTimes(2);
    expect(await session.connect(input)).toBe(false);
    expect(metadata.prepareConnection).not.toHaveBeenCalled();
  });

  it("disconnects immediately, aborts the client, and preserves every offline data field", async () => {
    const { session, auth, memory, metadata, tracks, covers, queue, playback, storage } =
      await connected();
    const client = tracks.setConnection.mock.calls.at(-1)![0];
    const fields = [
      "artists",
      "albums",
      "tracks",
      "artistAlbums",
      "albumTracks",
      "downloads",
      "images",
      "artistArtwork",
      "albumArtwork",
      "trackArtwork",
    ] as const;
    const data = fields.map((field) => memory[field]);
    const queueState = [memory.queueTracks, memory.queueIndex, memory.queuePosition];
    const refresh = deferred();
    metadata.refresh.mockReturnValueOnce(refresh.promise);
    const pending = session.refresh();
    session.disconnect();
    expect(session.syncing).toBe(false);
    expect(session.localReady).toBe(true);
    expect(client.signal.aborted).toBe(true);
    expect(auth.load()).toBeNull();
    expect(session.auth).toBeNull();
    expect(session.offlineMode).toBe(true);
    expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    expect(session.status).toBe("disconnected");
    fields.forEach((field, index) => expect(memory[field]).toBe(data[index]));
    expect([memory.queueTracks, memory.queueIndex, memory.queuePosition]).toEqual(queueState);
    expect(metadata.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(queue.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(covers.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(tracks.setConnection).toHaveBeenLastCalledWith(undefined);
    expect(playback.suspendNetwork).toHaveBeenCalled();
    refresh.resolve();
    await pending;
    expect(session.status).toBe("disconnected");
    expect(auth.load()).toBeNull();
  });

  it("restores the last account and queue after disconnect without making network requests", async () => {
    const first = await connected();
    first.session.disconnect();
    const { session, memory, metadata, queue, storage } = setup(false, first.storage);
    expect(session.start()).toBeNull();
    await vi.waitFor(() => expect(queue.restore).toHaveBeenCalledOnce());
    expect(memory.account).toEqual({ host: credentials.host, username: credentials.username });
    expect(memory.artists.get("artist")?.name).toBe(credentials.username);
    expect(memory.queuePosition).toBe(17);
    expect(session.offlineMode).toBe(true);
    await session.setOfflineMode(false);
    expect(session.offlineMode).toBe(true);
    expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    expect(metadata.revalidate).not.toHaveBeenCalled();
    expect(metadata.prepareConnection).not.toHaveBeenCalled();
    expect(queue.synchronize).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "forces offline mode without usable saved credentials (invalid: %s)",
    (invalid) => {
      const { session, storage, auth } = setup();
      if (invalid) storage.setItem("navidrome-auth", "invalid");
      storage.setItem("navidrome-offline-mode", "false");
      expect(session.start()).toBeNull();
      expect(auth.load()).toBeNull();
      expect(session.offlineMode).toBe(true);
      expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    },
  );

  it("allows explicit connection while forced offline and only switches accounts after validation", async () => {
    const { session, memory, auth, metadata, queue, covers } = await connected();
    session.disconnect();
    const previous = memory.artists;
    const prepared = deferred<MetadataSnapshot>();
    metadata.prepareConnection.mockReturnValueOnce(prepared.promise);
    const next = { host: "https://other.example", username: "other" };
    const connecting = session.connect({ ...next, password: "secret" });
    await vi.waitFor(() => expect(metadata.prepareConnection).toHaveBeenCalledOnce());
    expect(session.offlineMode).toBe(true);
    expect(session.auth).toBeNull();
    expect(memory.artists).toBe(previous);
    expect(await session.connect(input)).toBe(false);
    prepared.resolve(snapshot(next));
    expect(await connecting).toBe(true);
    expect(memory.account).toEqual(next);
    expect(memory.artists.get("artist")?.name).toBe("other");
    expect(memory.queueTracks).toEqual(["other"]);
    expect(covers.restore).toHaveBeenLastCalledWith(expect.objectContaining({ account: next }));
    expect(queue.restore).toHaveBeenLastCalledWith(expect.objectContaining({ account: next }));
    expect(session.auth).toMatchObject(next);
    expect(auth.load()).toEqual(session.auth);
    expect(auth.loadAccount()).toEqual(next);
    expect(session.offlineMode).toBe(false);
    expect(session.status).toBe("connected");
  });

  it.each(["same", "different"])(
    "keeps the offline workspace after failed reconnect to a %s account",
    async (account) => {
      const { session, memory, auth, metadata } = await connected();
      session.disconnect();
      const previous = memory.artists;
      const selection = memory.account;
      metadata.prepareConnection.mockRejectedValueOnce(
        new NetworkTransportError(new TypeError("Network failed")),
      );
      expect(
        await session.connect({
          ...input,
          username: account === "same" ? credentials.username : "other",
        }),
      ).toBe(false);
      expect(memory.artists).toBe(previous);
      expect(memory.account).toBe(selection);
      expect(metadata.acceptConnection).not.toHaveBeenCalled();
      expect(session.auth).toBeNull();
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual(selection);
      expect(session.offlineMode).toBe(true);
      expect(session.error).toContain("CORS");
    },
  );

  it.each(["disconnect", "destroy"] as const)(
    "ignores a candidate that resolves after %s",
    async (action) => {
      const { session, auth, metadata, tracks } = setup();
      session.start();
      const prepared = deferred<MetadataSnapshot>();
      metadata.prepareConnection.mockReturnValueOnce(prepared.promise);
      const connecting = session.connect(input);
      await vi.waitFor(() => expect(metadata.prepareConnection).toHaveBeenCalledOnce());
      const client = metadata.prepareConnection.mock.calls[0][0];
      session[action]();
      prepared.resolve(snapshot(credentials));
      expect(await connecting).toBe(false);
      expect(client.signal.aborted).toBe(true);
      expect(auth.load()).toBeNull();
      expect(metadata.acceptConnection).not.toHaveBeenCalled();
      expect(tracks.setConnection.mock.calls.every(([client]) => client === undefined)).toBe(true);
    },
  );

  it.each(["credentials", "metadata"])(
    "preserves the workspace and removes partial credentials when saving %s fails",
    async (stage) => {
      const { session, auth, metadata, memory, storage } = await connected();
      session.disconnect();
      const previous = memory.artists;
      const account = memory.account;
      if (stage === "credentials")
        vi.spyOn(auth, "save").mockImplementationOnce(() => {
          throw new TypeError("Storage full");
        });
      else metadata.saveConnection.mockRejectedValueOnce(new TypeError("Storage full"));
      expect(await session.connect({ ...input, username: "other" })).toBe(false);
      expect(session.error).toBe("Storage full");
      expect(memory.artists).toBe(previous);
      expect(metadata.acceptConnection).not.toHaveBeenCalled();
      expect(auth.load()).toBeNull();
      expect(auth.loadAccount()).toEqual(account);
      expect(storage.getItem("navidrome-offline-mode")).toBe("true");
    },
  );

  it("does not report invalid connection input as a transport or CORS failure", async () => {
    const { session, metadata } = setup();
    expect(await session.connect({ ...input, host: "https://" })).toBe(false);
    expect(session.error).toMatch(/URL/i);
    expect(session.error).not.toContain("CORS");
    expect(metadata.prepareConnection).not.toHaveBeenCalled();
  });

  it("removes credentials saved during connection if disconnect interrupts metadata persistence", async () => {
    const { session, auth, metadata, memory } = await connected();
    session.disconnect();
    const previous = memory.artists;
    const saved = deferred<MetadataSnapshot>();
    metadata.saveConnection.mockReturnValueOnce(saved.promise);
    const connecting = session.connect(input);
    await vi.waitFor(() => expect(metadata.saveConnection).toHaveBeenCalledOnce());
    expect(auth.load()).not.toBeNull();
    session.disconnect();
    saved.resolve(snapshot(credentials));
    expect(await connecting).toBe(false);
    expect(auth.load()).toBeNull();
    expect(memory.artists).toBe(previous);
    expect(metadata.acceptConnection).not.toHaveBeenCalled();
  });

  it("does not reconnect when disconnect occurs during startup restoration", async () => {
    const { session, auth, metadata, queue, memory } = setup(true);
    const restored = deferred();
    metadata.restore.mockReturnValueOnce(restored.promise);
    session.start();
    session.disconnect();
    restored.resolve();
    await vi.waitFor(() => expect(queue.restore).toHaveBeenCalledOnce());
    expect(memory.queuePosition).toBe(17);
    expect(auth.load()).toBeNull();
    expect(metadata.revalidate).not.toHaveBeenCalled();
    expect(queue.synchronize).not.toHaveBeenCalled();
  });

  it("keeps credentials for voluntary offline mode and resumes with a fresh cancellable client", async () => {
    const { session, tracks, metadata, auth, queue } = await connected();
    const client = tracks.setConnection.mock.calls.at(-1)![0];
    await session.setOfflineMode(true);
    expect(client.signal.aborted).toBe(true);
    expect(auth.load()).not.toBeNull();
    expect(session.auth).not.toBeNull();
    await session.setOfflineMode(false);
    expect(tracks.setConnection.mock.calls.at(-1)![0]).not.toBe(client);
    expect(metadata.restore).toHaveBeenCalledOnce();
    expect(metadata.revalidate).toHaveBeenCalledOnce();
    expect(metadata.refresh).not.toHaveBeenCalled();
    expect(queue.synchronize).toHaveBeenCalledOnce();
    expect(session.status).toBe("connected");
    await session.refresh();
    expect(metadata.refresh).toHaveBeenCalledOnce();
    expect(queue.synchronize).toHaveBeenCalledTimes(2);
  });
});

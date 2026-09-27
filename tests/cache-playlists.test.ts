import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";

afterEach(() => vi.restoreAllMocks());

describe("playlist checkpoint", () => {
  it("restores cached summaries and loaded ordered occurrences independently of the library", async () => {
    installDisk();
    const first = new Cache("account-one");
    await first.load();
    first.setPlaylists({
      listedAt: 123,
      summaries: [
        { id: "p", name: "Mix" },
        { id: "unloaded", name: "Empty or not fetched" },
      ],
      details: [
        {
          summary: { id: "p", name: "Mix" },
          fetchedAt: 124,
          entries: [
            { id: "song", title: "Lost" },
            { id: "song", title: "Lost" },
          ],
        },
      ],
    });
    expect(first.playlists.details[0].entries).toHaveLength(2);
    await first.flush();
    const restored = new Cache("account-one");
    await restored.load();
    expect(restored.playlists).toEqual(first.playlists);
    expect(
      restored.playlists.details.find((detail) => detail.summary.id === "unloaded"),
    ).toBeUndefined();
    const other = new Cache("account-two");
    await other.load();
    expect(other.playlists).toEqual({ listedAt: null, summaries: [], details: [] });
  });

  it("publishes server success even if its checkpoint fails", async () => {
    const disk = installDisk();
    const cache = new Cache("account");
    await cache.load();
    cache.setPlaylists({ listedAt: 1, summaries: [{ id: "p", name: "Mix" }], details: [] });
    disk.state.failClose = true;
    await expect(cache.flush()).rejects.toThrow();
    expect(cache.playlists.summaries[0].name).toBe("Mix");
    expect(cache.dirty).toBe(true);
    expect(cache.error).toBeInstanceOf(AggregateError);
  });
});

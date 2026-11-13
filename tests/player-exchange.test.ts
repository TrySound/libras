// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, tick } from "svelte";
import Player from "../src/ui/player.svelte";
import { Cache } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { TestSelection } from "./cache-selection-test-helpers.svelte";
import { TrackEngine } from "../src/track.svelte";
import { Covers } from "../src/covers.svelte";
import { Playback } from "../src/playback.svelte";
import { deferred } from "./session-test-helpers";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
});
function setup(serverQueueExchange = true) {
  const account = { host: "https://music.example", username: "listener" };
  const cache = new Cache(getAccountKey(account));
  const selection = new TestSelection();
  selection.cache = cache;
  const tracks = new TrackEngine({ selection });
  const covers = new Covers(selection);
  const playback = new Playback({ selection, tracks, covers });
  const connection = {
    account,
    signal: new AbortController().signal,
    read: vi.fn(async () => ({ trackIds: ["missing", "missing"], position: 0 })),
    write: vi.fn(async () => {}),
  };
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(Player, {
    target,
    props: {
      cache,
      covers,
      playback,
      trackEngine: tracks,
      audio: undefined,
      offlineMode: false,
      serverQueueExchange,
    },
  });
  flushSync();
  cleanups.push(async () => {
    await unmount(component);
    await playback.destroy();
    tracks.destroy();
    covers.destroy();
  });
  const button = (label: string) =>
    [...target.querySelectorAll("#player-dialog button")].find(
      (el) => el.textContent?.trim() === label,
    ) as HTMLButtonElement;
  return { target, playback, connection, cache, button };
}
it("removes duplicate and unknown occurrences by original index and restores removal focus", async () => {
  const { target, cache, playback } = setup();
  await cache.replaceLibrary({
    savedAt: 1,
    lastModified: 1,
    artists: [],
    albums: [],
    tracks: [{ id: "same", title: "Same", albumId: "", artistIds: [], genres: [] }],
  });
  playback.setQueue({ tracks: ["same", "missing", "same"], index: 2, position: 12 });
  flushSync();
  target.querySelector<HTMLDialogElement>("#player-dialog")!.showModal();
  const remove = (number: number) =>
    target.querySelector<HTMLButtonElement>(`button[aria-label$="queue item ${number}"]`)!;
  remove(1).click();
  await tick();
  flushSync();
  expect(cache.queue).toMatchObject({ tracks: ["missing", "same"], index: 1, position: 12 });
  await vi.waitFor(() => expect(document.activeElement).toBe(remove(1)));
  remove(2).click();
  await tick();
  flushSync();
  expect(cache.queue).toMatchObject({ tracks: ["missing"], index: -1, position: 0 });
  expect(target.textContent).toContain("Track removed. Playback stopped.");
  await vi.waitFor(() => expect(document.activeElement).toBe(remove(1)));
  remove(1).click();
  await tick();
  flushSync();
  expect(cache.queue.tracks).toEqual([]);
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Up next"));
});

it("keeps empty queue exchange actions visible, disabled until connected and confirms every load", () => {
  const { target, playback, connection, button } = setup();
  expect(target.textContent).toContain("Your queue is empty.");
  expect(button("Load server queue").disabled).toBe(true);
  expect(target.textContent).toContain("Connect to exchange server queues.");
  playback.setConnection(connection);
  flushSync();
  expect(button("Load server queue").disabled).toBe(false);
  expect(button("Load server queue").getAttribute("command")).toBe("show-modal");
  const confirmation = target.querySelector(
    `#${button("Load server queue").getAttribute("commandfor")}`,
  )!;
  expect(confirmation.textContent).toContain("Replace this device’s queue?");
  expect(
    [...confirmation.querySelectorAll("button")].find((button) => button.autofocus)?.textContent,
  ).toBe("Cancel");
  expect(connection.read).not.toHaveBeenCalled();
  expect(connection.write).not.toHaveBeenCalled();
});
it("guards exchange controls while busy but retains clear queue and sanitized inline feedback", async () => {
  const { target, playback, connection, cache, button } = setup();
  playback.setConnection(connection);
  cache.setQueue({ tracks: ["missing"], index: -1, position: 0 });
  const pending = deferred<{ trackIds: string[]; position: number }>();
  connection.read.mockReturnValue(pending.promise);
  const request = playback.loadServerQueue();
  flushSync();
  expect(button("Loading…").disabled).toBe(true);
  expect(button("Save queue to server").disabled).toBe(true);
  expect(button("Clear queue").disabled).toBe(false);
  pending.reject(new Error("https://secret.example/?password=secret"));
  await request;
  flushSync();
  expect(target.querySelector('[role="status"]')?.textContent).toBe(
    "Could not load server queue. Nothing was replaced.",
  );
  expect(cache.queue.tracks).toEqual(["missing"]);
});
it("never offers unsupported server exchange in the demo", () => {
  const { target, playback, connection, button } = setup(false);
  playback.setConnection(connection);
  flushSync();
  expect(button("Load server queue").disabled).toBe(true);
  expect(button("Save queue to server").disabled).toBe(true);
  expect(target.textContent).toContain("Server queue exchange is unavailable in the demo.");
  expect(connection.read).not.toHaveBeenCalled();
  expect(connection.write).not.toHaveBeenCalled();
});

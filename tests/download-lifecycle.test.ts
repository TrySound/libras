import { afterEach, expect, it, vi } from "vitest";
import { Cache, downloadKey } from "../src/cache.svelte";
import { TrackEngine } from "../src/track.svelte";
import { Network } from "../src/network.svelte";
import { getAccountKey } from "../src/auth";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const track = {
  id: "orphan",
  title: "Original title",
  artist: "Artist",
  album: "Album",
  contentType: "audio/flac",
};
let engine: TrackEngine;
afterEach(() => {
  engine?.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const disk = installDisk();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement: () => ({ canPlayType: () => "" }),
  });
  const win = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true, writable: true });
  const cache = new Cache(getAccountKey(account));
  for (const format of ["raw", "mp3"] as const) {
    await cache.enqueueDownload(track, format, format === "raw" ? "audio/flac" : "audio/mpeg");
    await cache.failDownload(downloadKey(track.id, format));
  }
  const selection = { cache };
  engine = new TrackEngine({ selection });
  const network = new Network();
  const connect = (selected = account) =>
    engine.setDownloadConnection(
      network.open(
        {
          ...selected,
          credentials: {
            method: "token",
            username: selected.username,
            token: "token",
            salt: "salt",
          },
        },
        new AbortController().signal,
      ).audio,
    );
  vi.useFakeTimers();
  return { disk, cache, selection, doc, win, connect };
}
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

it("recovers exact formats and metadata on reopen, coalesces signals, and never self-retries failures", async () => {
  const { cache, selection, doc, win, connect } = await setup();
  const reopened = new Cache(cache.key);
  await reopened.load();
  selection.cache = reopened;
  const enqueue = vi.spyOn(reopened, "enqueueDownload");
  const fetcher = vi.fn(async () => new Response("bad", { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  connect();
  engine.installDownloadLifecycle();
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("pageshow"));
  win.dispatchEvent(new Event("online"));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    [...reopened.downloads.values()].every(
      (entry) => entry.status === "failed" && entry.track.title === track.title,
    ),
  ).toBe(true);
  expect(
    enqueue.mock.calls.map(([saved, format, contentType]) => ({ saved, format, contentType })),
  ).toEqual([
    { saved: track, format: "raw", contentType: "audio/flac" },
    { saved: track, format: "mp3", contentType: "audio/mpeg" },
  ]);
  await tick(20000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  win.dispatchEvent(new Event("online"));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(4);
  win.dispatchEvent(new Event("pageshow"));
  doc.dispatchEvent(new Event("visibilitychange"));
  await tick(4999);
  expect(fetcher).toHaveBeenCalledTimes(4);
  await tick(1);
  expect(fetcher).toHaveBeenCalledTimes(6);
  await engine.restoreDownloads();
  await tick(20000);
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it("suspends hidden/offline execution and resumes queued intent on return", async () => {
  const { cache, doc, win, connect } = await setup();
  const fetcher = vi.fn(async () => new Response("audio"));
  vi.stubGlobal("fetch", fetcher);
  doc.visibilityState = "hidden";
  engine.installDownloadLifecycle();
  connect();
  void engine.download("queued");
  await tick();
  expect(fetcher).not.toHaveBeenCalled();
  doc.visibilityState = "visible";
  Object.assign(navigator, { onLine: false });
  win.dispatchEvent(new Event("offline"));
  doc.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(fetcher).not.toHaveBeenCalled();
  Object.assign(navigator, { onLine: true });
  win.dispatchEvent(new Event("online"));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect([...cache.downloads.values()].every((entry) => entry.status === "completed")).toBe(true);
});

it.each(["cancel", "destroy", "account"])("invalidates cooldown recovery on %s", async (action) => {
  const { cache, selection, win, connect } = await setup();
  const fetcher = vi.fn(async () => new Response("bad", { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  connect();
  engine.installDownloadLifecycle();
  await tick();
  win.dispatchEvent(new Event("online"));
  if (action === "cancel") await engine.cancelDownloads();
  else if (action === "destroy") engine.destroy();
  else {
    selection.cache = new Cache(getAccountKey({ ...account, username: "other" }));
    engine.activate();
  }
  await tick(5000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  if (action === "cancel") {
    expect(cache.downloads.size).toBe(0);
    win.dispatchEvent(new Event("online"));
    await tick(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const reopened = new Cache(cache.key);
    await reopened.load();
    expect(reopened.downloads.size).toBe(0);
  }
});

it("aborts active transfers while hidden, retaining intent for restart on return", async () => {
  const { cache, doc, connect } = await setup();
  const aborted = vi.fn();
  const fetcher = vi.fn(
    (_url: unknown, options?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => {
            aborted();
            reject(options!.signal!.reason);
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  connect();
  engine.installDownloadLifecycle();
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(aborted).toHaveBeenCalledTimes(2);
  expect([...cache.downloads.values()].every((entry) => entry.status === "queued")).toBe(true);
  fetcher.mockImplementation(async () => new Response("restarted"));
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await tick(5000);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect([...cache.downloads.values()].every((entry) => entry.status === "completed")).toBe(true);
});

it("manual retries bypass the automatic cooldown without duplicating active jobs", async () => {
  const { win, connect } = await setup();
  const fetcher = vi.fn(async () => new Response("bad", { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  connect();
  engine.installDownloadLifecycle();
  await tick();
  win.dispatchEvent(new Event("online"));
  const first = engine.download(track.id, { format: "raw" });
  const duplicate = engine.download(track.id, { format: "raw" });
  expect(first).toBe(duplicate);
  await tick();
  await expect(first).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("recovers the incoming account's failed formats after another account's cancellation joins", async () => {
  const { cache, disk, selection, win, connect } = await setup();
  const closing = deferred<void>();
  const release = deferred<void>();
  disk.state.beforeClose = async (name) => {
    if (name.endsWith(".audio")) {
      closing.resolve();
      await release.promise;
    }
  };
  const fetcher = vi.fn(async () => new Response("audio"));
  vi.stubGlobal("fetch", fetcher);
  connect();
  void engine.download("closing");
  await closing.promise;
  engine.installDownloadLifecycle();
  const cancel = engine.cancelDownloads();
  const other = { ...account, username: "other" };
  const next = new Cache(getAccountKey(other));
  for (const format of ["raw", "mp3"] as const) {
    await next.enqueueDownload(track, format, format === "raw" ? "audio/flac" : "audio/mpeg");
    await next.failDownload(downloadKey(track.id, format));
  }
  selection.cache = next;
  engine.activate();
  connect(other);
  win.dispatchEvent(new Event("online"));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(engine.cancelingDownloads).toBe(true);
  release.resolve();
  await cancel;
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect([...next.downloads.values()].map((entry) => entry.status)).toEqual([
    "completed",
    "completed",
  ]);
  expect([...cache.downloads.values()].map((entry) => entry.track.id)).toEqual(["closing"]);
  win.dispatchEvent(new Event("online"));
  await tick(5000);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not fetch when failed-to-queued persistence rejects", async () => {
  const { cache, disk, connect } = await setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  disk.state.failClose = true;
  connect();
  engine.installDownloadLifecycle();
  await tick();
  expect(fetcher).not.toHaveBeenCalled();
  expect([...cache.downloads.values()].every((entry) => entry.status === "failed")).toBe(true);
});

it("invalidates a recovery still loading storage when cancellation begins", async () => {
  const { cache, connect } = await setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  connect();
  await tick();
  const gate = deferred<void>();
  vi.spyOn(cache, "loadDownloads").mockImplementationOnce(() => gate.promise);
  engine.installDownloadLifecycle();
  await tick();
  await engine.cancelDownloads();
  gate.resolve();
  await tick();
  expect(fetcher).not.toHaveBeenCalled();
  expect(cache.downloads.size).toBe(0);
});

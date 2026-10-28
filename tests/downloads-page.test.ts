// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { fromStore, writable } from "svelte/store";
import Downloads from "../src/_downloads.svelte";
import { Cache, downloadKey } from "../src/cache.svelte";
import { Covers } from "../src/covers.svelte";
import { TrackEngine } from "../src/track.svelte";
import { getAccountKey } from "../src/auth";
import { Network } from "../src/network.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
type Jobs = TrackEngine["downloadJobs"];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(realJobs = false) {
  const disk = installDisk();
  const cache = new Cache(getAccountKey(account));
  const selection = { cache };
  const covers = new Covers(selection);
  const trackEngine = new TrackEngine({ selection, concurrency: 1 });
  const store = writable({ jobs: [] as Jobs, error: undefined as unknown, loading: false });
  const state = fromStore(store);
  if (!realJobs) {
    vi.spyOn(trackEngine, "downloadJobs", "get").mockImplementation(() => state.current.jobs);
    vi.spyOn(trackEngine, "error", "get").mockImplementation(() => state.current.error);
  }
  const target = document.createElement("div");
  const component = mount(Downloads, {
    target,
    props: {
      cache,
      covers,
      trackEngine,
      get loading() {
        return state.current.loading;
      },
    } satisfies ComponentProps<typeof Downloads>,
  });
  flushSync();
  cleanups.push(async () => {
    await unmount(component);
    trackEngine.destroy();
    covers.destroy();
  });
  return {
    target,
    cache,
    covers,
    trackEngine,
    disk,
    set(patch: Partial<typeof state.current>) {
      store.update((value) => ({ ...value, ...patch }));
      flushSync();
    },
  };
}

function job(cache: Cache, id: string, status: "downloading" | "queued"): Jobs[number] {
  return {
    cacheKey: cache.key!,
    key: downloadKey(id, "mp3"),
    format: "mp3",
    contentType: "audio/mpeg",
    track: { id, title: `${id} title`, artist: `${id} artist`, album: `${id} album` },
    status,
  };
}

async function save(cache: Cache, id: string, timestamp: number, format: "mp3" | "raw" = "mp3") {
  const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
  try {
    await cache.saveDownload(
      { id, title: `${id} title`, artist: `${id} artist`, album: `${id} album` },
      format,
      format === "mp3" ? "audio/mpeg" : "audio/flac",
      new Response("audio"),
      new AbortController().signal,
    );
    await cache.flush();
  } finally {
    clock.mockRestore();
  }
  flushSync();
}

it("restores silently with a native heading and shows the empty state only once ready", () => {
  const { target, set } = setup();
  expect(target.querySelector(".downloads-view")?.getAttribute("aria-labelledby")).toBe(
    "downloads-heading",
  );
  expect(target.querySelector("h1")?.textContent).toBe("Downloads");
  expect(target.textContent).toContain("No downloads yet");
  expect(target.querySelector('a[href="#/library"]')?.textContent).toBe("Open library");
  set({ loading: true });
  expect(target.textContent).not.toContain("No downloads yet");
  expect(target.textContent).not.toContain("Restoring local library");
  expect(target.querySelectorAll(".loader-bar")).toHaveLength(0);
  set({ loading: false });
  expect(target.querySelector('[role="status"]')).toBeNull();
  expect(target.textContent).toContain("No downloads yet");
});

it("preserves active-job precedence and newest-first saved files, including orphan metadata and formats", async () => {
  const { target, cache, covers, set } = setup();
  const ensure = vi.spyOn(covers, "ensureCover");
  await save(cache, "older", 1000);
  await save(cache, "newer", 2000, "raw");
  await save(cache, "active", 3000);
  set({ jobs: [job(cache, "active", "downloading"), job(cache, "waiting", "queued")] });
  const rows = [...target.querySelectorAll('[role="listitem"]')];
  expect(rows.map((row) => row.querySelector(".label")?.textContent)).toEqual([
    "active title",
    "waiting title",
    "newer title",
    "older title",
  ]);
  expect(rows.map((row) => row.querySelector('[role="img"]')?.getAttribute("aria-label"))).toEqual([
    "Downloading",
    "Queued for download",
    "Downloaded",
    "Downloaded",
  ]);
  expect(rows[0].querySelectorAll(".loader-bar")).toHaveLength(5);
  expect(rows[0].querySelector("time")).toBeNull();
  expect(rows[2].textContent).toContain("newer artist — newer album");
  expect(rows[2].textContent).toContain("audio/flac");
  expect(rows[2].querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(2000).toISOString(),
  );
  expect(rows[3].textContent).toContain("MP3");
  expect(rows[3].textContent).toContain(
    new Intl.NumberFormat(undefined, {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1,
    }).format(5 / 1_000_000),
  );
  expect(cache.tracks.size).toBe(0);
  expect(ensure).not.toHaveBeenCalled();
  expect(rows.every((row) => row.querySelector("button, a, [tabindex]") === null)).toBe(true);
});

it("updates mounted rows when jobs complete and preserves saved entries during restoration and failures", async () => {
  const { target, cache, set } = setup();
  await save(cache, "saved", 1000);
  set({ jobs: [job(cache, "active", "downloading")], loading: true });
  expect(target.querySelector('[role="list"]')?.getAttribute("aria-busy")).toBe("true");
  const savedRow = target.querySelectorAll('[role="listitem"]')[1];
  await save(cache, "active", 2000);
  expect(target.querySelectorAll('[role="listitem"]')).toHaveLength(2);
  const activeRow = target.querySelector('[role="listitem"]');
  set({ jobs: [], loading: false, error: new Error("Transfer interrupted") });
  expect(target.querySelector('[role="listitem"]')).toBe(activeRow);
  expect(target.querySelectorAll('[role="listitem"]')[1]).toBe(savedRow);
  expect(activeRow?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Downloaded");
  expect(target.textContent).toContain("Download failed");
  expect(target.textContent).toContain("Transfer interrupted");
  expect(target.querySelector('[role="list"]')?.getAttribute("aria-busy")).toBe("false");
});

it("shows storage failures without presenting an empty library as successfully restored", async () => {
  const { target, cache, disk } = setup();
  disk.state.failClose = true;
  await expect(
    cache.saveDownload(
      { id: "failed", title: "Failed", artist: "Artist", album: "Album" },
      "mp3",
      "audio/mpeg",
      new Response("audio"),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  flushSync();
  expect(target.textContent).toContain("Local storage needs attention");
  expect(target.textContent).not.toContain("No downloads yet");
  disk.state.failClose = false;
  await save(cache, "recovered", 1000);
  expect(target.textContent).not.toContain("Local storage needs attention");
  expect(target.textContent).toContain("recovered title");
});

it("reflects real engine transfer, queue, completion, and failure states", async () => {
  const { target, trackEngine } = setup(true);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
  const network = new Network();
  trackEngine.setConnection(
    network.accept(network.prepare({ ...account, token: "token", salt: "salt" })).audio,
  );
  const activeResponse = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => activeResponse.promise)
    .mockResolvedValueOnce(new Response("second"));
  vi.stubGlobal("fetch", fetcher);
  const active = trackEngine.download("active");
  const queued = trackEngine.download("waiting");
  flushSync();
  expect(
    [...target.querySelectorAll('[role="listitem"] [role="img"]')].map((node) =>
      node.getAttribute("aria-label"),
    ),
  ).toEqual(["Downloading", "Queued for download"]);
  activeResponse.resolve(new Response("first"));
  await active;
  await queued;
  flushSync();
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(2);
  fetcher.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(trackEngine.download("failed")).rejects.toThrow("The server request failed.");
  flushSync();
  expect(target.textContent).toContain("Download failed");
  expect(target.textContent).toContain("The server request failed.");
  expect(target.querySelectorAll('[aria-label="Downloaded"]')).toHaveLength(2);
  expect(target.textContent).not.toContain("failed title");
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import Player, {
  type PlayerTrack,
  type PlayerSource,
  type PlayerProps,
} from "../src/player.svelte";

class AudioStub extends EventTarget {
  preload = "";
  src = "";
  get currentSrc() {
    return this.src;
  }
  paused = true;
  currentTime = 0;
  duration = 120;
  readyState = 1;
  playbackRate = 1;
  buffered = { length: 0, start: () => 0, end: () => 120 };
  seekable = this.buffered;
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  load() {
    this.currentTime = 0;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const audio = new AudioStub();
  vi.stubGlobal(
    "Audio",
    vi.fn(function () {
      return audio;
    }),
  );
  const release = vi.fn();
  const getSource = vi.fn(async (): Promise<PlayerSource> => ({
    seekMode: "full",
    url: "blob:track",
    release,
  }));
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const session = {
    metadata: null,
    playbackState: "none",
    setPositionState: vi.fn(),
    setActionHandler: vi.fn(
      (action: MediaSessionAction, handler: MediaSessionActionHandler | null) =>
        handlers.set(action, handler),
    ),
  };
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(data: MediaMetadataInit) {
        Object.assign(this, data);
      }
    },
  );
  vi.stubGlobal("navigator", { mediaSession: session });
  const navigation = writable({ previous: true, next: true });
  const availability = fromStore(navigation);
  const props: PlayerProps = {
    get hasPrevious() {
      return availability.current.previous;
    },
    get hasNext() {
      return availability.current.next;
    },
    onprevious: vi.fn(),
    onnext: vi.fn(),
    onposition: vi.fn(),
    onended: vi.fn(),
  };
  const player = mount(Player, { target: document.createElement("div"), props });
  flushSync();
  const detach = () => unmount(player);
  cleanups.push(detach);
  const item: PlayerTrack = { metadata: { title: "A", duration: 300 }, position: 0, getSource };
  return { player, audio, getSource, release, props, item, session, handlers, detach, navigation };
}

class TestElement extends EventTarget {
  constructor(readonly control?: string) {
    super();
  }
  closest(selector: string) {
    return this.control && selector.split(", ").includes(this.control) ? this : null;
  }
}

async function setupShortcuts() {
  const { player, audio, item, detach } = setup();
  await player.play(item);
  player.pause();
  audio.play.mockClear();
  const doc = document;
  vi.stubGlobal("Element", TestElement);
  const toggle = audio.play;
  const dispatch = (
    { handled = false, ...options }: Partial<KeyboardEvent> & { handled?: boolean } = {},
    target = new TestElement(),
  ) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: " ", composedPath: () => [target, doc] }, options);
    if (handled) event.preventDefault();
    doc.dispatchEvent(event);
    return event;
  };
  return { toggle, dispatch, cleanup: detach };
}

describe("Player component", () => {
  describe("keyboard shortcuts", async () => {
    it("toggles playback with Space and prevents scrolling", async () => {
      const { toggle, dispatch } = await setupShortcuts();
      expect(dispatch().defaultPrevented).toBe(true);
      expect(toggle).toHaveBeenCalledOnce();
    });

    it("suppresses scrolling without toggling again on key repeat", async () => {
      const { toggle, dispatch } = await setupShortcuts();
      dispatch();
      expect(dispatch({ repeat: true }).defaultPrevented).toBe(true);
      expect(toggle).toHaveBeenCalledOnce();
    });

    it.each(["button", "a[href]", '[role="button"]'])(
      "uses Space for playback on %s but leaves Enter alone",
      async (control) => {
        const { toggle, dispatch } = await setupShortcuts();
        const target = new TestElement(control);
        expect(dispatch({}, target).defaultPrevented).toBe(true);
        expect(toggle).toHaveBeenCalledOnce();
        expect(dispatch({ key: "Enter" }, target).defaultPrevented).toBe(false);
        expect(toggle).toHaveBeenCalledOnce();
      },
    );

    it.each([
      "input",
      "textarea",
      "select",
      "summary",
      "audio",
      "video",
      '[contenteditable]:not([contenteditable="false"])',
      '[role="slider"]',
      '[role="textbox"]',
    ])("preserves keyboard interaction on %s", async (control) => {
      const { toggle, dispatch } = await setupShortcuts();
      expect(dispatch({}, new TestElement(control)).defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    });

    it.each([
      { key: "Enter" },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { shiftKey: true },
      { isComposing: true },
    ])("ignores other keys, modified shortcuts, and composition: %j", async (options) => {
      const { toggle, dispatch } = await setupShortcuts();
      expect(dispatch(options).defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    });

    it("respects already handled events and removes its listener on cleanup", async () => {
      const { toggle, dispatch, cleanup } = await setupShortcuts();
      dispatch({ handled: true });
      expect(toggle).not.toHaveBeenCalled();
      await cleanup();
      expect(dispatch().defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    });
  });

  it("uses Space to pause/resume only a loaded track", async () => {
    const { player, audio, item, getSource } = setup();
    const space = () => {
      const event = new KeyboardEvent("keydown", { key: " ", cancelable: true });
      document.dispatchEvent(event);
      return event;
    };
    expect(space().defaultPrevented).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
    await player.play(item);
    expect(space().defaultPrevented).toBe(true);
    expect(player.playing).toBe(false);
    expect(space().defaultPrevented).toBe(true);
    expect(player.playing).toBe(true);
    expect(getSource).toHaveBeenCalledOnce();
    player.unload();
    expect(space().defaultPrevented).toBe(false);
  });

  it("pauses a pending load with Space and ignores its late source", async () => {
    const { player, audio, item, getSource } = setup();
    let resolve!: (source: PlayerSource) => void;
    getSource.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = player.play(item);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", cancelable: true }));
    const release = vi.fn();
    resolve({ url: "blob:late", seekMode: "full", release });
    await pending;
    expect(audio.play).not.toHaveBeenCalled();
    expect(player.playing).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("plays a supplied item and reports progress and completion", async () => {
    const { player, audio, getSource, props, item } = setup();
    await player.play(item);
    expect(player.playing).toBe(true);
    audio.currentTime = 12;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(props.onposition).toHaveBeenLastCalledWith(12);
    expect(player.position).toBe(12);
    audio.dispatchEvent(new Event("ended"));
    expect(player.status).toBe("ended");
    expect(player.playing).toBe(false);
    expect(props.onended).toHaveBeenCalledOnce();
    expect(getSource).toHaveBeenCalledOnce();
  });

  it("resumes without a new item and starts fresh on every explicit play", async () => {
    const { player, audio, getSource, release, item } = setup();
    await player.resume();
    expect(getSource).not.toHaveBeenCalled();
    await player.play(item);
    audio.currentTime = 12;
    audio.dispatchEvent(new Event("timeupdate"));
    player.pause();
    await player.resume();
    expect(player.position).toBe(12);
    expect(getSource).toHaveBeenCalledOnce();
    await player.play(item);
    expect(player.position).toBe(0);
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves pause intent while seeking and translates offset-stream time", async () => {
    const { player, audio, getSource, props, item } = setup();
    getSource.mockResolvedValue({
      seekMode: "buffered",
      url: "https://music/offset",
      offset: 80,
      release() {},
    });
    await player.play({ ...item, position: 85 });
    expect(audio.currentTime).toBe(5);
    player.pause();
    await player.seek(89);
    expect(player.position).toBe(89);
    expect(player.playing).toBe(false);
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(player.duration).toBe(300);
    audio.currentTime = 10;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(props.onposition).toHaveBeenLastCalledWith(90);
  });

  it("releases obsolete sources without releasing the current source", async () => {
    const { player, audio, getSource, release, item } = setup();
    let resolve!: (source: PlayerSource) => void;
    getSource.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = player.play(item);
    const oldSignal = (getSource.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal;
    await player.play(item);
    const obsoleteRelease = vi.fn();
    resolve({ seekMode: "full", url: "blob:obsolete", release: obsoleteRelease });
    await pending;
    expect(oldSignal.aborted).toBe(true);
    expect(obsoleteRelease).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(audio.src).toBe("blob:track");
    expect(player.playing).toBe(true);
  });

  it("owns Media Session controls and clears them on teardown", async () => {
    const { player, audio, item, props, session, handlers, release, detach } = setup();
    await player.play(item);
    expect(session.metadata).toMatchObject({ title: "A" });
    handlers.get("pause")?.({ action: "pause" });
    expect(player.playing).toBe(false);
    handlers.get("play")?.({ action: "play" });
    expect(audio.play).toHaveBeenCalledTimes(2);
    handlers.get("nexttrack")?.({ action: "nexttrack" });
    handlers.get("previoustrack")?.({ action: "previoustrack" });
    expect(props.onnext).toHaveBeenCalledOnce();
    expect(props.onprevious).toHaveBeenCalledOnce();
    await detach();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(handlers.get("play")).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it("updates navigation availability without reloading the item", async () => {
    const { player, item, getSource, handlers, navigation } = setup();
    await player.play(item);
    navigation.set({ previous: false, next: false });
    flushSync();
    expect(handlers.get("nexttrack")).toBeNull();
    expect(handlers.get("previoustrack")).toBeNull();
    navigation.set({ previous: true, next: true });
    flushSync();
    expect(handlers.get("nexttrack")).toEqual(expect.any(Function));
    expect(handlers.get("previoustrack")).toEqual(expect.any(Function));
    expect(getSource).toHaveBeenCalledOnce();
  });

  it("releases a late source after component teardown", async () => {
    const { player, item, getSource, detach, audio } = setup();
    let resolve!: (source: PlayerSource) => void;
    getSource.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = player.play(item);
    await detach();
    const release = vi.fn();
    resolve({ seekMode: "full", url: "blob:late", release });
    await pending;
    expect(release).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.src).toBe("");
  });

  it("releases the unsupported source before keeping a transcoded replacement", async () => {
    const { player, item, getSource, release, audio } = setup();
    const rawRelease = vi.fn();
    getSource.mockResolvedValueOnce({
      seekMode: "seekable",
      url: "https://music/raw",
      release: rawRelease,
    });
    audio.play.mockRejectedValueOnce(new DOMException("Unsupported format", "NotSupportedError"));
    await player.play(item);
    expect(getSource).toHaveBeenLastCalledWith(expect.objectContaining({ forceTranscode: true }));
    expect(rawRelease).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(player.playing).toBe(true);
    player.unload();
    expect(release).toHaveBeenCalledOnce();
  });

  it("exposes only read-only transport state", async () => {
    const { player, item, audio } = setup();
    await player.play(item);
    for (const key of ["position", "duration", "playing", "status", "error"] as const) {
      expect(Object.getOwnPropertyDescriptor(player, key)?.set).toBeUndefined();
      expect(Reflect.set(player, key, "invalid")).toBe(false);
    }
    expect(player.position).toBe(0);
    expect(audio.currentTime).toBe(0);
    expect(player.playing).toBe(true);
    expect(player.status).toBe("ready");
  });

  it("preserves ended status on pause so resume restarts from zero", async () => {
    const { player, item, audio, getSource } = setup();
    await player.play(item);
    audio.currentTime = 120;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("ended"));
    player.pause();
    expect(player.status).toBe("ended");
    await player.resume();
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(getSource).toHaveBeenLastCalledWith(expect.objectContaining({ position: 0 }));
    expect(player.position).toBe(0);
    expect(player.playing).toBe(true);
  });

  it("settles failures in state and preserves error status until resume retries", async () => {
    const { player, item, audio, getSource } = setup();
    const failure = new Error("Playback failed");
    audio.play.mockRejectedValueOnce(failure);
    await expect(player.play(item)).resolves.toBeUndefined();
    expect(player.error).toBe(failure);
    player.pause();
    expect(player.status).toBe("error");
    expect(player.error).toBe(failure);
    await player.resume();
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(player.playing).toBe(true);
    expect(player.status).toBe("ready");
    expect(player.error).toBeUndefined();
  });

  it("continues replacement and teardown when provider cleanup throws", async () => {
    const { player, item, audio, release, detach, session, handlers } = setup();
    release.mockImplementation(() => {
      throw new Error("Cleanup failed");
    });
    await player.play(item);
    await expect(player.play(item)).resolves.toBeUndefined();
    expect(player.playing).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    await expect(detach()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    expect(player.status).toBe("idle");
    expect(player.position).toBe(0);
    expect(player.error).toBeUndefined();
    expect(audio.src).toBe("");
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect([...handlers.values()].every((handler) => handler === null)).toBe(true);
  });

  it("contains cleanup failures from obsolete results", async () => {
    const { player, item, getSource } = setup();
    let resolve!: (source: PlayerSource) => void;
    getSource.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const old = player.play(item);
    await player.play(item);
    const release = vi.fn(() => {
      throw new Error("Obsolete cleanup failed");
    });
    resolve({ url: "blob:obsolete", seekMode: "full", release });
    await expect(old).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(player.playing).toBe(true);
    expect(player.error).toBeUndefined();
  });

  it("reports buffering separately while the transport remains unpaused", async () => {
    const { player, audio, item } = setup();
    await player.play(item);
    audio.dispatchEvent(new Event("waiting"));
    expect(player.playing).toBe(true);
    expect(player.status).toBe("buffering");
    audio.dispatchEvent(new Event("canplay"));
    expect(player.status).toBe("ready");
    player.pause();
    expect(player.playing).toBe(false);
  });

  it.each([
    ["full", false, false, 1],
    ["seekable", false, true, 1],
    ["seekable", false, false, 2],
    ["buffered", true, false, 1],
    ["buffered", false, true, 2],
  ] as const)(
    "uses %s seeking with buffered=%s and seekable=%s",
    async (seekMode, buffered, seekable, calls) => {
      const { player, audio, item, getSource } = setup();
      getSource.mockResolvedValue({ url: "https://music/source", seekMode, release() {} });
      audio.buffered = { length: buffered ? 1 : 0, start: () => 0, end: () => 120 };
      audio.seekable = { length: seekable ? 1 : 0, start: () => 0, end: () => 120 };
      await player.play(item);
      player.pause();
      await player.seek(60);
      expect(getSource).toHaveBeenCalledTimes(calls);
      expect(player.position).toBe(60);
      expect(player.playing).toBe(false);
    },
  );

  it.each(["full", "buffered"] as const)(
    "reports an unchanged seek result only once with %s seeking",
    async (seekMode) => {
      const { player, item, getSource, props, session } = setup();
      getSource.mockResolvedValue({ url: "https://music/source", seekMode, release() {} });
      await player.play(item);
      vi.mocked(props.onposition!).mockClear();
      session.setPositionState.mockClear();
      await player.seek(60);
      expect(props.onposition).toHaveBeenCalledExactlyOnceWith(60);
      if (seekMode === "full") expect(session.setPositionState).toHaveBeenCalledOnce();
    },
  );

  it("still reports a corrected position when loaded audio clamps the requested seek", async () => {
    const { player, item, getSource, props, audio } = setup();
    getSource.mockResolvedValue({
      url: "https://music/source",
      seekMode: "buffered",
      release() {},
    });
    await player.play(item);
    vi.mocked(props.onposition!).mockClear();
    audio.duration = 30;
    await player.seek(60);
    expect(vi.mocked(props.onposition!).mock.calls).toEqual([[60], [30]]);
    expect(player.position).toBe(30);
  });

  it("does not re-register navigation during progress or buffering updates", async () => {
    const { player, item, audio, session, navigation, handlers } = setup();
    await player.play(item);
    flushSync();
    session.setActionHandler.mockClear();
    audio.currentTime = 12;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("waiting"));
    audio.dispatchEvent(new Event("canplay"));
    expect(session.setActionHandler).not.toHaveBeenCalled();
    navigation.set({ previous: false, next: false });
    flushSync();
    expect(session.setActionHandler).toHaveBeenCalledTimes(2);
    expect(handlers.get("nexttrack")).toBeNull();
    expect(handlers.get("previoustrack")).toBeNull();
  });

  it("unloads completely and makes resume a no-op", async () => {
    const { player, audio, getSource, item, session, release } = setup();
    await player.play(item);
    player.unload();
    await player.resume();
    expect(player.status).toBe("idle");
    expect(player.position).toBe(0);
    expect(player.duration).toBe(0);
    expect(audio.src).toBe("");
    expect(session.metadata).toBeNull();
    expect(getSource).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

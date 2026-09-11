<script module lang="ts">
  export type PlaybackStatus =
    | "idle"
    | "loading"
    | "ready"
    | "buffering"
    | "seeking"
    | "ended"
    | "error";
  export interface PlayerSource {
    url: string;
    offset?: number;
    /** full: any position; seekable: browser ranges; buffered: buffered ranges only. */
    seekMode: "full" | "seekable" | "buffered";
    /** Owns only this result. Called once when replaced, unloaded, or returned too late. */
    release(): void;
  }
  export interface PlayerTrack {
    metadata: {
      title: string;
      artist?: string;
      album?: string;
      artwork?: string;
      duration?: number;
    };
    position?: number;
    /** Abort cancels the request, not an already-returned source's lifetime.
     * Even an aborted request may resolve; Player releases its result without adopting it.
     * Each result must own independent cleanup, never release a newer result's resources.
     */
    getSource(options: {
      position: number;
      forceTranscode: boolean;
      signal: AbortSignal;
    }): Promise<PlayerSource>;
  }
  export interface PlayerProps {
    hasPrevious?: boolean;
    hasNext?: boolean;
    onprevious?: () => void;
    onnext?: () => void;
    onposition?: (seconds: number) => void;
    onended?: () => void;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";

  const interactive =
    'input, textarea, select, summary, audio, video, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="textbox"]';

  let {
    hasPrevious = false,
    hasNext = false,
    onprevious,
    onnext,
    onposition,
    onended,
  }: PlayerProps = $props();
  let audio: HTMLAudioElement | undefined;
  let media: MediaSession | undefined;
  let metadataGeneration = 0;
  let track = $state.raw<PlayerTrack>();
  let source: PlayerSource | undefined;
  let currentPosition = $state(0);
  const position = $derived(currentPosition);
  let measuredDuration = $state(0);
  const duration = $derived(
    measuredDuration > 0 ? measuredDuration : (track?.metadata.duration ?? 0),
  );
  let isPlaying = $state(false);
  // Playing means the audio transport is not paused. Buffering may still prevent
  // audible progress; status distinguishes that from ready playback.
  const playing = $derived(isPlaying);
  let currentStatus = $state<PlaybackStatus>("idle");
  const status = $derived(currentStatus);
  let currentError = $state.raw<unknown>();
  const error = $derived(currentError);
  export { position, duration, playing, status, error };
  let intent = false;
  let forced = false;
  let generation = 0;
  let abort: AbortController | undefined;

  function setPosition(seconds: number) {
    currentPosition = seconds;
    onposition?.(seconds);
    syncMediaSession();
  }
  function release(result: PlayerSource | undefined) {
    try {
      result?.release();
    } catch {
      // Cleanup is best effort. A provider failure must not prevent replacing a
      // track or finishing audio/Media Session teardown.
    }
  }
  function clearSource() {
    audio?.removeAttribute("src");
    audio?.load();
    const previous = source;
    source = undefined;
    release(previous);
  }
  function setMediaAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    try {
      media?.setActionHandler(action, handler);
    } catch {
      // Not every browser supports every action.
    }
  }
  function syncNavigation(next: boolean, previous: boolean) {
    if (!media) return;
    setMediaAction("nexttrack", next ? () => onnext?.() : null);
    setMediaAction("previoustrack", previous ? () => onprevious?.() : null);
  }
  async function syncMetadata() {
    const generation = ++metadataGeneration;
    const session = media;
    if (!session) return;
    const metadata = track?.metadata;
    const artwork = metadata?.artwork;
    const text = metadata && {
      title: metadata.title,
      artist: metadata.artist ?? "Unknown artist",
      album: metadata.album ?? "Unknown album",
    };
    try {
      const local = artwork?.startsWith("blob:");
      session.metadata = text
        ? new MediaMetadata({ ...text, artwork: artwork && !local ? [{ src: artwork }] : [] })
        : null;
      if (!text || !local || !artwork) return;
      // OS artwork loading can outlive a document-owned URL. Read only the
      // already-cached blob and give the OS self-contained bytes.
      const response = await fetch(artwork);
      if (!response.ok) return;
      const blob = await response.blob();
      if (!blob.size) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
      if (generation !== metadataGeneration) return;
      session.metadata = new MediaMetadata({
        ...text,
        artwork: [{ src: `data:${blob.type || "image/jpeg"};base64,${encoded}` }],
      });
    } catch {
      // Unavailable artwork or metadata support must not affect playback.
    }
  }
  function syncMediaSession() {
    if (!media) return;
    try {
      media.playbackState = !track ? "none" : playing ? "playing" : "paused";
    } catch {
      /* Optional browser API. */
    }
    const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const rate = audio?.playbackRate ?? 1;
    try {
      media.setPositionState(
        length
          ? {
              duration: length,
              position: Number.isFinite(position) ? Math.min(length, Math.max(0, position)) : 0,
              playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
            }
          : undefined,
      );
    } catch {
      /* Optional browser API. */
    }
  }
  $effect(() => {
    syncNavigation(hasNext, hasPrevious);
  });
  function invalidate() {
    generation++;
    abort?.abort();
    abort = undefined;
  }

  onMount(() => {
    media = navigator.mediaSession;
    const mediaSeek = (seconds: number) => {
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(seconds))
        void seek(Math.min(duration, Math.max(0, seconds)));
    };
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        void resume();
      },
      pause,
      seekto: ({ seekTime }) => {
        if (seekTime !== undefined) mediaSeek(seekTime);
      },
      seekbackward: ({ seekOffset }) => mediaSeek(position - (seekOffset ?? 10)),
      seekforward: ({ seekOffset }) => mediaSeek(position + (seekOffset ?? 10)),
    };
    const mediaActions = Object.keys(actions) as MediaSessionAction[];
    for (const action of mediaActions) setMediaAction(action, actions[action]!);
    syncNavigation(hasNext, hasPrevious);
    mediaActions.push("nexttrack", "previoustrack");
    const element = new Audio();
    audio = element;
    element.preload = "metadata";
    syncMediaSession();
    const onTime = () => {
      if (!track || !element.currentSrc) return;
      setPosition(
        (source?.offset ?? 0) + (Number.isFinite(element.currentTime) ? element.currentTime : 0),
      );
    };
    const onMetadata = () => {
      if (!track || !element.currentSrc) return;
      const offset = source?.offset ?? 0;
      measuredDuration =
        offset > 0
          ? (track?.metadata.duration ??
            (Number.isFinite(element.duration) ? offset + element.duration : 0))
          : Number.isFinite(element.duration)
            ? element.duration
            : 0;
      syncMediaSession();
    };
    const events: Record<string, () => void> = {
      timeupdate: onTime,
      loadedmetadata: onMetadata,
      durationchange: onMetadata,
      ratechange: syncMediaSession,
      playing: () => {
        if (!intent) {
          element.pause();
          return;
        }
        isPlaying = true;
        currentStatus = "ready";
        syncMediaSession();
      },
      pause: () => {
        isPlaying = false;
        syncMediaSession();
      },
      waiting: () => {
        if (intent && status === "ready") currentStatus = "buffering";
      },
      canplay: () => {
        if (status === "buffering") currentStatus = "ready";
      },
      ended: () => {
        if (!element.currentSrc || !intent) return;
        intent = false;
        isPlaying = false;
        currentStatus = "ended";
        onended?.();
        syncMediaSession();
      },
      error: () => {
        if (!element.currentSrc || status === "loading" || status === "seeking") return;
        if (element.error?.code === 4 && !forced) {
          void load(position, intent, true);
        } else fail(new Error(element.error?.message || "The track could not be played."));
      },
    };
    for (const [event, handler] of Object.entries(events)) element.addEventListener(event, handler);
    const keydown = (event: KeyboardEvent) => {
      if (
        !track ||
        event.key !== " " ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (
        event
          .composedPath()
          .some((target) => target instanceof Element && target.closest(interactive))
      )
        return;
      event.preventDefault();
      if (event.repeat) return;
      if (intent) pause();
      else void resume();
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      for (const [event, handler] of Object.entries(events))
        element.removeEventListener(event, handler);
      unload();
      for (const action of mediaActions) setMediaAction(action, null);
      media = undefined;
      audio = undefined;
    };
  });

  function fail(cause: unknown) {
    invalidate();
    intent = false;
    audio?.pause();
    currentError = cause;
    currentStatus = "error";
    isPlaying = false;
    syncMediaSession();
  }

  function metadata(element: HTMLAudioElement, signal: AbortSignal) {
    if (element.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        element.removeEventListener("loadedmetadata", loaded);
        element.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new DOMException("The audio format is unsupported.", "NotSupportedError"));
      };
      const aborted = () => {
        cleanup();
        reject(new DOMException("Playback cancelled.", "AbortError"));
      };
      element.addEventListener("loadedmetadata", loaded);
      element.addEventListener("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  async function load(
    position: number,
    autoplay: boolean,
    forceTranscode = false,
    seeking = false,
  ) {
    const element = audio;
    const current = track;
    if (!element || !current) return;

    invalidate();
    element.pause();
    clearSource();
    const request = generation;
    const controller = new AbortController();
    abort = controller;
    intent = autoplay;
    currentError = undefined;
    currentStatus = seeking ? "seeking" : "loading";
    const valid = () => request === generation && audio === element;
    setPosition(position);
    if (!valid()) return;
    const prepare = async (transcode: boolean) => {
      const nextSource = await current.getSource({
        forceTranscode: transcode,
        position,
        signal: controller.signal,
      });
      if (!valid()) {
        release(nextSource);
        return;
      }
      source = nextSource;
      const offset = source.offset ?? 0;
      measuredDuration = 0;
      forced = transcode || offset > 0;
      element.src = source.url;
      if (position > 0) {
        await metadata(element, controller.signal);
        if (!valid()) return;
        element.currentTime = Math.min(
          Math.max(0, position - offset),
          Number.isFinite(element.duration) ? element.duration : position,
        );
        const actualPosition = offset + element.currentTime;
        if (actualPosition !== position) setPosition(actualPosition);
        if (!valid()) return;
      }
      if (autoplay && intent) await element.play();
      if (!valid()) return;
      currentStatus = "ready";
      isPlaying = !element.paused;
    };
    try {
      try {
        await prepare(forceTranscode);
      } catch (error) {
        if (!valid()) return;
        if (
          forceTranscode ||
          !(error instanceof Error) ||
          !(error.name === "NotSupportedError" || /supported sources/i.test(error.message))
        )
          throw error;
        clearSource();
        await prepare(true);
      }
      if (!valid()) return;

      syncMediaSession();
    } catch (error) {
      if (valid()) fail(error);
    }
  }

  /** Start a fresh track. Transport failures are exposed through status/error,
   * not rejected promises. Resolution means the attempt settled, including
   * cancellation/supersession; it does not guarantee that audio is playing.
   * Commands before mount or after teardown are no-ops.
   */
  export async function play(next: PlayerTrack) {
    if (!audio) return;
    unload();
    track = { ...next, metadata: { ...next.metadata } };
    currentPosition = Number.isFinite(next.position) ? Math.max(0, next.position ?? 0) : 0;
    void syncMetadata();
    await load(position, true);
  }

  /** Resume the loaded track, or restart after end/retry after error.
   * Uses the same promise semantics as play(); no loaded track is a no-op.
   */
  export async function resume() {
    if (!audio || !track) return;
    if (status === "loading" || status === "seeking") {
      await load(position, true, forced, status === "seeking");
      return;
    }
    if (!audio.currentSrc || status === "error" || status === "ended") {
      await load(status === "ended" ? 0 : position, true);
      return;
    }
    intent = true;
    const request = generation;
    try {
      await audio.play();
    } catch (error) {
      if (request === generation) fail(error);
    }
  }

  export function pause() {
    invalidate();
    intent = false;
    audio?.pause();
    if (status === "loading" || status === "seeking") {
      clearSource();
    }
    isPlaying = false;
    if (status !== "ended" && status !== "error") currentStatus = track ? "ready" : "idle";
    syncMediaSession();
  }

  /** Seek in full-track seconds, preserving play/pause intent. Transport
   * failures and cancellation settle as in play(); non-finite inputs are ignored.
   */
  export async function seek(target: number) {
    if (!Number.isFinite(target) || !audio || !track) return;
    target = Math.max(0, duration > 0 ? Math.min(target, duration) : target);
    const element = audio;
    const offset = source?.offset ?? 0;
    const seekMode = source?.seekMode ?? "buffered";
    const contains = (ranges: TimeRanges) => {
      const relative = target - offset;
      for (let i = 0; i < ranges.length; i++) {
        if (relative >= ranges.start(i) && relative <= ranges.end(i)) return true;
      }
      return false;
    };
    const buffered = contains(element.buffered);
    const seekable = seekMode === "seekable" && contains(element.seekable);
    if (
      element.currentSrc &&
      (seekMode === "full" || buffered || seekable) &&
      status !== "loading" &&
      status !== "seeking"
    ) {
      try {
        element.currentTime = target - offset;
        setPosition(target);
        return;
      } catch (error) {
        if (seekMode === "full") {
          fail(error);
          return;
        }
        // A server/browser may reject a seek despite advertising a range.
      }
    }
    await load(target, intent, false, true);
  }

  export function unload() {
    invalidate();
    intent = false;
    audio?.pause();
    clearSource();
    forced = false;
    isPlaying = false;
    measuredDuration = 0;
    currentStatus = "idle";
    track = undefined;
    currentPosition = 0;
    currentError = undefined;
    void syncMetadata();
    syncMediaSession();
  }
</script>

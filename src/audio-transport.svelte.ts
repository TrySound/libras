export type PlaybackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "buffering"
  | "seeking"
  | "ended"
  | "error";
export interface PlayerState {
  readonly status: PlaybackStatus;
  readonly playing: boolean;
}
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
    /** May be a reactive getter; text metadata is snapshotted at play time. */
    readonly artwork?: string;
    duration?: number;
  };
  position?: number;
  /** Abort cancels acquisition, not a returned source's lifetime. Late results
   * must own independent cleanup, never a newer result's resources. */
  getSource(options: {
    position: number;
    forceTranscode: boolean;
    signal: AbortSignal;
  }): Promise<PlayerSource>;
}
export interface TransportCallbacks {
  onposition?: (seconds: number) => void;
  onended?: () => void;
  onstatechange?: (state: PlayerState) => void;
}

/** One native audio element. Create on the client; dispose independently of any
 * presentation or browser-control binding. Commands settle failures in state. */
export class AudioTransport {
  #audio: HTMLAudioElement | undefined;
  #callbacks: TransportCallbacks;
  #track = $state.raw<PlayerTrack>();
  #source: PlayerSource | undefined;
  #position = $state(0);
  #measuredDuration = $state(0);
  #playing = $state(false);
  #status = $state<PlaybackStatus>("idle");
  #error = $state.raw<unknown>();
  #intent = false;
  #forced = false;
  #generation = 0;
  #abort: AbortController | undefined;
  #publishedState: PlayerState = { status: "idle", playing: false };
  #removeEvents: () => void;
  #rate = $state(1);
  #disposed = false;

  get position() {
    return this.#position;
  }
  get duration() {
    return this.#measuredDuration > 0
      ? this.#measuredDuration
      : (this.#track?.metadata.duration ?? 0);
  }
  get playing() {
    return this.#playing;
  }
  get status() {
    return this.#status;
  }
  get error() {
    return this.#error;
  }
  get metadata(): Readonly<PlayerTrack["metadata"]> | undefined {
    return this.#track?.metadata;
  }
  get playbackRate() {
    return this.#rate;
  }

  constructor(callbacks: TransportCallbacks = {}) {
    this.#callbacks = callbacks;
    const element = new Audio();
    this.#audio = element;
    element.preload = "metadata";
    const onTime = () => {
      if (!this.#track || !element.currentSrc) return;
      this.#setPosition(
        (this.#source?.offset ?? 0) +
          (Number.isFinite(element.currentTime) ? element.currentTime : 0),
      );
    };
    const onMetadata = () => {
      if (!this.#track || !element.currentSrc) return;
      const offset = this.#source?.offset ?? 0;
      this.#measuredDuration =
        offset > 0
          ? (this.#track.metadata.duration ??
            (Number.isFinite(element.duration) ? offset + element.duration : 0))
          : Number.isFinite(element.duration)
            ? element.duration
            : 0;
    };
    const events: Record<string, () => void> = {
      timeupdate: onTime,
      loadedmetadata: onMetadata,
      durationchange: onMetadata,
      ratechange: () => {
        this.#rate = element.playbackRate;
      },
      playing: () => {
        if (!this.#intent) {
          element.pause();
          return;
        }
        this.#playing = true;
        this.#status = "ready";
        this.#publishState();
      },
      pause: () => {
        if (!element.paused || !this.#playing) return;
        this.#playing = false;
        this.#publishState();
      },
      waiting: () => {
        if (this.#intent && this.status === "ready") this.#status = "buffering";
        this.#publishState();
      },
      canplay: () => {
        if (this.status === "buffering") this.#status = "ready";
        this.#publishState();
      },
      ended: () => {
        if (!element.currentSrc || !this.#intent) return;
        this.#intent = false;
        this.#playing = false;
        this.#status = "ended";
        this.#publishState();
        this.#callbacks.onended?.();
      },
      error: () => {
        if (!element.currentSrc || this.status === "loading" || this.status === "seeking") return;
        if (element.error?.code === 4 && !this.#forced)
          void this.#load(this.position, this.#intent, true);
        else this.#fail(new Error(element.error?.message || "The track could not be played."));
      },
    };
    for (const [event, handler] of Object.entries(events)) element.addEventListener(event, handler);
    this.#removeEvents = () => {
      for (const [event, handler] of Object.entries(events))
        element.removeEventListener(event, handler);
    };
  }

  #publishState() {
    if (
      this.#publishedState.status === this.status &&
      this.#publishedState.playing === this.playing
    )
      return;
    this.#publishedState = { status: this.status, playing: this.playing };
    this.#callbacks.onstatechange?.(this.#publishedState);
  }
  #pauseAudio() {
    // Internal transitions publish their final state, not an intermediate native pause.
    this.#playing = false;
    this.#audio?.pause();
  }
  #setPosition(seconds: number) {
    this.#position = seconds;
    this.#callbacks.onposition?.(seconds);
  }
  #release(result: PlayerSource | undefined) {
    try {
      result?.release();
    } catch {
      /* Provider cleanup must not prevent replacement or teardown. */
    }
  }
  #clearSource() {
    this.#audio?.removeAttribute("src");
    this.#audio?.load();
    const previous = this.#source;
    this.#source = undefined;
    this.#release(previous);
  }
  #invalidate() {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = undefined;
  }
  #fail(cause: unknown) {
    this.#invalidate();
    this.#intent = false;
    this.#pauseAudio();
    this.#error = cause;
    this.#status = "error";
    this.#publishState();
  }
  #metadata(element: HTMLAudioElement, signal: AbortSignal) {
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
  async #load(position: number, autoplay: boolean, forceTranscode = false, seeking = false) {
    const element = this.#audio;
    const current = this.#track;
    if (!element || !current) return;
    this.#invalidate();
    this.#pauseAudio();
    this.#clearSource();
    const request = this.#generation;
    const controller = new AbortController();
    this.#abort = controller;
    this.#intent = autoplay;
    this.#error = undefined;
    this.#status = seeking ? "seeking" : "loading";
    const valid = () => !this.#disposed && request === this.#generation && this.#audio === element;
    this.#publishState();
    if (!valid()) return;
    this.#setPosition(position);
    if (!valid()) return;
    const prepare = async (transcode: boolean) => {
      const nextSource = await current.getSource({
        forceTranscode: transcode,
        position,
        signal: controller.signal,
      });
      if (!valid()) {
        this.#release(nextSource);
        return;
      }
      this.#source = nextSource;
      const offset = nextSource.offset ?? 0;
      this.#measuredDuration = 0;
      this.#forced = transcode || offset > 0;
      element.src = nextSource.url;
      if (position > 0) {
        await this.#metadata(element, controller.signal);
        if (!valid()) return;
        element.currentTime = Math.min(
          Math.max(0, position - offset),
          Number.isFinite(element.duration) ? element.duration : position,
        );
        const actualPosition = offset + element.currentTime;
        if (actualPosition !== position) this.#setPosition(actualPosition);
        if (!valid()) return;
      }
      if (autoplay && this.#intent) await element.play();
      if (!valid()) return;
      this.#status = "ready";
      this.#playing = !element.paused;
      this.#publishState();
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
        this.#clearSource();
        await prepare(true);
      }
    } catch (error) {
      if (valid()) this.#fail(error);
    }
  }

  /** Start fresh. Resolution means settled (including cancellation), not success.
   * Commands after disposal are no-ops. */
  async play(next: PlayerTrack) {
    if (this.#disposed || !this.#audio) return;
    this.#unload();
    if (this.#disposed) return;
    this.#track = {
      ...next,
      metadata: {
        ...next.metadata,
        get artwork() {
          return next.metadata.artwork;
        },
      },
    };
    this.#position = Number.isFinite(next.position) ? Math.max(0, next.position ?? 0) : 0;
    await this.#load(this.position, true);
  }
  /** Resume, restart after end, or retry after error; same settlement as play(). */
  async resume() {
    if (this.#disposed || !this.#audio || !this.#track) return;
    if (this.status === "loading" || this.status === "seeking") {
      await this.#load(this.position, true, this.#forced, this.status === "seeking");
      return;
    }
    // Native currentSrc may still name a retired resource after removeAttribute/load.
    if (
      !this.#source ||
      !this.#audio.currentSrc ||
      this.status === "error" ||
      this.status === "ended"
    ) {
      await this.#load(this.status === "ended" ? 0 : this.position, true);
      return;
    }
    this.#intent = true;
    const request = this.#generation;
    try {
      await this.#audio.play();
    } catch (error) {
      if (request === this.#generation) this.#fail(error);
    }
  }
  pause() {
    if (this.#disposed || !this.#audio) return;
    this.#invalidate();
    this.#intent = false;
    this.#pauseAudio();
    if (this.status === "loading" || this.status === "seeking") this.#clearSource();
    if (this.status !== "ended" && this.status !== "error")
      this.#status = this.#track ? "ready" : "idle";
    this.#publishState();
  }
  /** Seek in full-track seconds, preserving play/pause intent. */
  async seek(target: number) {
    if (this.#disposed || !Number.isFinite(target) || !this.#audio || !this.#track) return;
    target = Math.max(0, this.duration > 0 ? Math.min(target, this.duration) : target);
    const element = this.#audio;
    const offset = this.#source?.offset ?? 0;
    const seekMode = this.#source?.seekMode ?? "buffered";
    const contains = (ranges: TimeRanges) => {
      const relative = target - offset;
      for (let i = 0; i < ranges.length; i++)
        if (relative >= ranges.start(i) && relative <= ranges.end(i)) return true;
      return false;
    };
    const buffered = contains(element.buffered);
    const seekable = seekMode === "seekable" && contains(element.seekable);
    if (
      element.currentSrc &&
      (seekMode === "full" || buffered || seekable) &&
      this.status !== "loading" &&
      this.status !== "seeking"
    ) {
      try {
        element.currentTime = target - offset;
        this.#setPosition(target);
        return;
      } catch (error) {
        if (seekMode === "full") {
          this.#fail(error);
          return;
        }
      }
    }
    await this.#load(target, this.#intent, false, true);
  }
  /** Background Space uses intent even before the first source arrives. */
  toggle() {
    if (!this.#track) return;
    if (this.#intent) this.pause();
    else void this.resume();
  }
  unload() {
    this.#unload();
  }
  #unload() {
    this.#invalidate();
    this.#intent = false;
    this.#pauseAudio();
    this.#clearSource();
    this.#forced = false;
    this.#measuredDuration = 0;
    this.#status = "idle";
    this.#track = undefined;
    this.#position = 0;
    this.#error = undefined;
    this.#publishState();
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeEvents();
    this.unload();
    this.#audio = undefined;
  }
}

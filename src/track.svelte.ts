import type { AudioConnection } from "./network.svelte";
import { downloadKey, type Cache, type CacheSelection, type DownloadFormat } from "./cache.svelte";
import type { Account, DownloadTrack } from "./schema";

interface EngineTrack {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  contentType?: string;
}
export interface TrackSource {
  cached: boolean;
  url: string;
  offset?: number;
  nativeSeeking?: boolean;
  /** Releases only this result; other source handles remain valid. */
  release(): void;
}
interface TrackSourceOptions {
  forceTranscode?: boolean;
}
type TrackStatus = "idle" | "queued" | "downloading" | "downloaded";
interface TrackEngineOptions {
  selection: CacheSelection;
  connection?: AudioConnection;
  concurrency?: number;
}
type Descriptor = Readonly<Account> & { key: string; format: DownloadFormat; contentType: string };
type DownloadJobInfo = Descriptor & { track: DownloadTrack; status: "queued" | "downloading" };
interface DownloadJob {
  descriptor: Descriptor;
  connection: AudioConnection;
  cache: Cache;
  signal: AbortSignal;
  track: DownloadTrack;
  status: "queued" | "downloading";
  controller: AbortController;
  promise: Promise<File>;
  resolve: (file: File) => void;
  reject: (error: unknown) => void;
}

/** Scheduling and playback resources. Cache owns all completed records and bytes. */
export class TrackEngine {
  #sourceReleases = new Set<() => void>();
  #connection?: AudioConnection;
  #jobs = new Map<string, DownloadJob>();
  #selection: CacheSelection;
  #concurrency: number;
  #destroyed = false;
  #error = $state.raw<unknown>();
  #mediaProbe = document.createElement("audio");
  #sourceController = new AbortController();
  #version = $state(0);

  constructor(options: TrackEngineOptions) {
    this.#selection = options.selection;
    this.#concurrency = options.concurrency ?? 3;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1)
      throw new Error("Download concurrency must be a positive integer.");
    if (options.connection) this.setConnection(options.connection);
  }

  /** Session selected a cache. Activation performs no hydration or persistence. */
  activate() {
    this.#releaseSources();
    this.#cancelDownloads();
    this.#error = undefined;
    this.#version++;
  }
  get downloadJobs(): readonly DownloadJobInfo[] {
    this.#version;
    const jobs = [...this.#jobs.values()].filter((job) => job.cache === this.#selection.cache);
    return [
      ...jobs.filter((job) => job.status === "downloading"),
      ...jobs.filter((job) => job.status === "queued"),
    ].map((job) => ({ ...job.descriptor, track: job.track, status: job.status }));
  }
  get downloadsLoading() {
    return this.#selection.cache?.downloadsLoading ?? false;
  }
  get error() {
    return this.#error ?? this.#selection.cache?.downloadsError;
  }

  #track(track: EngineTrack): DownloadTrack {
    return {
      id: track.id,
      title: track.title ?? track.id,
      artist: track.artist ?? "Unknown artist",
      album: track.album ?? "Unknown album",
      contentType: track.contentType,
    };
  }
  #describe(track: EngineTrack, options: TrackSourceOptions = {}): Descriptor {
    const cache = this.#selection.cache;
    if (!cache?.account) throw new Error("No music account selected.");
    const format =
      !options.forceTranscode &&
      track.contentType &&
      this.#mediaProbe.canPlayType(track.contentType)
        ? "raw"
        : "mp3";
    return {
      key: downloadKey(track.id, format),
      ...cache.account,
      format,
      contentType: format === "raw" && track.contentType ? track.contentType : "audio/mpeg",
    };
  }
  #connectionFor(descriptor: Descriptor) {
    const connection = this.#connection;
    if (
      !connection ||
      connection.account.host !== descriptor.host ||
      connection.account.username !== descriptor.username
    )
      throw new Error("This track is not downloaded. Connect to its music server to stream it.");
    connection.signal.throwIfAborted();
    return connection;
  }
  #streamUrl(trackId: string, descriptor: Descriptor, position?: number) {
    return this.#connectionFor(descriptor).url(trackId, { format: descriptor.format, position });
  }

  #drain() {
    if (this.#destroyed || !this.#connection) return;
    const jobs = [...this.#jobs.values()];
    let active = jobs.filter((job) => job.status === "downloading").length;
    for (const job of jobs.filter((job) => job.status === "queued")) {
      if (active >= this.#concurrency) break;
      job.status = "downloading";
      active++;
      const finish = () => {
        if (this.#jobs.get(job.descriptor.key) === job) this.#jobs.delete(job.descriptor.key);
        this.#drain();
      };
      void this.#download(job).then(
        (file) => {
          finish();
          job.resolve(file);
        },
        (error) => {
          finish();
          job.reject(error);
        },
      );
    }
    this.#version++;
  }
  async #download(job: DownloadJob) {
    const { descriptor, track, connection, cache, signal } = job;
    const check = () => {
      if (cache !== this.#selection.cache) job.controller.abort();
      signal.throwIfAborted();
    };
    try {
      check();
      let file = await cache.readDownload(track.id, descriptor.format, signal);
      check();
      if (!file) {
        const response = await connection.read(track.id, { format: descriptor.format, signal });
        if (cache !== this.#selection.cache) job.controller.abort();
        // Cache also releases unused responses, including cancellation before save.
        file = await cache.saveDownload(
          track,
          descriptor.format,
          descriptor.contentType,
          response,
          signal,
        );
      }
      check();
      return file;
    } catch (error) {
      if (!this.#destroyed && !signal.aborted && cache === this.#selection.cache)
        this.#error = error;
      throw error;
    }
  }
  cache(track: EngineTrack, options: TrackSourceOptions = {}) {
    if (this.#destroyed)
      return Promise.reject(new DOMException("Downloads stopped.", "AbortError"));
    const descriptor = this.#describe(track, options);
    const connection = this.#connectionFor(descriptor);
    const existing = this.#jobs.get(descriptor.key);
    if (existing) return existing.promise;
    const cache = this.#selection.cache!;
    const { promise, resolve, reject } = Promise.withResolvers<File>();
    const controller = new AbortController();
    this.#jobs.set(descriptor.key, {
      descriptor,
      connection,
      cache,
      signal: AbortSignal.any([controller.signal, connection.signal]),
      track: this.#track(track),
      status: "queued",
      controller,
      promise,
      resolve,
      reject,
    });
    this.#error = undefined;
    this.#drain();
    return promise;
  }

  async #cached(cache: Cache, track: EngineTrack, descriptor: Descriptor, signal: AbortSignal) {
    const file = await cache.readDownload(track.id, descriptor.format, signal);
    if (file)
      return {
        file,
        contentType: cache.downloads.get(descriptor.key)?.contentType ?? descriptor.contentType,
      };
    // A codec retry may have saved MP3 despite the browser claiming raw support.
    if (descriptor.format === "raw") {
      const mp3 = await cache.readDownload(track.id, "mp3", signal);
      if (mp3) return { file: mp3, contentType: "audio/mpeg" };
    }
    return null;
  }
  getStatus(trackId: string): TrackStatus {
    this.#version;
    const cache = this.#selection.cache;
    if (!cache) return "idle";
    const keys = [downloadKey(trackId, "raw"), downloadKey(trackId, "mp3")];
    const jobs = keys.map((key) => this.#jobs.get(key)).filter((job) => job?.cache === cache);
    if (jobs.some((job) => job?.status === "downloading")) return "downloading";
    if (jobs.some((job) => job?.status === "queued")) return "queued";
    return keys.some((key) => cache.downloads.has(key)) ? "downloaded" : "idle";
  }
  async getSource(
    track: EngineTrack,
    options: TrackSourceOptions & { position?: number; signal?: AbortSignal } = {},
  ): Promise<TrackSource> {
    if (this.#destroyed) throw new DOMException("Playback stopped.", "AbortError");
    const signal = options.signal
      ? AbortSignal.any([this.#sourceController.signal, options.signal])
      : this.#sourceController.signal;
    signal.throwIfAborted();
    const descriptor = this.#describe(track, options);
    const cache = this.#selection.cache!;
    const cached = await this.#cached(cache, track, descriptor, signal);
    signal.throwIfAborted();
    if (this.#destroyed || cache !== this.#selection.cache)
      throw new DOMException("Source request superseded.", "AbortError");
    if (!cached) {
      const offset = Math.max(0, Math.floor(options.position ?? 0));
      const type = track.contentType?.split(";")[0].trim().toLowerCase();
      // timeOffset applies only to transcoding. Navidrome can return an
      // original MP3 unchanged even with format=mp3, so it has no offset.
      // Unknown formats likewise use the full source and native currentTime.
      const needsConversion =
        type?.startsWith("audio/") && !["audio/mpeg", "audio/mp3", "audio/x-mp3"].includes(type);
      if (offset > 0 && needsConversion)
        return {
          cached: false,
          offset,
          url: this.#streamUrl(track.id, { ...descriptor, format: "mp3" }, offset),
          release() {},
        };
      return {
        cached: false,
        url: this.#streamUrl(track.id, descriptor),
        nativeSeeking: descriptor.format === "raw",
        release() {},
      };
    }
    const url = URL.createObjectURL(new Blob([cached.file], { type: cached.contentType }));
    const release = () => {
      if (!this.#sourceReleases.delete(release)) return;
      URL.revokeObjectURL(url);
    };
    this.#sourceReleases.add(release);
    return { cached: true, url, release };
  }
  #cancelSourceRequest() {
    this.#sourceController.abort();
    this.#sourceController = new AbortController();
  }
  #releaseSources() {
    this.#cancelSourceRequest();
    for (const release of this.#sourceReleases) release();
  }
  setConnection(connection?: AudioConnection) {
    if (this.#connection === connection || this.#destroyed) return;
    this.#cancelSourceRequest();
    this.#cancelDownloads();
    this.#connection = connection;
    // Retain the active cached object URL across disconnects.
    this.#version++;
  }
  #cancelDownloads() {
    for (const job of this.#jobs.values()) {
      job.controller.abort();
      job.reject(job.controller.signal.reason);
    }
    this.#jobs.clear();
  }
  destroy() {
    this.#destroyed = true;
    this.#releaseSources();
    this.#cancelDownloads();
  }
}

import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";
import {
  OpfsTrackStore,
  type DownloadedFile,
  type DownloadTrack,
  type TrackFileDescriptor,
} from "./track-store";

export interface EngineTrack {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  contentType?: string;
  coverArt?: string;
}
export interface TrackSource {
  cached: boolean;
  url: string;
  offset?: number;
  nativeSeeking?: boolean;
}
export interface TrackSourceOptions {
  forceTranscode?: boolean;
  priority?: "playback";
}
export type TrackStatus = "idle" | "queued" | "downloading" | "downloaded";
export interface TrackEngineOptions {
  client?: SubsonicClient;
  concurrency?: number;
}
type StreamDescriptor = TrackFileDescriptor & { url: string };
export type DownloadItem =
  | (DownloadedFile & { status: "downloaded" })
  | (TrackFileDescriptor & { track: DownloadTrack; status: "queued" | "downloading" });
interface DownloadJob {
  descriptor: StreamDescriptor;
  track: DownloadTrack;
  status: "queued" | "downloading";
  priority: number;
  controller: AbortController;
  promise: Promise<File>;
  resolve: (file: File) => void;
  reject: (error: unknown) => void;
}

export class TrackEngine {
  #activeObjectUrl = "";
  #client?: SubsonicClient;
  #jobs = new Map<string, DownloadJob>();
  #files = new Map<string, DownloadedFile>();
  #ready: Promise<void>;
  #concurrency: number;
  #active = 0;
  #destroyed = false;
  #catalogRequest = 0;
  #loading = true;
  #error: unknown;
  #mediaProbe = document.createElement("audio");
  #sourceRequest = 0;
  #store = new OpfsTrackStore();
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  constructor(options: TrackEngineOptions = {}) {
    this.#client = options.client;
    this.#concurrency = options.concurrency ?? 3;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1)
      throw new Error("Download concurrency must be a positive integer.");
    this.#ready = this.#refreshCatalog(true);
  }

  ready() {
    return this.#ready;
  }

  get downloads(): readonly DownloadItem[] {
    this.#subscribe();
    const jobs = [...this.#jobs.values()];
    return [
      ...jobs.filter((job) => job.status === "downloading"),
      ...jobs.filter((job) => job.status === "queued").sort((a, b) => b.priority - a.priority),
    ]
      .map((job): DownloadItem => ({
        key: job.descriptor.key,
        host: job.descriptor.host,
        username: job.descriptor.username,
        format: job.descriptor.format,
        contentType: job.descriptor.contentType,
        track: job.track,
        status: job.status,
      }))
      .concat(
        [...this.#files.values()]
          .filter((file) => !this.#jobs.has(file.key))
          .sort((a, b) => b.downloadedAt - a.downloadedAt || a.key.localeCompare(b.key))
          .map((file) => ({ ...file, status: "downloaded" as const })),
      );
  }
  get downloadsLoading() {
    this.#subscribe();
    return this.#loading;
  }
  get error() {
    this.#subscribe();
    return this.#error;
  }

  async #refreshCatalog(validate = false) {
    const request = ++this.#catalogRequest;
    try {
      const entries = await (validate ? this.#store.list() : this.#store.entries());
      if (this.#destroyed || request !== this.#catalogRequest) return;
      this.#files = new Map(entries.map((entry) => [entry.key, entry]));
    } catch (error) {
      if (this.#destroyed || request !== this.#catalogRequest) return;
      this.#error = error;
    }
    if (!this.#destroyed && request === this.#catalogRequest) {
      this.#loading = false;
      this.#update();
    }
  }

  #track(track: EngineTrack): DownloadTrack {
    return {
      id: track.id,
      title: track.title ?? track.id,
      artist: track.artist ?? "Unknown artist",
      album: track.album ?? "Unknown album",
      contentType: track.contentType,
      coverArt: track.coverArt,
    };
  }
  #key(id: string, format: "raw" | "mp3") {
    return `${this.#client?.host}\n${this.#client?.username}\n${id}\n${format}-v1`;
  }
  #describe(track: EngineTrack, options: TrackSourceOptions = {}): StreamDescriptor {
    const client = this.#client;
    if (!client) throw new Error("No active Subsonic connection.");
    const format =
      !options.forceTranscode &&
      track.contentType &&
      this.#mediaProbe.canPlayType(track.contentType)
        ? "raw"
        : "mp3";
    return {
      key: this.#key(track.id, format),
      host: client.host,
      username: client.username,
      format,
      contentType: format === "raw" && track.contentType ? track.contentType : "audio/mpeg",
      url: client.getStreamUrl(track.id, { format, estimateContentLength: true }),
    };
  }

  #drain() {
    if (this.#destroyed) return;
    const queued = [...this.#jobs.values()]
      .filter((job) => job.status === "queued")
      .sort((a, b) => b.priority - a.priority);
    for (const job of queued) {
      if (this.#active >= this.#concurrency) break;
      job.status = "downloading";
      this.#active++;
      const finish = () => {
        this.#jobs.delete(job.descriptor.key);
        this.#active--;
        this.#drain();
        this.#update();
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
    this.#update();
  }

  async #download(job: DownloadJob) {
    const { descriptor, track, controller } = job;
    try {
      let file = await this.#store.get(descriptor, track);
      controller.signal.throwIfAborted();
      if (!file) {
        const response = await fetch(descriptor.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
        file = await this.#store.put(descriptor, track, response, controller.signal);
      }
      await this.#refreshCatalog();
      return file;
    } catch (error) {
      if (!this.#destroyed) {
        this.#error = error;
        this.#update();
      }
      throw error;
    }
  }

  cache(track: EngineTrack, options: TrackSourceOptions = {}) {
    if (this.#destroyed)
      return Promise.reject(new DOMException("Downloads stopped.", "AbortError"));
    const descriptor = this.#describe(track, options);
    const existing = this.#jobs.get(descriptor.key);
    if (existing) {
      if (options.priority === "playback") {
        existing.priority = 1;
        this.#update();
      }
      return existing.promise;
    }
    let resolve!: (file: File) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<File>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.#jobs.set(descriptor.key, {
      descriptor,
      track: this.#track(track),
      status: "queued",
      priority: options.priority === "playback" ? 1 : 0,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    });
    this.#error = undefined;
    this.#drain();
    return promise;
  }

  async #cached(track: EngineTrack, descriptor: StreamDescriptor) {
    const metadata = this.#track(track);
    const file = await this.#store.get(descriptor, metadata);
    if (file) return { file, contentType: descriptor.contentType };
    // A codec retry may have downloaded MP3 even when canPlayType claims raw support.
    if (descriptor.format === "raw") {
      const fallback: TrackFileDescriptor = {
        ...descriptor,
        key: `${descriptor.host}\n${descriptor.username}\n${track.id}\nmp3-v1`,
        format: "mp3",
        contentType: "audio/mpeg",
      };
      const mp3 = await this.#store.get(fallback, metadata);
      if (mp3) return { file: mp3, contentType: fallback.contentType };
    }
    return null;
  }

  async scanCached(tracks: EngineTrack[]) {
    let next = 0;
    const client = this.#client;
    const worker = async () => {
      while (next < tracks.length && !this.#destroyed && this.#client === client) {
        const track = tracks[next++];
        await this.#cached(track, this.#describe(track));
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(8, tracks.length) }, worker));
    await this.#refreshCatalog();
  }

  getStatus(trackId: string): TrackStatus {
    this.#subscribe();
    const keys = [this.#key(trackId, "raw"), this.#key(trackId, "mp3")];
    const jobs = keys.map((key) => this.#jobs.get(key));
    if (jobs.some((job) => job?.status === "downloading")) return "downloading";
    if (jobs.some((job) => job?.status === "queued")) return "queued";
    return keys.some((key) => this.#files.has(key)) ? "downloaded" : "idle";
  }

  async getSource(
    track: EngineTrack,
    options: TrackSourceOptions & { position?: number } = {},
  ): Promise<TrackSource> {
    const request = ++this.#sourceRequest;
    const descriptor = this.#describe(track, options);
    const cached = await this.#cached(track, descriptor);
    await this.#refreshCatalog();
    if (request !== this.#sourceRequest)
      throw new DOMException("Source request superseded.", "AbortError");
    this.#clearObjectUrl();
    if (!cached) {
      const offset = Math.max(0, Math.floor(options.position ?? 0));
      if (offset > 0) {
        return {
          cached: false,
          offset,
          url: this.#client!.getStreamUrl(track.id, {
            format: "mp3",
            timeOffset: offset,
            estimateContentLength: true,
          }),
        };
      }
      return { cached: false, url: descriptor.url, nativeSeeking: descriptor.format === "raw" };
    }
    this.#activeObjectUrl = URL.createObjectURL(
      new Blob([cached.file], { type: cached.contentType }),
    );
    return { cached: true, url: this.#activeObjectUrl };
  }

  #clearObjectUrl() {
    if (this.#activeObjectUrl) URL.revokeObjectURL(this.#activeObjectUrl);
    this.#activeObjectUrl = "";
  }
  releaseSource() {
    this.#sourceRequest++;
    this.#clearObjectUrl();
  }
  setClient(client: SubsonicClient) {
    this.#client = client;
    this.#update();
  }
  destroy() {
    this.#destroyed = true;
    this.releaseSource();
    for (const [key, job] of this.#jobs) {
      job.controller.abort();
      if (job.status === "queued") {
        this.#jobs.delete(key);
        job.reject(job.controller.signal.reason);
      }
    }
  }
}

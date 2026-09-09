import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";
import { OpfsTrackStore } from "./track-store";
import type { DownloadTrack, TrackFileDescriptor } from "./schema";
import type { Memory } from "./memory.svelte";

type DownloadMemory = Pick<Memory, "account" | "downloads">;

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
}
export type TrackStatus = "idle" | "queued" | "downloading" | "downloaded";
export interface TrackEngineOptions {
  memory: DownloadMemory;
  client?: SubsonicClient;
  concurrency?: number;
}
type StreamDescriptor = TrackFileDescriptor & { url: string };
export type DownloadJobInfo = TrackFileDescriptor & {
  track: DownloadTrack;
  status: "queued" | "downloading";
};
interface DownloadJob {
  descriptor: StreamDescriptor;
  track: DownloadTrack;
  status: "queued" | "downloading";
  controller: AbortController;
  promise: Promise<File>;
  resolve: (file: File) => void;
  reject: (error: unknown) => void;
}

export class TrackEngine {
  #activeObjectUrl = "";
  #client?: SubsonicClient;
  #jobs = new Map<string, DownloadJob>();
  #memory: DownloadMemory;
  #ready: Promise<void>;
  #concurrency: number;
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

  constructor(options: TrackEngineOptions) {
    this.#memory = options.memory;
    if (options.client) this.setClient(options.client);
    this.#concurrency = options.concurrency ?? 3;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1)
      throw new Error("Download concurrency must be a positive integer.");
    this.#ready = this.#refreshCatalog(true);
  }

  ready() {
    return this.#ready;
  }

  get downloadJobs(): readonly DownloadJobInfo[] {
    this.#subscribe();
    const jobs = [...this.#jobs.values()];
    return [
      ...jobs.filter((job) => job.status === "downloading"),
      ...jobs.filter((job) => job.status === "queued"),
    ].map((job) => ({
      key: job.descriptor.key,
      host: job.descriptor.host,
      username: job.descriptor.username,
      format: job.descriptor.format,
      contentType: job.descriptor.contentType,
      track: job.track,
      status: job.status,
    }));
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
      this.#memory.downloads = new Map(entries.map((entry) => [entry.key, entry]));
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
    return `${this.#memory.account?.host}\n${this.#memory.account?.username}\n${id}\n${format}-v1`;
  }
  #describe(track: EngineTrack, options: TrackSourceOptions = {}): TrackFileDescriptor {
    const account = this.#memory.account;
    if (!account) throw new Error("No music account selected.");
    const format =
      !options.forceTranscode &&
      track.contentType &&
      this.#mediaProbe.canPlayType(track.contentType)
        ? "raw"
        : "mp3";
    return {
      key: this.#key(track.id, format),
      host: account.host,
      username: account.username,
      format,
      contentType: format === "raw" && track.contentType ? track.contentType : "audio/mpeg",
    };
  }

  #matchesAccount(descriptor: TrackFileDescriptor) {
    return (
      descriptor.host === this.#memory.account?.host &&
      descriptor.username === this.#memory.account?.username
    );
  }

  #streamUrl(trackId: string, descriptor: TrackFileDescriptor, timeOffset?: number) {
    const client = this.#client;
    if (
      !client ||
      client.host !== descriptor.host ||
      client.username !== descriptor.username ||
      !this.#matchesAccount(descriptor)
    ) {
      throw new Error("This track is not downloaded. Connect to its music server to stream it.");
    }
    return client.getStreamUrl(trackId, {
      format: descriptor.format,
      estimateContentLength: true,
      timeOffset,
    });
  }

  #drain() {
    if (this.#destroyed || !this.#client) return;
    const jobs = [...this.#jobs.values()];
    let active = jobs.filter((job) => job.status === "downloading").length;
    for (const job of jobs.filter((job) => job.status === "queued")) {
      if (active >= this.#concurrency) break;
      job.status = "downloading";
      active++;
      const finish = () => {
        if (this.#jobs.get(job.descriptor.key) === job) this.#jobs.delete(job.descriptor.key);
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
      controller.signal.throwIfAborted();
      await this.#refreshCatalog();
      return file;
    } catch (error) {
      if (!this.#destroyed && !controller.signal.aborted) {
        this.#error = error;
        this.#update();
      }
      throw error;
    }
  }

  cache(track: EngineTrack, options: TrackSourceOptions = {}) {
    if (this.#destroyed)
      return Promise.reject(new DOMException("Downloads stopped.", "AbortError"));
    const file = this.#describe(track, options);
    const descriptor: StreamDescriptor = { ...file, url: this.#streamUrl(track.id, file) };
    const existing = this.#jobs.get(descriptor.key);
    if (existing) return existing.promise;
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
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    });
    this.#error = undefined;
    this.#drain();
    return promise;
  }

  async #cached(track: EngineTrack, descriptor: TrackFileDescriptor) {
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
    const account = this.#memory.account;
    const worker = async () => {
      while (next < tracks.length && !this.#destroyed && this.#memory.account === account) {
        const track = tracks[next++];
        await this.#cached(track, this.#describe(track));
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(8, tracks.length) }, worker));
    await this.#refreshCatalog();
  }

  getStatus(trackId: string): TrackStatus {
    this.#subscribe();
    if (!this.#memory.account) return "idle";
    const keys = [this.#key(trackId, "raw"), this.#key(trackId, "mp3")];
    const jobs = keys.map((key) => this.#jobs.get(key));
    if (jobs.some((job) => job?.status === "downloading")) return "downloading";
    if (jobs.some((job) => job?.status === "queued")) return "queued";
    return keys.some((key) => this.#memory.downloads.has(key)) ? "downloaded" : "idle";
  }

  async getSource(
    track: EngineTrack,
    options: TrackSourceOptions & { position?: number } = {},
  ): Promise<TrackSource> {
    if (this.#destroyed) throw new DOMException("Playback stopped.", "AbortError");
    const request = ++this.#sourceRequest;
    const account = this.#memory.account;
    const descriptor = this.#describe(track, options);
    const cached = await this.#cached(track, descriptor);
    await this.#refreshCatalog();
    if (
      request !== this.#sourceRequest ||
      this.#destroyed ||
      this.#memory.account !== account ||
      !this.#matchesAccount(descriptor)
    )
      throw new DOMException("Source request superseded.", "AbortError");
    this.#clearObjectUrl();
    if (!cached) {
      const offset = Math.max(0, Math.floor(options.position ?? 0));
      if (offset > 0) {
        return {
          cached: false,
          offset,
          url: this.#streamUrl(track.id, { ...descriptor, format: "mp3" }, offset),
        };
      }
      return {
        cached: false,
        url: this.#streamUrl(track.id, descriptor),
        nativeSeeking: descriptor.format === "raw",
      };
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
  setClient(client?: SubsonicClient) {
    if (this.#client === client) return;
    this.#sourceRequest++;
    this.#cancelDownloads();
    this.#client = client;
    if (client) {
      if (
        this.#memory.account?.host !== client.host ||
        this.#memory.account?.username !== client.username
      ) {
        this.#clearObjectUrl();
        this.#memory.account = { host: client.host, username: client.username };
      }
    }
    // Detaching credentials preserves account identity and completed downloads.
    this.#update();
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
    this.releaseSource();
    this.#cancelDownloads();
  }
}

import { createSubscriber } from "svelte/reactivity";
import type { AudioConnection } from "./network.svelte";
import type { Storage } from "./storage";
import type { DownloadTrack, TrackFileDescriptor } from "./schema";
import type { Memory, MemoryView } from "./memory.svelte";

type DownloadMemory = Pick<MemoryView, "account"> & Pick<Memory, "downloads">;

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
  storage?: Pick<Storage, "account" | "audio">;
  connection?: AudioConnection;
  concurrency?: number;
}
export type DownloadJobInfo = TrackFileDescriptor & {
  track: DownloadTrack;
  status: "queued" | "downloading";
};
interface DownloadJob {
  descriptor: TrackFileDescriptor;
  connection: AudioConnection;
  storage: Pick<Storage, "account" | "audio">;
  signal: AbortSignal;
  track: DownloadTrack;
  status: "queued" | "downloading";
  controller: AbortController;
  promise: Promise<File>;
  resolve: (file: File) => void;
  reject: (error: unknown) => void;
}

export class TrackEngine {
  #activeObjectUrl = "";
  #connection?: AudioConnection;
  #jobs = new Map<string, DownloadJob>();
  #memory: DownloadMemory;
  #ready: Promise<void> = Promise.resolve();
  #concurrency: number;
  #destroyed = false;
  #catalogRequest = 0;
  #loading = false;
  #error: unknown;
  #mediaProbe = document.createElement("audio");
  #sourceRequest = 0;
  #storage?: Pick<Storage, "account" | "audio">;
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  constructor(options: TrackEngineOptions) {
    this.#memory = options.memory;
    if (options.storage) this.restore(options.storage);
    if (options.connection) this.setConnection(options.connection);
    this.#concurrency = options.concurrency ?? 3;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1)
      throw new Error("Download concurrency must be a positive integer.");
  }

  restore(storage: Pick<Storage, "account" | "audio">) {
    if (this.#storage === storage) return this.#ready;
    if (this.#storage) {
      this.#sourceRequest++;
      this.#cancelDownloads();
      this.#clearObjectUrl();
    }
    this.#storage = storage;
    this.#loading = true;
    this.#ready = this.#refreshCatalog(true);
    this.#update();
    return this.#ready;
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
    const storage = this.#storage;
    if (!storage) return;
    try {
      const audio = storage.audio;
      const entries = await (validate ? audio.list() : audio.entries());
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
    return `${this.#storage?.account?.host}\n${this.#storage?.account?.username}\n${id}\n${format}-v1`;
  }
  #describe(track: EngineTrack, options: TrackSourceOptions = {}): TrackFileDescriptor {
    const account = this.#storage?.account;
    if (!account) throw new Error("No music storage selected.");
    if (
      account.host !== this.#memory.account?.host ||
      account.username !== this.#memory.account.username
    )
      throw new Error("Audio storage belongs to a different account.");
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

  #connectionFor(descriptor: TrackFileDescriptor) {
    const connection = this.#connection;
    if (
      !connection ||
      connection.account.host !== descriptor.host ||
      connection.account.username !== descriptor.username ||
      !this.#matchesAccount(descriptor)
    ) {
      throw new Error("This track is not downloaded. Connect to its music server to stream it.");
    }
    connection.signal.throwIfAborted();
    return connection;
  }

  #streamUrl(trackId: string, descriptor: TrackFileDescriptor, position?: number) {
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
    const { descriptor, track, connection, storage, signal } = job;
    try {
      let file = await storage.audio.read(descriptor, track);
      signal.throwIfAborted();
      if (!file) {
        const response = await connection.read(track.id, { format: descriptor.format, signal });
        file = await storage.audio.save(descriptor, track, response, signal);
      }
      signal.throwIfAborted();
      await this.#refreshCatalog();
      return file;
    } catch (error) {
      if (!this.#destroyed && !signal.aborted) {
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
    const connection = this.#connectionFor(descriptor);
    const existing = this.#jobs.get(descriptor.key);
    if (existing) return existing.promise;
    const storage = this.#storage;
    if (!storage) return Promise.reject(new Error("No music storage selected."));
    const { promise, resolve, reject } = Promise.withResolvers<File>();
    const controller = new AbortController();
    this.#jobs.set(descriptor.key, {
      descriptor,
      connection,
      storage,
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

  async #cached(track: EngineTrack, descriptor: TrackFileDescriptor) {
    const storage = this.#storage;
    if (!storage) throw new Error("No music storage selected.");
    const metadata = this.#track(track);
    const file = await storage.audio.read(descriptor, metadata);
    if (file) return { file, contentType: descriptor.contentType };
    // A codec retry may have downloaded MP3 even when canPlayType claims raw support.
    if (descriptor.format === "raw") {
      const fallback: TrackFileDescriptor = {
        ...descriptor,
        key: `${descriptor.host}\n${descriptor.username}\n${track.id}\nmp3-v1`,
        format: "mp3",
        contentType: "audio/mpeg",
      };
      const mp3 = await storage.audio.read(fallback, metadata);
      if (mp3) return { file: mp3, contentType: fallback.contentType };
    }
    return null;
  }

  async scanCached(tracks: EngineTrack[]) {
    let next = 0;
    const storage = this.#storage;
    const worker = async () => {
      while (next < tracks.length && !this.#destroyed && this.#storage === storage) {
        const track = tracks[next++];
        await this.#cached(track, this.#describe(track));
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(8, tracks.length) }, worker));
    await this.#refreshCatalog();
  }

  getStatus(trackId: string): TrackStatus {
    this.#subscribe();
    if (
      !this.#storage?.account ||
      this.#storage.account.host !== this.#memory.account?.host ||
      this.#storage.account.username !== this.#memory.account.username
    )
      return "idle";
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
    const storage = this.#storage;
    const descriptor = this.#describe(track, options);
    const cached = await this.#cached(track, descriptor);
    await this.#refreshCatalog();
    if (
      request !== this.#sourceRequest ||
      this.#destroyed ||
      this.#storage !== storage ||
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
  setConnection(connection?: AudioConnection) {
    if (this.#connection === connection) return;
    this.#sourceRequest++;
    this.#cancelDownloads();
    this.#connection = connection;
    // Connection changes never select a workspace. Session owns account identity;
    // descriptor checks prevent a mismatched connection from being used.
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

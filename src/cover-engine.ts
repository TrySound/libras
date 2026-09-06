import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";

export interface CoverRequest {
  candidates: readonly (string | undefined)[];
  allowNetwork: boolean;
}

export interface Cover {
  readonly source: string | undefined;
  readonly cache: () => void;
}

interface CachedCover {
  etag?: string;
  file: File;
  lastModified?: string;
  type: string;
}

interface CacheResult {
  cover: CachedCover;
  changed: boolean;
}

interface CoverEntry {
  candidates: string[];
  id?: string;
  cover: Cover;
  generation: number;
  network?: { cacheKey: string; url: string };
  source?: string;
}

interface ResolvedCover {
  id?: string;
  network?: { cacheKey: string; url: string };
  source?: string;
}

export class CoverEngine {
  #client?: SubsonicClient;
  #covers = new Map<string, CoverEntry>();
  #downloads = new Map<string, Promise<CacheResult>>();
  #generation = 0;
  #objectUrls = new Map<string, string>();
  #listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify() {
    this.#update();
    for (const listener of this.#listeners) listener();
  }

  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  #cache(key: string, url: string) {
    const activeDownload = this.#downloads.get(key);
    if (activeDownload) return activeDownload;

    const download = this.#download(key, url).finally(() => this.#downloads.delete(key));
    this.#downloads.set(key, download);
    return download;
  }

  #cacheKey(id: string, client: SubsonicClient) {
    return `${client.host}\n${client.username}\n${id}`;
  }

  async #cacheFileName(key: string) {
    const data = new TextEncoder().encode(key);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("images", { create: true });
  }

  #coverUrl(id: string, client: SubsonicClient) {
    return client.getCoverArtUrl(id, 500);
  }

  async #download(key: string, url: string): Promise<CacheResult> {
    const cached = await this.#getCached(key);
    if (cached && !cached.etag && !cached.lastModified) {
      return { cover: cached, changed: false };
    }

    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);

    const response = await fetch(url, { headers });
    if (response.status === 304 && cached) return { cover: cached, changed: false };
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    const directory = await this.#directory();
    const name = await this.#cacheFileName(key);
    const type = response.headers.get("Content-Type") ?? "image/jpeg";
    const etag = response.headers.get("ETag") ?? undefined;
    const lastModified = response.headers.get("Last-Modified") ?? undefined;
    const [imageHandle, metadataHandle] = await Promise.all([
      directory.getFileHandle(`${name}.image`, { create: true }),
      directory.getFileHandle(`${name}.json`, { create: true }),
    ]);
    const [imageWritable, metadataWritable] = await Promise.all([
      imageHandle.createWritable(),
      metadataHandle.createWritable(),
    ]);

    try {
      await Promise.all([
        response.body
          ? response.body.pipeTo(imageWritable)
          : response.blob().then(async (blob) => {
              await imageWritable.write(blob);
              await imageWritable.close();
            }),
        metadataWritable
          .write(JSON.stringify({ etag, lastModified, type }))
          .then(() => metadataWritable.close()),
      ]);
      return {
        cover: { etag, file: await imageHandle.getFile(), lastModified, type },
        changed: true,
      };
    } catch (error) {
      await Promise.all([
        imageWritable.abort().catch(() => {}),
        metadataWritable.abort().catch(() => {}),
        directory.removeEntry(`${name}.image`).catch(() => {}),
        directory.removeEntry(`${name}.json`).catch(() => {}),
      ]);
      throw error;
    }
  }

  async #getCached(key: string): Promise<CachedCover | null> {
    const directory = await this.#directory();
    const name = await this.#cacheFileName(key);

    try {
      const [imageHandle, metadataHandle] = await Promise.all([
        directory.getFileHandle(`${name}.image`),
        directory.getFileHandle(`${name}.json`),
      ]);
      const [file, metadata] = await Promise.all([
        imageHandle.getFile(),
        metadataHandle.getFile().then(
          async (value) =>
            JSON.parse(await value.text()) as {
              etag?: string;
              lastModified?: string;
              type?: string;
            },
        ),
      ]);
      if (file.size === 0) return null;
      return {
        etag: metadata.etag,
        file,
        lastModified: metadata.lastModified,
        type: metadata.type ?? "image/jpeg",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async #snapshot(cached: CachedCover) {
    const bytes = await cached.file.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("The cached cover is empty.");
    return new Blob([bytes], { type: cached.type });
  }

  async #install(id: string, cached: CachedCover) {
    const generation = this.#generation;
    const existing = this.#objectUrls.get(id);
    if (existing) return existing;
    const blob = await this.#snapshot(cached);
    if (generation !== this.#generation) return;
    const installed = this.#objectUrls.get(id);
    if (installed) return installed;
    const url = URL.createObjectURL(blob);
    this.#objectUrls.set(id, url);
    return url;
  }

  #publishCached(id: string, source: string) {
    for (const entry of this.#covers.values()) {
      const candidate = entry.candidates.indexOf(id);
      const selected = entry.id ? entry.candidates.indexOf(entry.id) : Infinity;
      if (candidate < 0 || candidate > selected) continue;
      entry.id = id;
      entry.source = source;
      entry.network = undefined;
    }
    this.#notify();
  }

  #revalidate(id: string, cachedUrl: string, client: SubsonicClient) {
    const generation = this.#generation;
    this.#cache(this.#cacheKey(id, client), this.#coverUrl(id, client))
      .then(async (result) => {
        if (!result.changed || generation !== this.#generation) return;
        const blob = await this.#snapshot(result.cover);
        if (generation !== this.#generation) return;
        const updatedUrl = URL.createObjectURL(blob);
        this.#objectUrls.set(id, updatedUrl);
        this.#publishCached(id, updatedUrl);
        URL.revokeObjectURL(cachedUrl);
      })
      .catch(() => {});
  }

  async #resolve(
    candidates: string[],
    allowNetwork: boolean,
    client: SubsonicClient,
  ): Promise<ResolvedCover> {
    const generation = this.#generation;
    for (const id of candidates) {
      const objectUrl = this.#objectUrls.get(id);
      if (objectUrl) return { id, source: objectUrl };

      const cached = await this.#getCached(this.#cacheKey(id, client)).catch(() => null);
      if (generation !== this.#generation) return {};
      if (cached) {
        const cachedUrl = await this.#install(id, cached);
        if (!cachedUrl) return {};
        if (allowNetwork) this.#revalidate(id, cachedUrl, client);
        return { id, source: cachedUrl };
      }
    }

    if (allowNetwork && candidates[0]) {
      const url = this.#coverUrl(candidates[0], client);
      return {
        id: candidates[0],
        network: { cacheKey: this.#cacheKey(candidates[0], client), url },
        source: url,
      };
    }
    return {};
  }

  #releaseObjectUrls() {
    for (const url of this.#objectUrls.values()) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }

  #cacheEntry(entry: CoverEntry) {
    const network = entry.network;
    if (!network || entry.generation !== this.#generation) return;

    this.#cache(network.cacheKey, network.url)
      .then(async (result) => {
        if (entry.generation !== this.#generation || !entry.id) return;
        const source = await this.#install(entry.id, result.cover);
        if (entry.generation !== this.#generation || !source) return;
        this.#publishCached(entry.id, source);
      })
      .catch(() => {});
  }

  getCover(request: CoverRequest): Cover {
    this.#subscribe();
    const candidates = [...new Set(request.candidates.filter((id): id is string => Boolean(id)))];
    const key = JSON.stringify([request.allowNetwork, candidates]);
    const existing = this.#covers.get(key);
    if (existing) return existing.cover;

    const engine = this;
    let entry: CoverEntry;
    const cover: Cover = {
      get source() {
        engine.#subscribe();
        return entry.source;
      },
      cache: () => this.#cacheEntry(entry),
    };
    entry = { candidates, cover, generation: this.#generation };
    this.#covers.set(key, entry);

    const client = this.#client;
    if (client) {
      this.#resolve(candidates, request.allowNetwork, client)
        .then((resolved) => {
          if (
            entry.generation !== this.#generation ||
            resolved.source === undefined ||
            entry.source !== undefined
          )
            return;
          entry.id = resolved.id;
          entry.network = resolved.network;
          entry.source = resolved.source;
          this.#notify();
        })
        .catch(() => {});
    }
    return cover;
  }

  setClient(client: SubsonicClient) {
    const accountChanged =
      this.#client &&
      (this.#client.host !== client.host || this.#client.username !== client.username);
    if (accountChanged) this.#releaseObjectUrls();
    this.#client = client;
    this.#generation += 1;
    this.#covers.clear();
    this.#notify();
  }

  destroy() {
    this.#generation += 1;
    this.#covers.clear();
    this.#releaseObjectUrls();
  }
}

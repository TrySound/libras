import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";

export interface QueueTrack {
  album: string;
  artist: string;
  contentType?: string;
  coverArt?: string;
  id: string;
  title: string;
}

export interface QueueState {
  current?: string;
  position: number;
  tracks: readonly QueueTrack[];
}

export type QueueEngineStatus = "idle" | "loading" | "ready" | "saving" | "error";
export type QueueNetwork = "offline" | "online";

export class QueueEngine {
  #client?: SubsonicClient;
  #current?: string;
  #error: unknown;
  #generation = 0;
  #network: QueueNetwork = "online";
  #position = 0;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #status: QueueEngineStatus = "idle";
  #tracks: readonly QueueTrack[] = [];
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

  get current() {
    this.#subscribe();
    return this.#current;
  }

  get error() {
    this.#subscribe();
    return this.#error;
  }

  get position() {
    this.#subscribe();
    return this.#position;
  }

  get status() {
    this.#subscribe();
    return this.#status;
  }

  get tracks() {
    this.#subscribe();
    return this.#tracks;
  }

  #publish(state: QueueState) {
    this.#current = state.current;
    this.#position = state.position;
    this.#tracks = [...state.tracks];
    this.#notify();
  }

  #state(): QueueState {
    return {
      current: this.#current,
      position: this.#position,
      tracks: this.#tracks,
    };
  }

  #load() {
    const client = this.#client;
    if (!client || this.#network === "offline") return;

    const generation = ++this.#generation;
    this.#error = undefined;
    this.#status = "loading";
    this.#notify();
    client
      .getPlayQueue()
      .then((queue) => {
        if (generation !== this.#generation) return;
        this.#publish({
          current: queue.current,
          position: queue.position,
          tracks: queue.tracks.map((track) => ({
            album: track.album ?? "Unknown album",
            artist: track.artist ?? "Unknown artist",
            contentType: track.contentType,
            coverArt: track.coverArt,
            id: track.id,
            title: track.title,
          })),
        });
        this.#status = "ready";
        this.#notify();
      })
      .catch((error) => {
        if (generation !== this.#generation) return;
        this.#error = error;
        this.#status = "error";
        this.#notify();
      });
  }

  async #save(state: QueueState) {
    const client = this.#client;
    if (!client || this.#network === "offline") return;

    const generation = this.#generation;

    this.#error = undefined;
    this.#status = "saving";
    this.#notify();
    try {
      await client.savePlayQueue({
        current: state.current,
        position: state.position,
        tracks: [...state.tracks],
      });
      if (generation !== this.#generation) return;
      this.#status = "ready";
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error = error;
      this.#status = "error";
    }
    this.#notify();
  }

  update(state: QueueState) {
    this.#generation += 1;
    this.#publish(state);
    this.save();
  }

  setPosition(position: number) {
    if (position === this.#position) return;
    this.#position = position;
    this.#notify();
  }

  save() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#save(this.#state()).catch(() => {});
    }, 300);
  }

  flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    this.#save(this.#state()).catch(() => {});
  }

  setClient(client: SubsonicClient) {
    if (client === this.#client) return;
    this.#client = client;
    this.#load();
  }

  setNetwork(network: QueueNetwork) {
    if (network === this.#network) return;
    this.#network = network;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    if (network === "online") this.#load();
    else {
      this.#generation += 1;
      this.#status = "idle";
      this.#notify();
    }
  }

  destroy() {
    this.#generation += 1;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    this.#status = "idle";
    this.#notify();
  }
}

import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";

export interface QueueState {
  current?: string;
  position: number;
  tracks: readonly string[];
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
  #tracks: readonly string[] = [];
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
    this.#tracks = [...state.tracks];
    this.#current =
      state.current && this.#tracks.includes(state.current) ? state.current : undefined;
    this.#position = this.#current ? state.position : 0;
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
        this.#publish(queue);
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
      await client.savePlayQueue(state);
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
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    this.#generation++;
    if (
      this.#client &&
      (client.host !== this.#client.host || client.username !== this.#client.username)
    ) {
      this.#publish({ tracks: [], position: 0 });
    }
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

import { SubsonicClient, type SubsonicAuth } from "./subsonic-client";

/** Connection ownership and access policy. Engines migrate behind this boundary separately. */
export class Network {
  #mode = $state<"online" | "offline">("offline");
  #client?: SubsonicClient;
  #candidate?: SubsonicClient;

  get mode() {
    return this.#mode;
  }

  setMode(mode: "online" | "offline") {
    this.#mode = mode;
    if (mode === "online") return;
    this.#client?.abort();
    this.#candidate?.abort();
    this.#client = undefined;
    this.#candidate = undefined;
  }

  /** Explicit login validation is allowed while normal access remains offline. */
  prepare(auth: SubsonicAuth) {
    const candidate = new SubsonicClient(auth);
    this.#candidate?.abort();
    this.#candidate = candidate;
    return candidate;
  }

  /** Accept only the live candidate; stale login work must never restore access. */
  accept(candidate: SubsonicClient) {
    candidate.signal.throwIfAborted();
    if (candidate !== this.#candidate) {
      throw new DOMException("Connection superseded.", "AbortError");
    }
    this.#client?.abort();
    this.#client = candidate;
    this.#candidate = undefined;
    this.#mode = "online";
  }

  /** Resume an authenticated session after access has explicitly been enabled. */
  open(auth: SubsonicAuth) {
    if (this.#mode === "offline") throw new Error("Network access is offline.");
    const client = this.prepare(auth);
    this.accept(client);
    return client;
  }
}

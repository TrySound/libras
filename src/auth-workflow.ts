import { createAuth, normalizeServerHost, type Auth, type PasswordAuth } from "./auth";
import type { Network, NetworkConnection } from "./network.svelte";
import { SubsonicError } from "./subsonic-client";

export interface AuthenticatedConnection {
  auth: Auth;
  connection: NetworkConnection;
}

/** Ephemeral authentication policy; Session alone activates accounts and workspaces. */
export class AuthWorkflow {
  #busy = false;
  #controller = new AbortController();
  #network: Network;

  constructor(network: Network) {
    this.#network = network;
  }

  cancel() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#network.cancelPending();
    this.#busy = false;
  }

  async #verify(auth: Auth, signal: AbortSignal): Promise<AuthenticatedConnection> {
    signal.throwIfAborted();
    const connection = this.#network.prepare(auth);
    try {
      await this.#network.validate(connection);
      signal.throwIfAborted();
      connection.signal.throwIfAborted();
      return { auth, connection };
    } catch (error) {
      if (!signal.aborted) this.#network.cancelPending();
      throw error;
    }
  }

  async connect(input: PasswordAuth): Promise<AuthenticatedConnection | undefined> {
    if (this.#busy) return;
    this.cancel();
    const { signal } = this.#controller;
    this.#busy = true;
    try {
      const { password } = input;
      const auth = createAuth(input);
      try {
        return await this.#verify(auth, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SubsonicError && (error.code === 41 || error.code === 42)) {
          normalizeServerHost(auth.host, true);
          return await this.#verify(
            {
              host: auth.host,
              username: auth.username,
              credentials: {
                method: "password",
                username: auth.username,
                password,
              },
            },
            signal,
          );
        }
        throw error;
      }
    } finally {
      if (!signal.aborted) this.#busy = false;
    }
  }
}

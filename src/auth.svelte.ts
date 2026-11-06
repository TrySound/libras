import { createAuth, normalizeServerHost, type Auth, type PasswordAuth } from "./auth";
import type { Network, NetworkConnection } from "./network.svelte";
import { SubsonicError } from "./subsonic-client";

export interface AuthenticatedConnection {
  auth: Auth;
  connection: NetworkConnection;
}

/** Ephemeral authentication policy; Session alone activates accounts and workspaces. */
export class AuthWorkflow {
  passwordConfirmation = $state(false);
  busy = $state(false);
  #pendingPassword?: PasswordAuth;
  #controller = new AbortController();
  #network: Network;

  constructor(network: Network) {
    this.#network = network;
  }

  cancel() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#network.cancelPending();
    this.#pendingPassword = undefined;
    this.passwordConfirmation = false;
    this.busy = false;
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
    if (this.busy || this.passwordConfirmation) return;
    this.cancel();
    const { signal } = this.#controller;
    this.busy = true;
    try {
      const auth = createAuth(input);
      try {
        return await this.#verify(auth, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SubsonicError && (error.code === 41 || error.code === 42)) {
          normalizeServerHost(auth.host, true);
          this.#pendingPassword = { ...input, host: auth.host };
          this.passwordConfirmation = true;
          return;
        }
        throw error;
      }
    } finally {
      if (!signal.aborted) {
        this.busy = false;
        if (this.passwordConfirmation) this.#network.cancelPending();
      }
    }
  }

  /** Only this explicit action can send a newly entered direct password. */
  async confirmPassword(): Promise<AuthenticatedConnection | undefined> {
    const input = this.#pendingPassword;
    if (!input || !this.passwordConfirmation || this.busy) return;
    this.#pendingPassword = undefined;
    this.passwordConfirmation = false;
    const { signal } = this.#controller;
    this.busy = true;
    try {
      normalizeServerHost(input.host, true);
      return await this.#verify(
        {
          host: input.host,
          username: input.username,
          credentials: { method: "password", username: input.username, password: input.password },
        },
        signal,
      );
    } finally {
      if (!signal.aborted) this.busy = false;
    }
  }
}

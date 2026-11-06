import { normalizeServerHost, type Auth } from "./auth";
import { connectionError } from "./errors";
import type { Network, NetworkConnection } from "./network.svelte";
import {
  SubsonicClient,
  SubsonicError,
  SubsonicHttpError,
  createSubsonicAuth,
  getOpenSubsonicExtensions,
  type OpenSubsonicExtension,
} from "./subsonic-client";

export interface PasswordAuth {
  host: string;
  username: string;
  password: string;
}
export type LoginMethod = "apiKey" | "token";
export type LoginInput =
  | (PasswordAuth & { method?: "token" })
  | { host: string; method: "apiKey"; apiKey: string };

export interface AuthenticatedConnection {
  auth: Auth;
  connection: NetworkConnection;
}

export function createAuth(input: PasswordAuth): Auth {
  if (!input.username || !input.password) throw new Error("Enter a username and password.");
  return createSubsonicAuth({ ...input, host: normalizeServerHost(input.host) });
}

/** Ephemeral login policy and secrets. AuthStore persists; Session activates the workspace.
 * Discovery/key requests share one attempt controller; Network owns candidate lifetimes. */
export class AuthWorkflow {
  host = $state("");
  method = $state<LoginMethod>("token");
  passwordConfirmation = $state(false);
  busy = $state(false);
  error = $state("");

  #extensions: readonly OpenSubsonicExtension[] = [];
  #pendingPassword?: PasswordAuth;
  #controller = new AbortController();
  #network: Network;
  #enabled: () => boolean;

  constructor(network: Network, enabled: () => boolean = () => true) {
    this.#network = network;
    this.#enabled = enabled;
  }

  cancel(resetDiscovery = true) {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#network.cancelPending();
    this.#pendingPassword = undefined;
    this.passwordConfirmation = false;
    this.busy = false;
    this.error = "";
    if (resetDiscovery) {
      this.host = "";
      this.method = "token";
      this.#extensions = [];
    }
  }

  setMethod(method: LoginMethod) {
    if (!this.#enabled()) return;
    this.cancel(false);
    this.method = method;
  }

  async #discover(host: string, signal: AbortSignal) {
    if (this.#network.protocol === "alternate") return [];
    normalizeServerHost(host);
    try {
      return await getOpenSubsonicExtensions(host, {}, signal);
    } catch (error) {
      signal.throwIfAborted();
      // Only explicit endpoint absence is evidence for legacy discovery.
      if (error instanceof SubsonicHttpError && [404, 405, 501].includes(error.status)) return [];
      throw error;
    }
  }

  async discover(input: string): Promise<boolean> {
    if (!this.#enabled()) return false;
    this.cancel();
    const { signal } = this.#controller;
    this.busy = true;
    try {
      const host = normalizeServerHost(input);
      const extensions = await this.#discover(host, signal);
      signal.throwIfAborted();
      this.host = host;
      this.#extensions = extensions;
      this.method = extensions.some(
        (item) => item.name === "apiKeyAuthentication" && item.versions.includes(1),
      )
        ? "apiKey"
        : "token";
      return true;
    } catch (error) {
      if (!signal.aborted) this.error = connectionError(error);
      return false;
    } finally {
      if (!signal.aborted) this.busy = false;
    }
  }

  async #resolveApiKey(
    host: string,
    apiKey: string,
    extensions: readonly OpenSubsonicExtension[],
    signal: AbortSignal,
  ): Promise<Auth> {
    if (this.#network.protocol === "alternate")
      throw new Error("This connection does not support API-key login.");
    const client = new SubsonicClient(
      { host, credentials: { method: "apiKey", apiKey } },
      { extensions },
    );
    try {
      const { username } = await client.tokenInfo(signal);
      signal.throwIfAborted();
      return { host, username, credentials: { method: "apiKey", apiKey } };
    } finally {
      client.abort();
    }
  }

  #offerPassword(input: PasswordAuth) {
    normalizeServerHost(input.host, true);
    this.#network.cancelPending();
    this.#pendingPassword = { ...input };
    this.passwordConfirmation = true;
  }

  async #verify(
    auth: Auth,
    extensions: readonly OpenSubsonicExtension[],
    signal: AbortSignal,
    validate = true,
  ): Promise<AuthenticatedConnection> {
    signal.throwIfAborted();
    const connection = this.#network.prepare(auth, extensions);
    if (validate) await this.#network.validate(connection);
    signal.throwIfAborted();
    connection.signal.throwIfAborted();
    return { auth, connection };
  }

  async connect(input: LoginInput): Promise<AuthenticatedConnection | undefined> {
    if (!this.#enabled() || this.busy || this.passwordConfirmation) return;
    // Capture before discovery so a superseding discovery cannot continue this login.
    let signal = this.#controller.signal;
    try {
      const host = normalizeServerHost(input.host);
      if (host !== this.host) {
        const discovery = this.discover(host);
        signal = this.#controller.signal;
        if (!(await discovery)) return;
        signal.throwIfAborted();
      }
      const method = input.method ?? this.method;
      this.setMethod(method);
      signal = this.#controller.signal;
      this.busy = true;
      if (method === "apiKey") {
        if (!("apiKey" in input) || !input.apiKey) throw new Error("Enter an API key.");
        const auth = await this.#resolveApiKey(host, input.apiKey, this.#extensions, signal);
        return await this.#verify(auth, this.#extensions, signal);
      }
      if (!("username" in input) || !input.username || !input.password)
        throw new Error("Enter a username and password.");
      const password = { host, username: input.username, password: input.password };
      try {
        return await this.#verify(createAuth(password), this.#extensions, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SubsonicError && [41, 42].includes(error.code ?? -1)) {
          this.error = connectionError(error);
          this.#offerPassword(password);
          return;
        }
        throw error;
      }
    } catch (error) {
      if (!signal.aborted) {
        this.#network.cancelPending();
        this.error = connectionError(error);
      }
    } finally {
      if (!signal.aborted) this.busy = false;
    }
  }

  /** The only action that sends a newly entered direct password. */
  async confirmPassword(): Promise<AuthenticatedConnection | undefined> {
    const input = this.#pendingPassword;
    if (!this.#enabled() || !input || !this.passwordConfirmation || this.busy) return;
    this.#pendingPassword = undefined;
    this.passwordConfirmation = false;
    const { signal } = this.#controller;
    this.error = "";
    this.busy = true;
    try {
      normalizeServerHost(input.host, true);
      return await this.#verify(
        {
          host: input.host,
          username: input.username,
          credentials: { method: "password", username: input.username, password: input.password },
        },
        this.#extensions,
        signal,
      );
    } catch (error) {
      if (!signal.aborted) {
        this.#network.cancelPending();
        this.error = connectionError(error);
      }
    } finally {
      if (!signal.aborted) this.busy = false;
    }
  }

  /** Resume never downgrades or rewrites a saved identity. Local restoration is independent. */
  async resume(auth: Auth): Promise<AuthenticatedConnection> {
    this.cancel();
    const { signal } = this.#controller;
    try {
      const extensions = await this.#discover(auth.host, signal);
      signal.throwIfAborted();
      if (auth.credentials.method === "apiKey") {
        const resolved = await this.#resolveApiKey(
          auth.host,
          auth.credentials.apiKey,
          extensions,
          signal,
        );
        signal.throwIfAborted();
        if (resolved.username !== auth.username)
          throw new Error("The saved API key belongs to a different account.");
      }
      return await this.#verify(auth, extensions, signal, auth.credentials.method === "apiKey");
    } catch (error) {
      signal.throwIfAborted();
      this.#network.cancelPending();
      throw error;
    }
  }
}

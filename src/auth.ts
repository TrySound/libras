import * as v from "valibot";
import { md5 } from "js-md5";
import { accountSchema, type Account } from "./schema";
import type { Network, NetworkConnection } from "./network.svelte";
import { SubsonicError } from "./subsonic-client";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

export const credentialsSchema = v.variant("method", [
  v.object({ method: v.literal("token"), username: nonEmpty, token: nonEmpty, salt: nonEmpty }),
  v.object({ method: v.literal("password"), username: nonEmpty, password: nonEmpty }),
]);
export type Credentials = v.InferOutput<typeof credentialsSchema>;

/** Connection address and resolved account identity, separate from wire credentials. */
export const authSchema = v.pipe(
  v.object({
    host: v.pipe(v.string(), v.url()),
    username: nonEmpty,
    credentials: credentialsSchema,
  }),
  v.check(
    (auth) => auth.username === auth.credentials.username,
    "Credential usernames must match.",
  ),
);
const legacyAuthSchema = v.object({
  host: v.pipe(v.string(), v.url()),
  username: nonEmpty,
  token: nonEmpty,
  salt: nonEmpty,
});
export type Auth = v.InferOutput<typeof authSchema>;
export interface PasswordAuth {
  host: string;
  username: string;
  password: string;
}

/** Preserve historical host spelling for account/cache identity across methods. */
export function normalizeServerHost(input: string, password = false): string {
  const host = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(host) ? host : `https://${host}`);
  } catch {
    throw new Error("Enter a valid server address.");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Use a server address without user information, query parameters, or fragments.",
    );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && import.meta.env.DEV && loopback && !password)
  )
    throw new Error(
      password
        ? "Direct password authentication requires HTTPS."
        : "Server connections require HTTPS (HTTP loopback is development-only).",
    );
  return url.toString().replace(/\/$/, "");
}

/** Derive token credentials locally; never retain the entered password. */
export function createAuth(
  input: PasswordAuth,
): Auth & { credentials: Extract<Credentials, { method: "token" }> } {
  if (!input.username || !input.password) throw new Error("Enter a username and password.");
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    host: normalizeServerHost(input.host),
    username: input.username,
    credentials: {
      method: "token",
      username: input.username,
      token: md5(input.password + salt),
      salt,
    },
  };
}

/** Verify token credentials, retrying with a password only when tokens are unsupported. */
export async function authenticate(
  input: PasswordAuth,
  network: Network,
  signal: AbortSignal,
): Promise<{ auth: Auth; connection: NetworkConnection }> {
  const { password } = input;
  const auth = createAuth(input);

  async function verify(auth: Auth) {
    signal.throwIfAborted();
    const connection = network.prepare(auth);
    try {
      await network.validate(connection);
      signal.throwIfAborted();
      connection.signal.throwIfAborted();
      return { auth, connection };
    } catch (error) {
      if (!signal.aborted) network.cancelPending();
      throw error;
    }
  }

  try {
    return await verify(auth);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof SubsonicError) || (error.code !== 41 && error.code !== 42)) throw error;
    normalizeServerHost(auth.host, true);
    return verify({
      host: auth.host,
      username: auth.username,
      credentials: { method: "password", username: auth.username, password },
    });
  }
}

/** Stable account identity. Cache hashes this opaque key for its storage directory. */
export function getAccountKey(account: Account): string {
  return JSON.stringify([account.host, account.username]);
}

export class AuthStore {
  #key: string;
  #storage: Storage;

  constructor(storage: Storage = localStorage, key = "navidrome-auth") {
    this.#storage = storage;
    this.#key = key;
  }

  /** Preferences for an application entry point share its auth storage scope. */
  get storage(): Storage {
    return this.#storage;
  }

  load(): Auth | null {
    const value = this.#storage.getItem(this.#key);
    if (!value) return null;
    let migrated: Auth;
    try {
      const input = JSON.parse(value);
      if (!input || typeof input !== "object" || "credentials" in input)
        return v.parse(authSchema, input);
      const legacy = v.parse(legacyAuthSchema, input);
      migrated = {
        host: legacy.host,
        username: legacy.username,
        credentials: {
          method: "token",
          username: legacy.username,
          token: legacy.token,
          salt: legacy.salt,
        },
      };
    } catch {
      throw new Error("The saved Subsonic authentication is invalid.");
    }
    try {
      this.save(migrated);
    } catch {
      // Quota failures must not invalidate or delete usable legacy credentials.
    }
    return migrated;
  }

  save(auth: Auth) {
    const parsed = v.safeParse(authSchema, auth);
    if (!parsed.success) throw new Error("The Subsonic authentication is invalid.");
    this.#storage.setItem(this.#key, JSON.stringify(parsed.output));
  }

  clear() {
    this.#storage.removeItem(this.#key);
  }

  loadAccount(): Account | null {
    const value = this.#storage.getItem("navidrome-account");
    if (!value) return null;
    try {
      return v.parse(accountSchema, JSON.parse(value));
    } catch {
      this.#storage.removeItem("navidrome-account");
      return null;
    }
  }

  saveAccount(account: Account) {
    this.#storage.setItem(
      "navidrome-account",
      JSON.stringify(
        v.parse(accountSchema, {
          host: account.host,
          username: account.username,
        }),
      ),
    );
  }
}

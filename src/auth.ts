import * as v from "valibot";
import { accountSchema, type Account } from "./schema";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

export const credentialsSchema = v.variant("method", [
  v.object({ method: v.literal("apiKey"), apiKey: nonEmpty }),
  v.object({ method: v.literal("token"), username: nonEmpty, token: nonEmpty, salt: nonEmpty }),
  v.object({ method: v.literal("password"), username: nonEmpty, password: nonEmpty }),
]);

export type Credentials = v.InferOutput<typeof credentialsSchema>;

/** Host and resolved account identity are independent of the authentication method. */
export const authSchema = v.pipe(
  v.object({
    host: v.pipe(v.string(), v.url()),
    username: nonEmpty,
    credentials: credentialsSchema,
  }),
  v.check(
    (auth) => auth.credentials.method === "apiKey" || auth.username === auth.credentials.username,
    "The account and credential usernames must match.",
  ),
);

const legacyAuthSchema = v.object({
  host: v.pipe(v.string(), v.url()),
  username: nonEmpty,
  token: nonEmpty,
  salt: nonEmpty,
});

export type Auth = v.InferOutput<typeof authSchema>;

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
      // Writeback is best-effort: valid legacy credentials remain usable and saved.
    }
    return migrated;
  }

  /** All credential methods persist on this device until disconnect. */
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

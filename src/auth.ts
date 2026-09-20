import * as v from "valibot";
import { accountSchema, type Account } from "./schema";

export const authSchema = v.object({
  host: v.pipe(v.string(), v.url()),
  username: v.pipe(v.string(), v.nonEmpty()),
  token: v.pipe(v.string(), v.nonEmpty()),
  salt: v.pipe(v.string(), v.nonEmpty()),
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
    try {
      return v.parse(authSchema, JSON.parse(value));
    } catch {
      throw new Error("The saved Subsonic authentication is invalid.");
    }
  }

  save(auth: Auth) {
    this.#storage.setItem(this.#key, JSON.stringify(v.parse(authSchema, auth)));
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

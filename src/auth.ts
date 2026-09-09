import * as v from "valibot";
import { accountSchema, type MetadataAccount } from "./schema";

export const authSchema = v.object({
  host: v.pipe(v.string(), v.url()),
  username: v.pipe(v.string(), v.nonEmpty()),
  token: v.pipe(v.string(), v.nonEmpty()),
  salt: v.pipe(v.string(), v.nonEmpty()),
});

export type Auth = v.InferOutput<typeof authSchema>;

export class AuthStore {
  #key: string;
  #storage: Storage;

  constructor(storage: Storage = localStorage, key = "navidrome-auth") {
    this.#storage = storage;
    this.#key = key;
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

  loadAccount(): MetadataAccount | null {
    const value = this.#storage.getItem("navidrome-account");
    if (!value) return null;
    try {
      return v.parse(accountSchema, JSON.parse(value));
    } catch {
      this.#storage.removeItem("navidrome-account");
      return null;
    }
  }

  saveAccount(account: MetadataAccount) {
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

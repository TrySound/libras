import { describe, expect, it } from "vitest";
import { AuthStore, getAccountKey } from "../src/auth";

describe("getAccountKey", () => {
  const account = { host: "https://music.example", username: "listener" };

  it("preserves the identity format used by existing cache directories", () => {
    expect(getAccountKey(account)).toBe('["https://music.example","listener"]');
    expect(getAccountKey({ username: account.username, host: account.host })).toBe(
      getAccountKey(account),
    );
  });

  it("does not include credentials in account identity", () => {
    const first = { ...account, token: "old", salt: "old" };
    const second = { ...account, token: "new", salt: "new" };
    expect(getAccountKey(first)).toBe(getAccountKey(second));
    expect(getAccountKey(first)).toBe(getAccountKey(account));
  });

  it("distinguishes hosts, usernames, and delimiter-containing values", () => {
    const identities = [
      account,
      { ...account, host: "https://other.example" },
      { ...account, username: "other" },
      { host: "https://music.example/a", username: "b/c" },
      { host: "https://music.example/a/b", username: "c" },
      { ...account, username: 'listener", "other' },
    ];
    expect(new Set(identities.map(getAccountKey)).size).toBe(identities.length);
  });
});

class MemoryStorage implements Storage {
  #values = new Map<string, string>();
  get length() {
    return this.#values.size;
  }
  clear() {
    this.#values.clear();
  }
  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#values.delete(key);
  }
  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}

describe("auth store", () => {
  it("persists only validated credential fields, never a supplied password", () => {
    const storage = new MemoryStorage();
    const store = new AuthStore(storage);
    const credentials = {
      host: "https://music.example.com",
      username: "listener",
      token: "token",
      salt: "salt",
      password: "secret",
    };
    store.save(credentials);
    expect(JSON.parse(storage.getItem("navidrome-auth")!)).toEqual({
      host: "https://music.example.com",
      username: "listener",
      token: "token",
      salt: "salt",
    });
  });

  it("persists and validates authentication", () => {
    const storage = new MemoryStorage();
    const store = new AuthStore(storage);
    const auth = {
      host: "https://music.example.com",
      username: "listener",
      token: "token",
      salt: "salt",
    };

    store.save(auth);
    store.saveAccount(auth);
    expect(store.load()).toEqual(auth);
    expect(JSON.parse(storage.getItem("navidrome-account")!)).toEqual({
      host: auth.host,
      username: auth.username,
    });
    store.clear();
    expect(store.load()).toBeNull();
    expect(new AuthStore(storage).loadAccount()).toEqual({
      host: auth.host,
      username: auth.username,
    });
  });

  it("discards malformed or credential-bearing last-account records", () => {
    const storage = new MemoryStorage();
    const store = new AuthStore(storage);
    for (const record of [
      { host: "server" },
      { host: "server", username: "user", token: "secret" },
    ]) {
      storage.setItem("navidrome-account", JSON.stringify(record));
      expect(store.loadAccount()).toBeNull();
      expect(storage.getItem("navidrome-account")).toBeNull();
    }
  });

  it("rejects malformed persisted authentication", () => {
    const storage = new MemoryStorage();
    storage.setItem("navidrome-auth", JSON.stringify({ host: "invalid" }));
    const store = new AuthStore(storage);

    expect(() => store.load()).toThrow("authentication is invalid");
  });
});

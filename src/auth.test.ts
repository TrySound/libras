import { describe, expect, it } from "vitest";
import { AuthStore } from "./auth";

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
  it("creates normalized salted token authentication", () => {
    const store = new AuthStore(new MemoryStorage());
    const auth = store.create({
      host: "music.example.com/",
      username: "listener",
      password: "secret",
    });

    expect(auth.host).toBe("https://music.example.com");
    expect(auth.username).toBe("listener");
    expect(auth.salt).toMatch(/^[a-f0-9]{24}$/);
    expect(auth.token).toMatch(/^[a-f0-9]{32}$/);
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

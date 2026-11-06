import { describe, expect, it, vi } from "vitest";
import { AuthStore, getAccountKey, type Auth, type Credentials } from "../src/auth";

const account = { host: "https://music.example", username: "listener" };
const methods: Credentials[] = [
  { method: "token", username: account.username, token: "token", salt: "salt" },
  { method: "apiKey", apiKey: "api-secret" },
  { method: "password", username: account.username, password: "password-secret" },
];

describe("getAccountKey", () => {
  it("preserves the exact identity format across authentication methods", () => {
    expect(getAccountKey(account)).toBe('["https://music.example","listener"]');
    expect(getAccountKey({ username: account.username, host: account.host })).toBe(
      getAccountKey(account),
    );
    for (const credentials of methods) {
      const auth = { ...account, credentials };
      expect(getAccountKey(auth)).toBe(getAccountKey(account));
    }
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

function setup() {
  const persistent = new MemoryStorage();
  return { persistent, store: new AuthStore(persistent) };
}

describe("auth store", () => {
  it("migrates saved token credentials without changing account identity or forcing logout", () => {
    const { persistent, store } = setup();
    persistent.setItem(
      "navidrome-auth",
      JSON.stringify({ ...account, token: "token", salt: "salt", password: "discard" }),
    );
    const auth = store.load()!;
    expect(auth).toEqual({ ...account, credentials: methods[0] });
    expect(getAccountKey(auth)).toBe(getAccountKey(account));
    expect(JSON.parse(persistent.getItem("navidrome-auth")!)).toEqual(auth);
    expect(store.load()).toEqual(auth);
  });

  it("retains valid legacy credentials when migration writeback fails", () => {
    const { persistent: storage, store } = setup();
    const original = JSON.stringify({ ...account, token: "token", salt: "salt" });
    storage.setItem("navidrome-auth", original);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    expect(store.load()).toEqual({ ...account, credentials: methods[0] });
    expect(storage.getItem("navidrome-auth")).toBe(original);
    expect(store.load()).toEqual({ ...account, credentials: methods[0] });
    expect(storage.getItem("navidrome-auth")).toBe(original);
  });

  it.each(methods)("persists $method credentials and strips unrelated secrets", (credentials) => {
    const { persistent, store } = setup();
    const auth = {
      ...account,
      credentials: { unrelatedSecret: "discard", ...credentials },
      password: "discard",
    };
    store.save(auth);
    expect(JSON.parse(persistent.getItem("navidrome-auth")!)).toEqual({
      ...account,
      credentials,
    });
    expect(new AuthStore(persistent).load()).toEqual({ ...account, credentials });
  });

  it.each(methods)(
    "clears $method credentials while retaining the credential-free account",
    (credentials) => {
      const { persistent, store } = setup();
      const auth = { ...account, credentials };
      store.save(auth);
      store.saveAccount(auth);
      store.clear();
      expect(persistent.getItem("navidrome-auth")).toBeNull();
      expect(new AuthStore(persistent).load()).toBeNull();
      expect(store.loadAccount()).toEqual(account);
      expect(JSON.parse(persistent.getItem("navidrome-account")!)).toEqual(account);
    },
  );

  it("isolates the demo's injected store from real browser credentials", () => {
    const browser = new MemoryStorage();
    browser.setItem("navidrome-auth", JSON.stringify({ ...account, credentials: methods[2] }));
    vi.stubGlobal("localStorage", browser);
    try {
      const persistent = new MemoryStorage();
      const store = new AuthStore(persistent);
      expect(store.load()).toBeNull();
      store.save({ ...account, credentials: methods[0] });
      expect(store.load()?.credentials.method).toBe("token");
      store.save({ ...account, credentials: methods[2] });
      expect(new AuthStore(persistent).load()?.credentials.method).toBe("password");
      store.clear();
      expect(new AuthStore().load()?.credentials.method).toBe("password");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults to browser localStorage", () => {
    const persistent = new MemoryStorage();
    vi.stubGlobal("localStorage", persistent);
    try {
      const auth = { ...account, credentials: methods[2] };
      new AuthStore().save(auth);
      expect(JSON.parse(persistent.getItem("navidrome-auth")!)).toEqual(auth);
      expect(new AuthStore().load()).toEqual(auth);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("discards malformed or credential-bearing last-account records", () => {
    const { persistent, store } = setup();
    for (const record of [
      { host: "server" },
      { host: "server", username: "user", token: "secret" },
    ]) {
      persistent.setItem("navidrome-account", JSON.stringify(record));
      expect(store.loadAccount()).toBeNull();
      expect(persistent.getItem("navidrome-account")).toBeNull();
    }
  });

  it.each([
    { host: "invalid" },
    { ...account, token: "", salt: "secret" },
    { ...account, token: "secret" },
    { ...account, credentials: { method: "unknown", password: "secret" } },
    { ...account, credentials: { method: "apiKey", apiKey: "" } },
    { ...account, credentials: { method: "token", username: "listener", salt: "secret" } },
    { ...account, credentials: { method: "password", username: "listener", password: "" } },
    {
      ...account,
      credentials: { method: "token", username: "other", token: "token", salt: "salt" },
    },
    { ...account, credentials: { method: "password", username: "other", password: "secret" } },
  ])("rejects malformed records without leaking validation input", (record) => {
    const { persistent, store } = setup();
    persistent.setItem("navidrome-auth", JSON.stringify(record));
    expect(() => store.load()).toThrow("The saved Subsonic authentication is invalid.");
    expect(() => store.save(record as Auth)).toThrow("The Subsonic authentication is invalid.");
  });
});

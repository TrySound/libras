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
  const temporary = new MemoryStorage();
  return { persistent, temporary, store: new AuthStore(persistent, undefined, temporary) };
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

  it.each(["persistent", "temporary"] as const)(
    "retains valid legacy credentials in %s storage when migration writeback fails",
    (source) => {
      const { persistent, temporary, store } = setup();
      const original = JSON.stringify({ ...account, token: "token", salt: "salt" });
      const storage = source === "persistent" ? persistent : temporary;
      storage.setItem("navidrome-auth", original);
      vi.spyOn(persistent, "setItem").mockImplementation(() => {
        throw new DOMException("Storage full", "QuotaExceededError");
      });
      expect(store.load()).toEqual({ ...account, credentials: methods[0] });
      expect(storage.getItem("navidrome-auth")).toBe(original);
      expect(store.load()).toEqual({ ...account, credentials: methods[0] });
      expect(storage.getItem("navidrome-auth")).toBe(original);
    },
  );

  it.each(methods.slice(0, 2))(
    "persists $method credentials and strips unrelated secrets",
    (credentials) => {
      const { persistent, temporary, store } = setup();
      const auth = {
        ...account,
        credentials: { ...credentials, password: "discard" },
        password: "discard",
      };
      store.save(auth);
      expect(JSON.parse(persistent.getItem("navidrome-auth")!)).toEqual({
        ...account,
        credentials,
      });
      expect(temporary.getItem("navidrome-auth")).toBeNull();
      expect(store.load()).toEqual({ ...account, credentials });
    },
  );

  it("defaults passwords to session storage and requires explicit persistence consent", () => {
    const { persistent, temporary, store } = setup();
    const auth = { ...account, credentials: methods[2] };
    store.save({ ...account, credentials: methods[0] });
    store.save(auth);
    expect(persistent.getItem("navidrome-auth")).toBeNull();
    expect(JSON.parse(temporary.getItem("navidrome-auth")!)).toEqual(auth);
    expect(store.load()).toEqual(auth);
    expect(new AuthStore(persistent, undefined, new MemoryStorage()).load()).toBeNull();
    store.save(auth, { rememberPassword: true });
    expect(JSON.parse(persistent.getItem("navidrome-auth")!)).toEqual(auth);
    expect(temporary.getItem("navidrome-auth")).toBeNull();
    store.save(auth);
    expect(persistent.getItem("navidrome-auth")).toBeNull();
  });

  it.each(methods)(
    "clears both stores for $method while retaining the credential-free account",
    (credentials) => {
      const { persistent, temporary, store } = setup();
      const auth = { ...account, credentials };
      for (const storage of [persistent, temporary])
        storage.setItem("navidrome-auth", JSON.stringify(auth));
      store.saveAccount(auth);
      store.clear();
      expect(persistent.getItem("navidrome-auth")).toBeNull();
      expect(temporary.getItem("navidrome-auth")).toBeNull();
      expect(store.load()).toBeNull();
      expect(store.loadAccount()).toEqual(account);
      expect(JSON.parse(persistent.getItem("navidrome-account")!)).toEqual(account);
    },
  );

  it("isolates custom/demo storage from unrelated real browser-session credentials", () => {
    const browserSession = new MemoryStorage();
    browserSession.setItem(
      "navidrome-auth",
      JSON.stringify({ ...account, credentials: methods[2] }),
    );
    vi.stubGlobal("sessionStorage", browserSession);
    try {
      const persistent = new MemoryStorage();
      const store = new AuthStore(persistent);
      expect(store.load()).toBeNull();
      store.save({ ...account, credentials: methods[0] });
      expect(store.load()?.credentials.method).toBe("token");
      store.save({ ...account, credentials: methods[2] });
      expect(persistent.getItem("navidrome-auth")).toBeNull();
      expect(store.load()?.credentials.method).toBe("password");
      expect(new AuthStore(persistent).load()).toBeNull();
      store.clear();
      expect(browserSession.getItem("navidrome-auth") !== null).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attempts both credential removals even if persistent storage fails", () => {
    const { persistent, temporary, store } = setup();
    temporary.setItem("navidrome-auth", "secret");
    persistent.removeItem = () => {
      throw new Error("Storage unavailable");
    };
    expect(() => store.clear()).toThrow("Storage unavailable");
    expect(temporary.getItem("navidrome-auth")).toBeNull();
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
    const { persistent, temporary, store } = setup();
    for (const storage of [persistent, temporary]) {
      storage.setItem("navidrome-auth", JSON.stringify(record));
      expect(() => store.load()).toThrow("The saved Subsonic authentication is invalid.");
      storage.clear();
    }
    expect(() => store.save(record as Auth)).toThrow("The Subsonic authentication is invalid.");
  });
});

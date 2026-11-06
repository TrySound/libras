import { describe, expect, it, vi } from "vitest";
import { AuthStore, createAuth, getAccountKey, normalizeServerHost, type Auth } from "../src/auth";
import { md5 } from "js-md5";

describe("createAuth", () => {
  it("creates salted tokens without retaining or altering the password", () => {
    const input = { host: "https://music.example", username: "listener", password: " secret 音 " };
    const first = createAuth(input);
    const second = createAuth(input);
    expect(first).toEqual({
      host: input.host,
      username: input.username,
      credentials: {
        method: "token",
        username: input.username,
        salt: expect.stringMatching(/^[a-f0-9]{24}$/),
        token: md5(input.password + first.credentials.salt),
      },
    });
    expect(second.credentials.salt).not.toBe(first.credentials.salt);
    expect(second.credentials.token).toBe(md5(input.password + second.credentials.salt));
    expect(input.password).toBe(" secret 音 ");
  });

  it.each([
    [" music.example/ ", "https://music.example"],
    ["https://music.example:4533/music/", "https://music.example:4533/music"],
    ["https://music.example/music/", "https://music.example/music"],
  ])("normalizes %s without fetching", (host, normalized) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(createAuth({ host, username: "listener", password: "secret" }).host).toBe(normalized);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { host: "https://", username: "listener", password: "secret" },
    { host: "https://music.example", username: "", password: "secret" },
    { host: "https://music.example", username: "listener", password: "" },
  ])("rejects invalid input: %j", (input) => {
    expect(() => createAuth(input)).toThrow();
  });
});

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
      credentials: {
        method: "token" as const,
        username: "listener",
        token: "token",
        salt: "salt",
        password: "discard",
      },
      password: "secret",
    };
    store.save(credentials);
    expect(JSON.parse(storage.getItem("navidrome-auth")!)).toEqual({
      host: "https://music.example.com",
      username: "listener",
      credentials: { method: "token", username: "listener", token: "token", salt: "salt" },
    });
  });

  it("persists and validates authentication", () => {
    const storage = new MemoryStorage();
    const store = new AuthStore(storage);
    const auth = {
      host: "https://music.example.com",
      username: "listener",
      credentials: { method: "token" as const, username: "listener", token: "token", salt: "salt" },
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

  it.each([false, true])(
    "migrates legacy tokens without logout even if writeback fails (%s)",
    (fails) => {
      const storage = new MemoryStorage();
      const legacy = {
        host: "https://music.example",
        username: "listener",
        token: "token",
        salt: "salt",
      };
      const original = JSON.stringify(legacy);
      storage.setItem("navidrome-auth", original);
      if (fails)
        vi.spyOn(storage, "setItem").mockImplementation(() => {
          throw new DOMException("Full", "QuotaExceededError");
        });
      const store = new AuthStore(storage);
      const migrated = {
        host: legacy.host,
        username: legacy.username,
        credentials: {
          method: "token",
          username: legacy.username,
          token: legacy.token,
          salt: legacy.salt,
        },
      };
      expect(store.load()).toEqual(migrated);
      expect(store.load()).toEqual(migrated);
      expect(getAccountKey(migrated)).toBe(getAccountKey(legacy));
      expect(storage.getItem("navidrome-auth")).toBe(fails ? original : JSON.stringify(migrated));
    },
  );

  it("persists direct passwords in localStorage until disconnect and retains only account identity", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const auth: Auth = {
        host: "https://music.example",
        username: "listener",
        credentials: { method: "password", username: "listener", password: " secret 音 " },
      };
      const store = new AuthStore();
      store.save(auth);
      store.saveAccount(auth);
      expect(new AuthStore().load()).toEqual(auth);
      expect(getAccountKey(auth)).toBe('["https://music.example","listener"]');
      store.clear();
      expect(new AuthStore().load()).toBeNull();
      expect(store.loadAccount()).toEqual({ host: auth.host, username: auth.username });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects mismatched usernames and unknown or incomplete credentials without exposing secrets", () => {
    const store = new AuthStore(new MemoryStorage());
    for (const credentials of [
      { method: "unknown", password: "secret" },
      { method: "token", username: "listener", salt: "secret" },
      { method: "password", username: "other", password: "secret" },
    ])
      expect(() =>
        store.save({ host: "https://music.example", username: "listener", credentials } as Auth),
      ).toThrow("The Subsonic authentication is invalid.");
  });

  it("rejects unsafe server addresses and requires HTTPS for direct passwords", () => {
    for (const host of [
      "http://remote.example",
      "ftp://music.example",
      "https://u:p@music.example",
      "https://music.example/?t=secret",
      "https://music.example/#secret",
    ])
      expect(() => normalizeServerHost(host)).toThrow();
    expect(normalizeServerHost(" music.example/base/ ")).toBe("https://music.example/base");
    expect(normalizeServerHost("http://localhost:4533")).toBe("http://localhost:4533");
    expect(() => normalizeServerHost("http://localhost:4533", true)).toThrow("requires HTTPS");
    vi.stubEnv("DEV", false);
    try {
      expect(() => normalizeServerHost("http://localhost:4533")).toThrow("require HTTPS");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed persisted authentication", () => {
    const storage = new MemoryStorage();
    storage.setItem("navidrome-auth", JSON.stringify({ host: "invalid" }));
    const store = new AuthStore(storage);

    expect(() => store.load()).toThrow("authentication is invalid");
  });
});

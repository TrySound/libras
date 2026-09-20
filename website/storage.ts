/** Isolate demo preferences/auth/queue without changing the regular app's storage. */
export class NamespacedStorage implements Storage {
  constructor(
    private storage: Storage,
    private prefix: string,
  ) {
    if (!prefix) throw new Error("A storage namespace is required.");
  }

  private keys() {
    const keys: string[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.prefix)) keys.push(key.slice(this.prefix.length));
    }
    return keys;
  }

  get length() {
    return this.keys().length;
  }
  key(index: number) {
    return this.keys()[index] ?? null;
  }
  getItem(key: string) {
    return this.storage.getItem(this.prefix + key);
  }
  setItem(key: string, value: string) {
    this.storage.setItem(this.prefix + key, value);
  }
  removeItem(key: string) {
    this.storage.removeItem(this.prefix + key);
  }
  clear() {
    for (const key of this.keys()) this.removeItem(key);
  }
}

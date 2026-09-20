/** Demo auth, preferences and simulated server queue live only for this runtime. */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();

  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(String(key)) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(String(key), String(value));
  }
  removeItem(key: string) {
    this.items.delete(String(key));
  }
  clear() {
    this.items.clear();
  }
}

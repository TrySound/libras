import { SvelteSet } from "svelte/reactivity";
import { getAccountKey } from "./auth";
import type { CacheSelection } from "./cache.svelte";
import type { FavouritesConnection } from "./network.svelte";
import type { FavouriteTarget } from "./schema";
import { SubsonicError } from "./subsonic-client";

/** One ephemeral server-operation chain, never an offline outbox. */
export class Favourites {
  #selection: CacheSelection;
  #connection?: FavouritesConnection;
  #generation = 0;
  #tail: Promise<unknown> = Promise.resolve();
  pending = new SvelteSet<string>();
  loading = $state(false);
  available = $state(false);
  error = $state.raw<unknown>();
  #unknown = $state(false);
  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }
  setConnection(connection?: FavouritesConnection) {
    this.#connection = connection;
    this.#generation++;
    this.#tail = Promise.resolve();
    this.pending.clear();
    this.loading = false;
    this.available = !!connection && !connection.signal.aborted;
    this.error = undefined;
    this.#unknown = false;
  }
  key(target: FavouriteTarget) {
    return JSON.stringify([target.kind, target.id]);
  }
  has(target: FavouriteTarget) {
    return (
      this.#selection.cache?.favourites[target.kind].some((item) => item.id === target.id) ?? false
    );
  }
  targetError(target: FavouriteTarget) {
    // A server-starred description independently proves a genuine target for removal,
    // even when its library record is missing or predates normalization provenance.
    if (target.kind === "tracks" || this.has(target)) return "";
    const cache = this.#selection.cache;
    const record =
      target.kind === "artists" ? cache?.artists.get(target.id) : cache?.albums.get(target.id);
    if (record?.localOnly === true)
      return "This local collection is not a server favourite target.";
    if (record?.localOnly !== false)
      return "Refresh the library to verify this legacy favourite target before adding it.";
    return "";
  }
  get outcomeUnknown() {
    return this.#unknown;
  }
  #scope() {
    const cache = this.#selection.cache;
    const connection = this.#connection;
    const generation = this.#generation;
    if (
      !cache ||
      !connection ||
      connection.signal.aborted ||
      cache.key !== getAccountKey(connection.account)
    )
      throw new Error("Reconnect to edit favourites.");
    const current = () =>
      this.#generation === generation &&
      this.#selection.cache === cache &&
      !connection.signal.aborted;
    const check = () => {
      if (!current()) throw new DOMException("Favourites operation superseded.", "AbortError");
    };
    return { cache, connection, current, check };
  }
  #serialize(action: () => Promise<void>) {
    const result = this.#tail.catch(() => {}).then(action);
    this.#tail = result;
    return result;
  }
  async refresh(): Promise<void> {
    const scope = this.#scope();
    return this.#serialize(async () => {
      scope.check();
      this.loading = true;
      try {
        const state = await scope.connection.read();
        scope.check();
        scope.cache.setFavourites(state);
        this.error = undefined;
        this.#unknown = false;
      } catch (error) {
        if (scope.current()) this.error = error;
        throw error;
      } finally {
        if (scope.current()) this.loading = false;
      }
    });
  }
  async toggle(target: FavouriteTarget) {
    const scope = this.#scope();
    const targetError = this.targetError(target);
    if (targetError) throw new Error(targetError);
    const key = this.key(target);
    if (this.pending.has(key)) return;
    if (this.#unknown) throw new Error("Outcome unknown; refresh before retrying.");
    this.pending.add(key);
    const selected = !this.has(target);
    try {
      await this.#serialize(async () => {
        scope.check();
        if (this.#unknown) throw new Error("Outcome unknown; refresh before retrying.");
        try {
          await scope.connection.mutate(target, selected);
        } catch (error) {
          scope.check();
          if (error instanceof SubsonicError) throw error;
          // The write may have applied. Reconcile once; never repeat it.
        }
        scope.check();
        try {
          const state = await scope.connection.read();
          scope.check();
          scope.cache.setFavourites(state);
          this.#unknown = false;
          this.error = undefined;
        } catch (error) {
          scope.check();
          this.#unknown = true;
          throw new Error("Outcome unknown; refresh before retrying.");
        }
        if (this.has(target) !== selected)
          throw new Error("The edit was not confirmed. Check the server and try again.");
      });
    } catch (error) {
      if (scope.current()) this.error = error;
      throw error;
    } finally {
      if (scope.current()) this.pending.delete(key);
    }
  }
  destroy() {
    this.setConnection(undefined);
  }
}

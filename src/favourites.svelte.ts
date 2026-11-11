import { SvelteSet, SvelteMap } from "svelte/reactivity";
import { getAccountKey } from "./auth";
import type { Cache, CacheSelection } from "./cache.svelte";
import type { FavouritesConnection } from "./network.svelte";
import type { FavouriteTarget } from "./schema";
import { SubsonicError } from "./subsonic-client";

/** One ephemeral server-operation chain, never an offline outbox. */
export class Favourites {
  #selection: CacheSelection;
  #connection?: FavouritesConnection;
  #generation = 0;
  #tail: Promise<unknown> = Promise.resolve();
  pending = new SvelteMap<string, boolean>();
  loading = $state(false);
  available = $state(false);
  error = $state.raw<unknown>();
  // Submitted writes remain unresolved for their captured cache until an authoritative
  // read (or structured rejection), even when their connection is retired.
  #unresolved = new SvelteSet<Cache>();
  #submitted = $state.raw<{ cache: Cache }>();
  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }
  setConnection(connection?: FavouritesConnection) {
    this.#submitted = undefined;
    this.#connection = connection;
    this.#generation++;
    this.#tail = Promise.resolve();
    this.pending.clear();
    this.loading = false;
    this.available = !!connection && !connection.signal.aborted;
    this.error = undefined;
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
    const cache = this.#selection.cache;
    return !!cache && this.#unresolved.has(cache) && this.#submitted?.cache !== cache;
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
        this.#unresolved.delete(scope.cache);
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
    if (this.outcomeUnknown) throw new Error("Outcome unknown; refresh before retrying.");
    const selected = !this.has(target);
    this.pending.set(key, selected);
    try {
      await this.#serialize(async () => {
        scope.check();
        if (this.outcomeUnknown) throw new Error("Outcome unknown; refresh before retrying.");
        const submitted = { cache: scope.cache };
        this.#submitted = submitted;
        this.#unresolved.add(scope.cache);
        try {
          try {
            await scope.connection.mutate(target, selected);
          } catch (error) {
            scope.check();
            if (error instanceof SubsonicError) {
              this.#unresolved.delete(scope.cache);
              throw error;
            }
            // The write may have applied. Reconcile once; never repeat it.
          }
          scope.check();
          try {
            const state = await scope.connection.read();
            scope.check();
            scope.cache.setFavourites(state);
            this.#unresolved.delete(scope.cache);
            this.error = undefined;
          } catch (error) {
            scope.check();
            throw new Error(
              `Outcome unknown; refresh before retrying. ${error instanceof Error ? error.message : "Could not reconcile favourites."}`,
            );
          }
          if (this.has(target) !== selected)
            throw new Error("The edit was not confirmed. Check the server and try again.");
        } finally {
          if (this.#submitted === submitted) this.#submitted = undefined;
        }
      });
    } catch (error) {
      if (scope.current()) this.error = error;
      throw error;
    } finally {
      if (scope.current()) {
        this.pending.delete(key);
      }
    }
  }
  destroy() {
    this.setConnection(undefined);
  }
}

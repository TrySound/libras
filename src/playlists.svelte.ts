import { getAccountKey } from "./auth";
import type { CacheSelection, Immutable } from "./cache.svelte";
import type { PlaylistAction, PlaylistConnection, PlaylistEditAction } from "./network.svelte";
import type { Playlist, PlaylistDetail } from "./schema";

export class PlaylistConflictError extends Error {
  constructor() {
    super(
      "The playlist changed on the server. Reload it before editing or explicitly overwrite it.",
    );
  }
}

/** Server-confirmed playlists. No offline outbox or optimistic mutations. */
export class Playlists {
  #selection: CacheSelection;
  #connection?: PlaylistConnection;
  #pending = new Map<string, Promise<unknown>>();
  #generation = 0;
  #destroyed = false;
  loading = $state(false);
  error = $state.raw<unknown>();
  saving = $state(false);

  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }

  setConnection(connection: PlaylistConnection | undefined) {
    if (this.#connection === connection) return;
    this.#connection = connection;
    this.#generation++;
    this.loading = false;
    this.saving = false;
    this.#pending.clear();
  }

  #scope() {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    if (
      !connection ||
      !cache ||
      cache.key !== getAccountKey(connection.account) ||
      connection.signal.aborted ||
      this.#destroyed
    )
      throw new Error("Playlist edits require a connection.");
    const generation = this.#generation;
    const current = () =>
      !this.#destroyed &&
      this.#generation === generation &&
      !connection.signal.aborted &&
      this.#selection.cache === cache;
    return {
      connection,
      cache,
      current,
      check: () => {
        if (!current()) throw new DOMException("Playlist operation superseded.", "AbortError");
      },
    };
  }

  async refresh() {
    const scope = this.#scope();
    const { cache, connection, check } = scope;
    const previous = cache.playlists;
    this.loading = true;
    this.error = undefined;
    try {
      const summaries = await connection.list();
      check();
      // Do not replace newer details or list changes from a concurrent edit.
      if (cache.playlists !== previous) return;
      const ids = new Set(summaries.map((item) => item.id));
      cache.setPlaylists({
        listedAt: Date.now(),
        summaries,
        details: previous.details.filter((item) => ids.has(item.summary.id)),
      });
    } catch (error) {
      if (scope.current()) this.error = error;
      throw error;
    } finally {
      if (scope.current()) this.loading = false;
    }
  }

  async open(id: string): Promise<Immutable<PlaylistDetail>> {
    const scope = this.#scope();
    const { cache, connection, check } = scope;
    const previous = cache.playlists;
    try {
      const result = await connection.read(id);
      check();
      const detail = { ...result, fetchedAt: Date.now() };
      if (cache.playlists !== previous) {
        // A newer edit/refresh won while this read was pending.
        const winner = cache.playlists.details.find((item) => item.summary.id === id);
        if (winner) return winner;
        if (cache.playlists.summaries.some((item) => item.id === id) && !this.#pending.has(id)) {
          this.#publishDetail(cache, detail);
          return detail;
        }
        throw new DOMException("Playlist read superseded.", "AbortError");
      }
      this.#publishDetail(cache, detail);
      return detail;
    } catch (error) {
      if (scope.current()) this.error = error;
      throw error;
    }
  }

  #publishDetail(cache: NonNullable<CacheSelection["cache"]>, detail: PlaylistDetail) {
    const state = cache.playlists;
    cache.setPlaylists({
      ...state,
      summaries: state.summaries.some((item) => item.id === detail.summary.id)
        ? state.summaries.map((item) => (item.id === detail.summary.id ? detail.summary : item))
        : [...state.summaries, detail.summary],
      details: [...state.details.filter((item) => item.summary.id !== detail.summary.id), detail],
    });
  }

  // One mutation at a time per playlist. A failure does not poison the chain.
  #serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    this.#pending.set(id, result);
    void result
      .finally(() => {
        if (this.#pending.get(id) === result) this.#pending.delete(id);
      })
      .catch(() => {});
    return result;
  }

  // UI convenience: generate a unique name and then use the same action pipeline.
  create(
    name = `Playlist ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${crypto.randomUUID().slice(0, 8)}`,
  ): Promise<Immutable<Playlist>> {
    return this.apply({ kind: "create", name });
  }

  apply(action: Extract<PlaylistAction, { kind: "create" }>): Promise<Immutable<Playlist>>;
  apply(action: PlaylistEditAction): Promise<Immutable<PlaylistDetail>>;
  apply(action: Extract<PlaylistAction, { kind: "delete" }>): Promise<void>;
  apply(action: PlaylistAction): Promise<Immutable<Playlist> | Immutable<PlaylistDetail> | void> {
    switch (action.kind) {
      case "create":
        return this.#create(action);
      case "delete":
        return this.#delete(action);
      default:
        return this.#edit(action);
    }
  }

  async #create(action: Extract<PlaylistAction, { kind: "create" }>): Promise<Immutable<Playlist>> {
    const scope = this.#scope();
    const { cache, connection, check } = scope;
    this.saving = true;
    try {
      const created = await connection.mutate(action);
      check();
      // A missing response ID is not proof of failure. Read the list; refuse to guess
      // when multiple playlists have the same generated/user-supplied name.
      const summaries = await connection.list();
      check();
      const matches = summaries.filter((item) => item.name === action.name);
      const item = created ?? (matches.length === 1 ? matches[0] : undefined);
      cache.setPlaylists({
        listedAt: Date.now(),
        summaries,
        details: cache.playlists.details.filter((detail) =>
          summaries.some((item) => item.id === detail.summary.id),
        ),
      });
      if (!item)
        throw new Error(
          "Playlist creation succeeded but its ID could not be identified. Refresh before trying again.",
        );
      return item;
    } catch (error) {
      if (scope.current()) this.error = error;
      // An uncertain timeout must never cause an automatic second create.
      throw error;
    } finally {
      if (scope.current()) this.saving = false;
    }
  }

  #edit(action: PlaylistEditAction): Promise<Immutable<PlaylistDetail>> {
    const scope = this.#scope();
    return this.#serialize(action.id, async () => {
      const { cache, connection, check } = scope;
      check();
      this.saving = true;
      try {
        const remote = await connection.read(action.id);
        check();
        const currentIds = remote.entries.map((entry) => entry.id);
        if (
          JSON.stringify(action.expected) !== JSON.stringify(currentIds) &&
          !(action.kind === "replace" && action.overwrite)
        )
          throw new PlaylistConflictError();
        if (
          action.kind === "remove" &&
          action.indexes.some(
            (index) => !Number.isInteger(index) || index < 0 || index >= currentIds.length,
          )
        )
          throw new RangeError("Invalid playlist occurrence index.");
        await connection.mutate(action);
        check();
        // Never retry a successful write if the confirming read or checkpoint fails.
        const confirmed = await connection.read(action.id);
        check();
        const detail = { ...confirmed, fetchedAt: Date.now() };
        this.#publishDetail(cache, detail);
        return detail;
      } catch (error) {
        if (scope.current()) this.error = error;
        throw error;
      } finally {
        if (scope.current()) this.saving = false;
      }
    });
  }

  #delete(action: Extract<PlaylistAction, { kind: "delete" }>): Promise<void> {
    const scope = this.#scope();
    return this.#serialize(action.id, async () => {
      const { cache, connection, check } = scope;
      check();
      this.saving = true;
      try {
        const remote = await connection.read(action.id);
        check();
        if (
          JSON.stringify(action.expected) !== JSON.stringify(remote.entries.map((item) => item.id))
        )
          throw new PlaylistConflictError();
        await connection.mutate(action);
        check();
        const state = cache.playlists;
        cache.setPlaylists({
          ...state,
          summaries: state.summaries.filter((item) => item.id !== action.id),
          details: state.details.filter((item) => item.summary.id !== action.id),
        });
      } catch (error) {
        if (scope.current()) this.error = error;
        throw error;
      } finally {
        if (scope.current()) this.saving = false;
      }
    });
  }

  destroy() {
    this.#destroyed = true;
    this.setConnection(undefined);
  }
}

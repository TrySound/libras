import { getAccountKey } from "./auth";
import type { Covers } from "./covers.svelte";
import type { Cache, CachedQueue, CacheSelection, Immutable } from "./cache.svelte";
import type { QueueConnection, RemoteQueue } from "./network.svelte";
import type { AudioTransport, PlayerState, PlayerTrack } from "./audio-transport.svelte";
import type { TrackEngine } from "./track.svelte";

type PlaybackActivity = "active" | "paused" | "inactive";

function playerActivity(player: PlayerState): PlaybackActivity {
  if (player.status === "idle" || player.status === "ended") return "inactive";
  const starting = player.status === "loading" || player.status === "seeking";
  return player.playing || starting ? "active" : "paused";
}

const emptyQueue = { tracks: [] as readonly string[], index: -1, position: 0 };
interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
}
interface PlaybackOptions {
  selection: CacheSelection;
  tracks: TrackEngine;
  covers: Covers;
  isAvailable?: (id: string) => boolean;
}

function fromRemoteQueue(remote: RemoteQueue, local: Immutable<CachedQueue>): CachedQueue {
  const sameSelection =
    remote.currentTrackId === local.tracks[local.index] &&
    remote.trackIds.length === local.tracks.length &&
    remote.trackIds.every((id, index) => id === local.tracks[index]);
  const index = sameSelection
    ? local.index
    : remote.currentTrackId
      ? remote.trackIds.indexOf(remote.currentTrackId)
      : -1;
  return {
    tracks: [...remote.trackIds],
    index,
    position: index >= 0 && Number.isFinite(remote.position) ? Math.max(0, remote.position) : 0,
  };
}
function toRemoteQueue(local: Immutable<CachedQueue>): RemoteQueue {
  return {
    trackIds: local.tracks,
    currentTrackId: local.tracks[local.index],
    position: local.position,
  };
}

/** Owns local queue commands, transport coordination and explicit server exchange.
 * Cache remains the authoritative queue and owns local durability; AudioTransport owns audio. */
export class Playback {
  #selection: CacheSelection;
  #covers: Covers;
  #tracks: TrackEngine;
  #player?: AudioTransport;
  #isAvailable: (id: string) => boolean;
  #cleanup?: () => void;
  #selectedTrackId?: string;
  #sourceIsCached = false;
  #connection = $state.raw<QueueConnection>();
  #exchangeBusy = $state<"load" | "save" | undefined>();
  #exchangeMessage = $state("");
  #queueMessage = $state("");
  #connectionVersion = 0;
  #activityVersion = 0;
  #queueError = $state.raw<unknown>();
  #activity: PlaybackActivity = "inactive";
  #lastProgressFlush = 0;
  #destroyed = false;
  #saveTimer?: ReturnType<typeof setTimeout>;

  constructor(options: PlaybackOptions) {
    this.#selection = options.selection;
    this.#covers = options.covers;
    this.#tracks = options.tracks;
    this.#isAvailable = options.isAvailable ?? (() => true);
  }
  get #localQueue() {
    return this.#selection.cache?.queue ?? emptyQueue;
  }
  get queueMessage() {
    return this.#queueMessage;
  }
  get queueError() {
    return this.#queueError;
  }
  #canPlay(index: number) {
    const id = this.#localQueue.tracks[index];
    return id !== undefined && !!this.#selection.cache?.tracks.get(id) && this.#isAvailable(id);
  }
  get track() {
    const current = this.#localQueue.tracks[this.#localQueue.index];
    return current ? this.#selection.cache?.tracks.get(current) : undefined;
  }

  /** Reconcile synchronously after publication, never through a queue subscription. */
  #syncSelection(restart = false) {
    const id = this.track?.id;
    if (!restart && id === this.#selectedTrackId) return;
    this.#selectedTrackId = id;
    this.suspend();
  }
  /** Session calls this after selecting/loading local data. */
  activate() {
    if (this.#destroyed) return;
    this.#queueMessage = "";
    this.#invalidateExchange();
    this.#activity = "inactive";
    this.#lastProgressFlush = 0;
    this.#syncSelection();
  }
  setConnection(connection: QueueConnection | undefined) {
    if (this.#destroyed || connection === this.#connection) return;
    this.#connection = connection;
    this.#invalidateExchange();
  }
  setPosition(position: number) {
    if (!this.#player || this.#destroyed) return;
    this.#setQueuePosition(position);
    if (this.#activity !== "active") this.#scheduleQueueFlush();
    else if (Date.now() - this.#lastProgressFlush >= 10_000) {
      this.#lastProgressFlush = Date.now();
      void this.flushQueue();
    }
  }
  updatePlayerState(state: PlayerState) {
    if (!this.#player || this.#destroyed) return;
    this.#setActivity(playerActivity(state));
  }
  ended() {
    if (!this.#player || this.#destroyed) return;
    void this.next();
  }

  attach(player: AudioTransport) {
    if (this.#destroyed) return () => {};
    this.#cleanup?.();
    this.#player = player;
    const hidden = () => {
      if (document.visibilityState === "hidden") void this.flushQueue();
    };
    document.addEventListener("visibilitychange", hidden);
    this.#syncSelection();
    this.updatePlayerState(player);
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("visibilitychange", hidden);
      this.suspend();
      this.#player = undefined;
      this.#selectedTrackId = undefined;
      this.#cleanup = undefined;
    };
    this.#cleanup = cleanup;
    return cleanup;
  }

  #playerTrack(): PlayerTrack | undefined {
    const cache = this.#selection.cache;
    const track = this.track;
    if (!cache || !track || !this.#canPlay(this.#localQueue.index)) return;
    const descriptor = {
      id: track.id,
      contentType: track.mimeType,
    };
    const selection = this.#selection;
    const covers = this.#covers;
    let cover: ReturnType<Covers["ensureCover"]> | undefined;
    const artwork = () => {
      if (selection.cache !== cache) return;
      const current = covers.ensureCover(cache.tracks.get(track.id)?.artworkId);
      // A new reference needs acquisition; URL publication does not.
      if (current !== cover) {
        cover = current;
        cover.load();
      }
      return cover.source;
    };
    artwork();
    return {
      metadata: {
        title: track.title,
        artist: track.displayArtist ?? cache.artists.get(track.artistIds[0])?.name,
        album: cache.albums.get(track.albumId)?.title,
        duration: track.duration,
        get artwork() {
          return artwork();
        },
      },
      position: this.#localQueue.position,
      getSource: async (options) => {
        const source = await this.#tracks.getSource(descriptor, options);
        // Player owns/reclaims even late results. Only current results affect
        // the decision whether disconnect can keep audio running.
        if (!options.signal.aborted) this.#sourceIsCached = source.cached;
        return {
          url: source.url,
          offset: source.offset,
          seekMode: source.cached ? "full" : source.nativeSeeking ? "seekable" : "buffered",
          release: source.release,
        };
      },
    };
  }
  async play() {
    const player = this.#player;
    if (!player || this.#destroyed) return;
    if (this.#localQueue.index < 0) {
      await this.playIndex(0);
      return;
    }
    if (!this.#canPlay(this.#localQueue.index)) return;
    this.#activityVersion++;
    this.#setActivity("active");
    if (player.status !== "idle") await player.resume();
    else {
      const track = this.#playerTrack();
      if (!track) return;
      this.#selectedTrackId = this.track?.id;
      await player.play(track);
    }
  }
  pause() {
    this.#player?.pause();
  }
  async toggle() {
    const player = this.#player;
    if (player && (player.playing || ["loading", "buffering", "seeking"].includes(player.status)))
      this.pause();
    else await this.play();
  }
  /** Toggle the current track without replacing its queue or resetting its position. */
  async toggleTrack(trackId: string, contextTrackIds: readonly string[]) {
    if (this.#destroyed) return;
    const index = contextTrackIds.indexOf(trackId);
    if (index < 0) return;
    if (this.track?.id === trackId) await this.toggle();
    else await this.replaceQueueAndPlay(contextTrackIds, index);
  }
  /** Toggle only the selected occurrence; duplicate track IDs remain distinct. */
  async toggleQueueIndex(index: number) {
    if (this.#destroyed) return;
    if (index >= 0 && index === this.#localQueue.index) await this.toggle();
    else await this.playIndex(index);
  }
  /** Replace the local queue without starting audio. */
  setQueue(state: QueueState) {
    this.#changeQueue(state);
  }
  async replaceQueueAndPlay(tracks: readonly string[], startIndex = 0) {
    if (!tracks.length) {
      this.clearQueue();
      return;
    }
    const index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    this.#changeQueue({ tracks, index, position: 0 }, { restart: true });
    if (Number.isInteger(index)) await this.play();
  }
  async enqueue(tracks: readonly string[], placement: "next" | "last") {
    if (this.#destroyed || !tracks.length) return;
    const queue = this.#localQueue;
    const index = placement === "next" ? queue.index + 1 : queue.tracks.length;
    this.setQueue({
      ...queue,
      tracks: [...queue.tracks.slice(0, index), ...tracks, ...queue.tracks.slice(index)],
    });
    this.#queueMessage = "Added to queue";
  }
  removeQueueIndex(index: number) {
    const queue = this.#localQueue;
    if (!Number.isInteger(index) || index < 0 || index >= queue.tracks.length) return;
    this.#changeQueue(
      {
        tracks: queue.tracks.filter((_, occurrence) => occurrence !== index),
        index: index === queue.index ? -1 : index < queue.index ? queue.index - 1 : queue.index,
        position: index === queue.index ? 0 : queue.position,
      },
      { restart: index === queue.index },
    );
  }
  clearQueue() {
    this.#changeQueue({ tracks: [], position: 0 }, { restart: true });
  }
  async playIndex(index: number) {
    if (
      this.#destroyed ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.#localQueue.tracks.length
    )
      return;
    this.#changeQueue({ tracks: this.#localQueue.tracks, index, position: 0 }, { restart: true });
    await this.play();
  }
  async next() {
    if (this.#localQueue.index < 0) return;
    await this.playIndex(this.#localQueue.index + 1);
  }
  async previous() {
    if (this.#localQueue.position > 3 || this.#localQueue.index === 0) await this.seek(0);
    else await this.playIndex(this.#localQueue.index - 1);
  }
  async seek(position: number) {
    if (this.#destroyed || !Number.isFinite(position) || !this.#canPlay(this.#localQueue.index))
      return;
    const duration = this.#player?.duration || this.track?.duration || 0;
    position = Math.max(0, duration > 0 ? Math.min(position, duration) : position);
    this.#setQueuePosition(position);
    this.#scheduleQueueFlush();
    // Seeking a restored queue edits its resume point without loading audio.
    if (this.#player?.status !== "idle") await this.#player?.seek(position);
  }
  /** Removing saved bytes must release an active cached source without editing the queue. */
  unloadDownloadedTrack(trackIds: ReadonlySet<string>) {
    if (
      this.track &&
      trackIds.has(this.track.id) &&
      (this.#sourceIsCached ||
        this.#player?.status === "loading" ||
        this.#player?.status === "seeking")
    )
      this.suspend();
  }
  suspendNetwork() {
    if (
      !this.#sourceIsCached ||
      this.#player?.status === "loading" ||
      this.#player?.status === "seeking"
    )
      this.suspend();
  }
  suspend() {
    this.#player?.unload();
    this.#sourceIsCached = false;
    this.#setActivity("inactive");
  }
  stop() {
    this.#changeQueue(
      { tracks: this.#localQueue.tracks, index: -1, position: 0 },
      { restart: true },
    );
  }

  #changeQueue(state: QueueState, { restart = false } = {}) {
    this.#queueMessage = "";
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed) return;
    const requestedIndex = state.index ?? -1;
    const validIndex =
      Number.isInteger(requestedIndex) &&
      requestedIndex >= 0 &&
      requestedIndex < state.tracks.length;
    const index = validIndex ? requestedIndex : -1;
    const position =
      index >= 0 && Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
    cache.setQueue({ tracks: state.tracks, index, position });
    this.#syncSelection(restart);
    this.#scheduleQueueFlush();
  }
  #setQueuePosition(position: number) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed || cache.queue.index < 0 || !Number.isFinite(position)) return;
    position = Math.max(0, position);
    if (position === cache.queue.position) return;
    cache.setQueue({ ...cache.queue, position }, { checkpoint: true });
    // A clock update never changes selection, but metadata may have removed the
    // selected track since playback began. Preserve its saved queue/resume point.
    if (this.#selectedTrackId !== undefined && !cache.tracks.has(this.#selectedTrackId)) {
      this.#selectedTrackId = undefined;
      this.suspend();
    }
  }
  #invalidateExchange() {
    this.#connectionVersion++;
    this.#queueError = undefined;
    this.#exchangeMessage = "";
  }
  get exchangeBusy() {
    return this.#exchangeBusy;
  }
  get exchangeMessage() {
    return this.#exchangeMessage;
  }
  get canExchangeQueue() {
    const cache = this.#selection.cache;
    return !!cache && !this.#destroyed && this.#hasConnection(cache);
  }
  #hasConnection(cache: Cache) {
    return (
      !!this.#connection &&
      !this.#connection.signal.aborted &&
      cache.key === getAccountKey(this.#connection.account)
    );
  }
  /** Commands publish intent before awaiting transport; events reconcile status.
   * Activity changes checkpoint locally and invalidate pending loads. */
  #setActivity(state: PlaybackActivity) {
    if (this.#destroyed || state === this.#activity) return;
    this.#activity = state;
    if (state !== "inactive") this.#activityVersion++;
    if (state === "active") this.#scheduleQueueFlush();
    else void this.flushQueue();
  }
  // Debounce explicit commands separately from periodic playback progress flushes.
  #scheduleQueueFlush() {
    if (this.#destroyed) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.flushQueue();
    }, 300);
  }
  async flushQueue() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    try {
      await this.#selection.cache?.flushQueue();
    } catch {
      // Cache retains checkpoint errors and dirty data for retry.
    }
  }
  /** Explicit exchange only. Callers confirm replacement/empty saves before invoking. */
  loadServerQueue() {
    return this.#exchangeQueue("load");
  }
  saveServerQueue() {
    return this.#exchangeQueue("save");
  }
  async #exchangeQueue(action: "load" | "save") {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    if (this.#exchangeBusy || !connection || !cache || !this.canExchangeQueue) return;
    const version = this.#connectionVersion;
    const revision = cache.queueRevision;
    const activityVersion = this.#activityVersion;
    const snapshot = toRemoteQueue({ ...cache.queue, tracks: [...cache.queue.tracks] });
    const current = () =>
      !this.#destroyed &&
      version === this.#connectionVersion &&
      cache === this.#selection.cache &&
      !connection.signal.aborted;
    this.#exchangeBusy = action;
    this.#exchangeMessage = "";
    this.#queueError = undefined;
    try {
      if (action === "save") {
        await connection.write(snapshot);
        if (current()) this.#exchangeMessage = "Queue saved to server.";
      } else {
        const remote = await connection.read();
        if (!current()) {
          if (!this.#destroyed)
            this.#exchangeMessage = "Connection changed while loading. Nothing was replaced.";
          return;
        }
        if (revision !== cache.queueRevision || activityVersion !== this.#activityVersion) {
          this.#exchangeMessage = "Queue changed while loading. Nothing was replaced.";
          return;
        }
        cache.setQueue(fromRemoteQueue(remote, cache.queue));
        this.#syncSelection(true);
        this.#scheduleQueueFlush();
        this.#exchangeMessage = "Server queue loaded. Playback is stopped.";
      }
    } catch {
      // Never publish request URLs or arbitrary server error text.
      if (current()) {
        const message =
          action === "load"
            ? "Could not load server queue. Nothing was replaced."
            : "Could not save queue to server. Try again.";
        this.#queueError = new Error(message);
        this.#exchangeMessage = message;
      }
    } finally {
      this.#exchangeBusy = undefined;
    }
  }
  destroy() {
    this.#destroyed = true;
    this.#cleanup?.();
    this.#invalidateExchange();
    clearTimeout(this.#saveTimer);
    return (
      this.#selection.cache?.flush().then(
        () => {},
        () => {},
      ) ?? Promise.resolve()
    );
  }
}

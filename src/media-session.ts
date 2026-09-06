export interface MediaSessionControls {
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
  seek: (position: number) => void;
}

export class PlayerMediaSession {
  #session?: MediaSession;
  #actions: MediaSessionAction[] = [];
  #position = 0;
  #duration = 0;

  constructor(controls: MediaSessionControls, session = navigator.mediaSession) {
    this.#session = session;
    if (!session) return;
    const seek = (position: number) => {
      if (this.#duration > 0 && Number.isFinite(position)) {
        controls.seek(Math.min(this.#duration, Math.max(0, position)));
      }
    };
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: controls.play,
      pause: controls.pause,
      previoustrack: controls.previous,
      nexttrack: controls.next,
      seekto: ({ seekTime }) => {
        if (seekTime !== undefined) seek(seekTime);
      },
      seekbackward: ({ seekOffset }) => seek(this.#position - (seekOffset ?? 10)),
      seekforward: ({ seekOffset }) => seek(this.#position + (seekOffset ?? 10)),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action as MediaSessionAction, handler);
        this.#actions.push(action as MediaSessionAction);
      } catch {
        // Not every browser supports every media-session action.
      }
    }
  }

  setMetadata(track?: { title: string; artist: string; album: string }, artwork?: string) {
    if (!this.#session) return;
    try {
      this.#session.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artist,
            album: track.album,
            artwork: artwork ? [{ src: artwork }] : [],
          })
        : null;
    } catch {
      // Metadata support must not affect audio playback.
    }
  }

  setPlaybackState(state: MediaSessionPlaybackState) {
    if (!this.#session) return;
    try {
      this.#session.playbackState = state;
    } catch {
      /* Optional browser API. */
    }
  }

  setPosition(duration: number, position: number, playbackRate = 1) {
    this.#duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.#position = Number.isFinite(position)
      ? Math.min(this.#duration, Math.max(0, position))
      : 0;
    try {
      this.#session?.setPositionState(
        this.#duration
          ? {
              duration: this.#duration,
              position: this.#position,
              playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
            }
          : undefined,
      );
    } catch {
      // Position reporting is unavailable on some platforms.
    }
  }

  destroy() {
    for (const action of this.#actions) {
      try {
        this.#session?.setActionHandler(action, null);
      } catch {
        /* Optional browser API. */
      }
    }
    this.#actions = [];
    this.setMetadata();
    this.setPlaybackState("none");
    this.setPosition(0, 0);
    this.#session = undefined;
  }
}

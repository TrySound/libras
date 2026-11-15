<script lang="ts">
  import { onMount } from "svelte";
  import type { AudioTransport } from "./audio-transport.svelte";

  let {
    transport,
    hasPrevious = false,
    hasNext = false,
    onprevious,
    onnext,
  }: {
    transport: AudioTransport;
    hasPrevious?: boolean;
    hasNext?: boolean;
    onprevious?: () => void;
    onnext?: () => void;
  } = $props();

  const interactive =
    'button, input, textarea, select, summary, audio, video, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="textbox"]';
  let media = $state.raw<MediaSession>();
  let metadataGeneration = 0;
  function setMediaAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    try {
      media?.setActionHandler(action, handler);
    } catch {
      /* Optional browser action. */
    }
  }
  async function syncMetadata(metadata: AudioTransport["metadata"]) {
    const generation = ++metadataGeneration;
    const session = media;
    const artwork = metadata?.artwork;
    if (!session) return;
    const text = metadata && {
      title: metadata.title,
      artist: metadata.artist ?? "Unknown artist",
      album: metadata.album ?? "Unknown album",
    };
    try {
      const local = artwork?.startsWith("blob:");
      session.metadata = text
        ? new MediaMetadata({ ...text, artwork: artwork && !local ? [{ src: artwork }] : [] })
        : null;
      if (!text || !local || !artwork) return;
      // OS artwork loading can outlive a document-owned URL. Publish cached bytes.
      const response = await fetch(artwork);
      if (!response.ok) return;
      const blob = await response.blob();
      if (!blob.size) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
      if (
        generation !== metadataGeneration ||
        media !== session ||
        transport.metadata !== metadata ||
        transport.metadata?.artwork !== artwork
      )
        return;
      session.metadata = new MediaMetadata({
        ...text,
        artwork: [{ src: `data:${blob.type || "image/jpeg"};base64,${encoded}` }],
      });
    } catch {
      /* Unavailable artwork must not affect playback. */
    }
  }
  $effect(() => {
    setMediaAction("nexttrack", hasNext ? () => onnext?.() : null);
    setMediaAction("previoustrack", hasPrevious ? () => onprevious?.() : null);
  });
  $effect(() => {
    void syncMetadata(transport.metadata);
  });
  $effect(() => {
    if (!media) return;
    try {
      media.playbackState = !transport.metadata ? "none" : transport.playing ? "playing" : "paused";
    } catch {
      /* Optional API. */
    }
    const duration = transport.duration;
    const position = transport.position;
    const rate = transport.playbackRate;
    const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
    try {
      media.setPositionState(
        length
          ? {
              duration: length,
              position: Number.isFinite(position) ? Math.min(length, Math.max(0, position)) : 0,
              playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
            }
          : undefined,
      );
    } catch {
      /* Optional API. */
    }
  });
  onMount(() => {
    media = navigator.mediaSession;
    const mediaSeek = (seconds: number) => {
      if (Number.isFinite(transport.duration) && transport.duration > 0 && Number.isFinite(seconds))
        void transport.seek(Math.min(transport.duration, Math.max(0, seconds)));
    };
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        void transport.resume();
      },
      pause: () => transport.pause(),
      seekto: ({ seekTime }) => {
        if (seekTime !== undefined) mediaSeek(seekTime);
      },
      seekbackward: ({ seekOffset }) => mediaSeek(transport.position - (seekOffset ?? 10)),
      seekforward: ({ seekOffset }) => mediaSeek(transport.position + (seekOffset ?? 10)),
    };
    const mediaActions = Object.keys(actions) as MediaSessionAction[];
    for (const action of mediaActions) setMediaAction(action, actions[action]!);
    mediaActions.push("nexttrack", "previoustrack");
    const keydown = (event: KeyboardEvent) => {
      if (
        !transport.metadata ||
        event.key !== " " ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (
        event
          .composedPath()
          .some((target) => target instanceof Element && target.closest(interactive))
      )
        return;
      event.preventDefault();
      if (!event.repeat) transport.toggle();
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      metadataGeneration++;
      for (const action of mediaActions) setMediaAction(action, null);
      if (media) {
        try {
          media.metadata = null;
          media.playbackState = "none";
          media.setPositionState();
        } catch {
          /* Optional API. */
        }
      }
      media = undefined;
    };
  });
</script>

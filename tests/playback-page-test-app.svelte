<script lang="ts">
  import { onMount, type ComponentProps } from "svelte";
  import Album from "../src/_album.svelte";
  import Artist from "../src/_artist.svelte";
  import AudioPlayer from "../src/audio-player.svelte";
  import { AudioTransport } from "../src/audio-transport.svelte";
  import Player from "../src/ui/player.svelte";

  let { props }: { props: Omit<ComponentProps<typeof Album>, "params" | "playbackState"> } =
    $props();
  let albumId = $state<string | undefined>("album");
  let artistId = $state<string>();
  let audio = $state.raw<AudioTransport>();
  const loading = $derived(["loading", "buffering", "seeking"].includes(audio?.status ?? "idle"));
  onMount(() => {
    const transport = new AudioTransport({
      onposition: (position) => props.playback.setPosition(position),
      onended: () => props.playback.ended(),
      onstatechange: (state) => props.playback.updatePlayerState(state),
    });
    audio = transport;
    const detach = props.playback.attach(transport);
    return () => {
      detach();
      transport.dispose();
    };
  });
  export function navigate(id?: string) {
    albumId = id;
    artistId = undefined;
  }
  export function navigateArtist(id?: string) {
    artistId = id;
    albumId = undefined;
  }
</script>

{#if audio}
  <AudioPlayer
    transport={audio}
    hasNext={props.cache.queue.index < props.cache.queue.tracks.length - 1}
    hasPrevious={props.cache.queue.index > 0}
    onnext={() => props.playback.next()}
    onprevious={() => props.playback.previous()}
  />
{/if}
<Player
  cache={props.cache}
  covers={props.covers}
  playback={props.playback}
  trackEngine={props.trackEngine}
  {audio}
  offlineMode={props.session.offlineMode}
/>
{#if artistId}
  <Artist
    {...props}
    params={{ artistId }}
    playbackState={loading ? "loading" : audio?.playing ? "playing" : "paused"}
  />
{:else if albumId}
  <Album
    {...props}
    params={{ albumId }}
    playbackState={loading ? "loading" : audio?.playing ? "playing" : "paused"}
  />
{/if}

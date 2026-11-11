<script lang="ts">
  import { onMount, type ComponentProps } from "svelte";
  import Album from "../src/_album.svelte";
  import Artist from "../src/_artist.svelte";
  import AudioPlayer from "../src/audio-player.svelte";
  import Player from "../src/ui/player.svelte";

  let { props }: { props: Omit<ComponentProps<typeof Album>, "params" | "playbackState"> } =
    $props();
  let albumId = $state<string | undefined>("album");
  let artistId = $state<string>();
  let audio = $state<ReturnType<typeof AudioPlayer>>();
  const loading = $derived(["loading", "buffering", "seeking"].includes(audio?.status ?? "idle"));
  onMount(() => props.playback.attach(audio!));
  export function navigate(id?: string) {
    albumId = id;
    artistId = undefined;
  }
  export function navigateArtist(id?: string) {
    artistId = id;
    albumId = undefined;
  }
</script>

<AudioPlayer
  bind:this={audio}
  hasNext={props.cache.queue.index < props.cache.queue.tracks.length - 1}
  hasPrevious={props.cache.queue.index > 0}
  onnext={() => props.playback.next()}
  onprevious={() => props.playback.previous()}
  onposition={(position) => props.playback.setPosition(position)}
  onended={() => props.playback.ended()}
  onstatechange={(state) => props.playback.updatePlayerState(state)}
/>
<Player
  cache={props.cache}
  covers={props.covers}
  playback={props.playback}
  favourites={props.favourites}
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

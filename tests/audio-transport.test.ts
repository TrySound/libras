// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioTransport, type PlayerSource, type PlayerTrack } from "../src/audio-transport.svelte";
import { AudioStub } from "./audio-test-helpers";
import { deferred } from "./session-test-helpers";

const transports: AudioTransport[] = [];
afterEach(() => {
  for (const transport of transports.splice(0)) transport.dispose();
  vi.unstubAllGlobals();
});
function setup() {
  const audio = new AudioStub();
  const createAudio = vi.fn(function () {
    return audio;
  });
  vi.stubGlobal("Audio", createAudio);
  const onstatechange = vi.fn();
  const onposition = vi.fn();
  const onended = vi.fn();
  const transport = new AudioTransport({ onstatechange, onposition, onended });
  transports.push(transport);
  const release = vi.fn();
  const getSource = vi.fn(
    async (_options: Parameters<PlayerTrack["getSource"]>[0]): Promise<PlayerSource> => ({
      url: "blob:track",
      seekMode: "full",
      release,
    }),
  );
  const track: PlayerTrack = { metadata: { title: "Song", duration: 300 }, getSource };
  return {
    transport,
    audio,
    createAudio,
    track,
    getSource,
    release,
    onstatechange,
    onposition,
    onended,
  };
}

describe("AudioTransport without a mounted component", () => {
  it("owns one native element and publishes synchronous states, progress, and completion", async () => {
    const { transport, audio, createAudio, track, onstatechange, onposition, onended } = setup();
    await transport.play(track);
    audio.currentTime = 15;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(transport.position).toBe(15);
    expect(onposition).toHaveBeenLastCalledWith(15);
    audio.dispatchEvent(new Event("waiting"));
    expect(transport.status).toBe("buffering");
    expect(transport.playing).toBe(true);
    audio.dispatchEvent(new Event("canplay"));
    transport.pause();
    await transport.resume();
    audio.dispatchEvent(new Event("ended"));
    expect(onended).toHaveBeenCalledOnce();
    expect(onstatechange.mock.calls.map(([state]) => state)).toEqual([
      { status: "loading", playing: false },
      { status: "ready", playing: true },
      { status: "buffering", playing: true },
      { status: "ready", playing: true },
      { status: "ready", playing: false },
      { status: "ready", playing: true },
      { status: "ended", playing: false },
    ]);
    await transport.resume();
    expect(transport.position).toBe(0);
    expect(createAudio).toHaveBeenCalledOnce();
  });

  it("pauses during acquisition and releases the late source exactly once", async () => {
    const { transport, audio, track, getSource } = setup();
    const source = deferred<PlayerSource>();
    getSource.mockReturnValueOnce(source.promise);
    const pending = transport.play(track);
    const signal = getSource.mock.calls[0]![0]?.signal;
    transport.pause();
    const release = vi.fn();
    source.resolve({ url: "blob:late", seekMode: "full", release });
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(transport.playing).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
    transport.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it("never lets a superseded result release the replacement", async () => {
    const { transport, track, audio, getSource, release } = setup();
    const source = deferred<PlayerSource>();
    getSource.mockReturnValueOnce(source.promise);
    const pending = transport.play(track);
    await transport.play(track);
    const obsoleteRelease = vi.fn();
    source.resolve({ url: "blob:old", seekMode: "full", release: obsoleteRelease });
    await pending;
    expect(obsoleteRelease).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(audio.src).toBe("blob:track");
    transport.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it("seeks offset streams in absolute seconds without losing pause intent", async () => {
    const { transport, audio, track, getSource } = setup();
    getSource.mockResolvedValue({
      url: "blob:offset",
      offset: 80,
      seekMode: "buffered",
      release() {},
    });
    await transport.play({ ...track, position: 85 });
    expect(audio.currentTime).toBe(5);
    transport.pause();
    await transport.seek(90);
    expect(audio.currentTime).toBe(10);
    expect(transport.position).toBe(90);
    expect(transport.playing).toBe(false);
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(transport.duration).toBe(300);
  });

  it("releases unsupported audio before transcoding, but does not transcode autoplay rejection", async () => {
    const { transport, track, audio, getSource, release } = setup();
    const rawRelease = vi.fn();
    getSource.mockResolvedValueOnce({ url: "blob:raw", seekMode: "full", release: rawRelease });
    audio.play.mockRejectedValueOnce(new DOMException("Unsupported", "NotSupportedError"));
    await transport.play(track);
    expect(rawRelease).toHaveBeenCalledOnce();
    expect(getSource).toHaveBeenLastCalledWith(expect.objectContaining({ forceTranscode: true }));
    expect(release).not.toHaveBeenCalled();
    const error = new DOMException("User activation required", "NotAllowedError");
    audio.play.mockRejectedValueOnce(error);
    await transport.play(track);
    expect(transport.error).toBe(error);
    expect(transport.status).toBe("error");
    expect(getSource).toHaveBeenCalledTimes(3);
    await transport.resume();
    expect(transport.playing).toBe(true);
    expect(transport.error).toBeUndefined();
  });

  it("disposes pending metadata work, native listeners, and commands idempotently", async () => {
    const { transport, track, audio, getSource, release, onstatechange } = setup();
    audio.readyState = 0;
    const remove = vi.spyOn(audio, "removeEventListener");
    const pending = transport.play({ ...track, position: 20 });
    await vi.waitFor(() => expect(audio.src).toBe("blob:track"));
    transport.dispose();
    await pending;
    expect(release).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("loadedmetadata", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("error", expect.any(Function));
    const calls = onstatechange.mock.calls.length;
    for (const event of ["playing", "waiting", "ended", "loadedmetadata", "timeupdate", "error"])
      audio.dispatchEvent(new Event(event));
    transport.dispose();
    await transport.play(track);
    await transport.resume();
    await transport.seek(50);
    transport.pause();
    expect(onstatechange).toHaveBeenCalledTimes(calls);
    expect(transport.status).toBe("idle");
    expect(audio.src).toBe("");
    expect(getSource).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not restart if an idle notification disposes the transport during replacement", async () => {
    const { transport, track, getSource, onstatechange } = setup();
    await transport.play(track);
    onstatechange.mockImplementation((state) => {
      if (state.status === "idle") transport.dispose();
    });
    await transport.play(track);
    expect(transport.status).toBe("idle");
    expect(transport.metadata).toBeUndefined();
    expect(getSource).toHaveBeenCalledOnce();
  });

  it("releases a source returned after disposal without publishing it", async () => {
    const { transport, track, audio, getSource, onstatechange } = setup();
    const source = deferred<PlayerSource>();
    getSource.mockReturnValueOnce(source.promise);
    const pending = transport.play(track);
    transport.dispose();
    onstatechange.mockClear();
    const release = vi.fn();
    source.resolve({ url: "blob:late", seekMode: "full", release });
    await pending;
    expect(release).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    expect(onstatechange).not.toHaveBeenCalled();
  });
});

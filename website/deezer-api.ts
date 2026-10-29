import { demoAlbums } from "./deezer-catalog";

// Deezer's public API does not provide fetch CORS headers. Its JSONP transport
// executes third-party code: trust is restricted to this fixed HTTPS API, never
// a caller-supplied URL. No SDK, credentials, proxy, or audio bytes are involved.
export function readDeezer(path: string, signal: AbortSignal): Promise<unknown> {
  if (
    !demoAlbums.some(
      (album) =>
        path === `album/${album.id}` || album.tracks.some((track) => path === `track/${track.id}`),
    )
  ) {
    return Promise.reject(new Error("Recording is outside the demo allowlist."));
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const name = `librasDeezer_${crypto.randomUUID().replaceAll("-", "")}`;
    const callbacks = window as unknown as Record<string, unknown>;
    const script = document.createElement("script");
    const url = new URL(path, "https://api.deezer.com/");
    url.searchParams.set("output", "jsonp");
    url.searchParams.set("callback", name);
    script.src = url.href;
    script.referrerPolicy = "no-referrer";
    script.async = true;
    const cleanup = (late = false) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      script.remove();
      if (late) {
        // A removed script can already be executing. Ignore a late callback
        // rather than mutating a newer session or throwing a global error.
        callbacks[name] = () => {};
        setTimeout(() => {
          delete callbacks[name];
        }, 60_000);
      } else delete callbacks[name];
    };
    const fail = (error: unknown) => {
      cleanup(true);
      reject(error);
    };
    const abort = () => fail(signal.reason);
    const timer = setTimeout(
      () => fail(new Error("Deezer request timed out. Retry manually.")),
      15_000,
    );
    callbacks[name] = (data: unknown) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => fail(new Error("Could not reach Deezer. Retry manually."));
    signal.addEventListener("abort", abort, { once: true });
    document.head.append(script);
  });
}

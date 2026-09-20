import * as v from "valibot";
import { responseSchema } from "../src/subsonic-client";

const assetsSchema = v.record(v.string(), v.object({ path: v.string(), contentType: v.string() }));

export type StaticCatalog = ReturnType<typeof parseCatalog>;

export function parseCatalog(search: unknown, assetData: unknown, base: URL) {
  const response = v.parse(responseSchema, search)["subsonic-response"];
  if (response.status !== "ok" || !response.searchResult3) {
    throw new Error("The demo catalog is not a successful search3 response.");
  }
  return {
    artists: response.searchResult3.artist ?? [],
    albums: response.searchResult3.album ?? [],
    tracks: response.searchResult3.song ?? [],
    assets: v.parse(assetsSchema, assetData),
    base,
  };
}

export async function loadCatalog(base: URL, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (base.origin !== location.origin || !base.pathname.endsWith("/") || base.search || base.hash) {
    throw new Error("The demo catalog must be hosted alongside this website.");
  }
  const read = async (name: string) => {
    signal.throwIfAborted();
    const response = await fetcher(new URL(name, base), {
      signal,
      cache: "no-cache",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Could not load demo metadata (HTTP ${response.status}).`);
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  };
  const [search, assets] = await Promise.all([read("search3.json"), read("assets.json")]);
  return parseCatalog(search, assets, base);
}

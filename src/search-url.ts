/** Query routes split BEFORE decoding so encoded entity IDs retain literal & and /.
 * Search links: ?/search&type=artist&type=track&q=encoded+text (hash is independent).
 */
export function splitRoute(search: string) {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const boundary = raw.indexOf("&");
  return {
    path: boundary < 0 ? raw : raw.slice(0, boundary),
    parameters: new URLSearchParams(boundary < 0 ? "" : raw.slice(boundary + 1)),
  };
}

export const searchTypes = ["artist", "album", "track"] as const;
export type SearchType = (typeof searchTypes)[number];

export function parseSearch(parameters: URLSearchParams) {
  const selected = parameters.getAll("type");
  return {
    query: parameters.get("q") ?? "",
    types: searchTypes.filter((type) => selected.includes(type)),
  };
}

export function searchHref(query = "", types: readonly SearchType[] = []) {
  const parameters = new URLSearchParams();
  for (const type of searchTypes) if (types.includes(type)) parameters.append("type", type);
  if (query) parameters.set("q", query);
  const suffix = parameters.toString();
  return `?/search${suffix ? `&${suffix}` : ""}`;
}

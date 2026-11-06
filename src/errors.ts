import { SubsonicError, SubsonicTransportError } from "./subsonic-client";

/** Shared presentation for login, synchronization, and local workspace failures. */
export function connectionError(error: unknown): string {
  if (error instanceof AggregateError)
    return error.errors.length ? error.errors.map(connectionError).join("; ") : error.message;
  if (error instanceof SubsonicTransportError)
    return "Could not reach the server. Check your connection, server address, and CORS settings.";
  if (error instanceof SubsonicError && error.code !== undefined)
    return `${error.message} (Subsonic code ${error.code})`;
  return error instanceof Error ? error.message : "Could not connect to the server.";
}

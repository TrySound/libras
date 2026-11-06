import { describe, expect, it } from "vitest";
import { connectionError } from "../src/errors";
import { SubsonicError, SubsonicHttpError, SubsonicTransportError } from "../src/subsonic-client";

describe("connectionError", () => {
  it.each([
    [
      new SubsonicTransportError(),
      "Could not reach the server. Check your connection, server address, and CORS settings.",
    ],
    [new SubsonicError(44, "Invalid key"), "Invalid key (Subsonic code 44)"],
    [new SubsonicError(undefined, "Denied"), "Denied"],
    [new SubsonicHttpError(503), "The server returned HTTP 503."],
    [new Error("Storage full"), "Storage full"],
    [new AggregateError([], "Cache unavailable"), "Cache unavailable"],
    [undefined, "Could not connect to the server."],
  ])("formats %s without changing its message", (error, expected) => {
    expect(connectionError(error)).toBe(expected);
  });

  it("flattens nested synchronization and cache errors", () => {
    expect(
      connectionError(
        new AggregateError([
          new Error("Storage unavailable"),
          new AggregateError([new Error("Corrupt images"), new SubsonicError(0, "Failed")]),
        ]),
      ),
    ).toBe("Storage unavailable; Corrupt images; Failed (Subsonic code 0)");
  });
});

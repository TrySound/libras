import { describe, expect, it, vi } from "vitest";
import { SubsonicClient, SubsonicError, SubsonicTransportError } from "../src/subsonic-client";
import type { Credentials } from "../src/auth";

const host = "https://music.example/base";
const username = "listener";
const methods: Credentials[] = [
  { method: "token", username, token: "token-secret", salt: "salt-secret" },
  { method: "password", username, password: " secret & 音 " },
  { method: "password", username, password: "enc:literal 音" },
];
const ok = () => new Response(JSON.stringify({ "subsonic-response": { status: "ok" } }));

function expectCredentials(query: URLSearchParams, credentials: Credentials) {
  expect(query.get("u")).toBe(username);
  if (credentials.method === "token") {
    expect(query.get("t")).toBe(credentials.token);
    expect(query.get("s")).toBe(credentials.salt);
    expect(query.has("p")).toBe(false);
  } else {
    expect(query.has("t")).toBe(false);
    expect(query.has("s")).toBe(false);
    let password = query.get("p")!;
    if (password.startsWith("enc:")) {
      const bytes = password
        .slice(4)
        .match(/../g)!
        .map((hex) => parseInt(hex, 16));
      password = new TextDecoder().decode(new Uint8Array(bytes));
    }
    expect(password).toBe(credentials.password);
  }
}

describe("SubsonicClient authentication", () => {
  it.each(methods)(
    "uses exclusive $method credentials for metadata, artwork, streams and existing POST writes",
    async (credentials) => {
      const fetcher = vi.fn<typeof fetch>(async () => ok());
      const client = new SubsonicClient({ host, credentials }, { fetch: fetcher });
      await client.getIndexes();
      await client.savePlayQueue({ tracks: ["a", "a"], position: 1 });
      await client.updatePlaylist("playlist", { name: "Renamed" });
      expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
      expectCredentials(new URL(String(fetcher.mock.calls[0][0])).searchParams, credentials);
      for (const [, init] of fetcher.mock.calls.slice(1)) {
        expect(init?.method).toBe("POST");
        expectCredentials(init?.body as URLSearchParams, credentials);
      }
      expect(fetcher.mock.calls[1][1]?.keepalive).toBe(true);
      expect((fetcher.mock.calls[1][1]?.body as URLSearchParams).getAll("id")).toEqual(["a", "a"]);
      for (const url of [
        client.getCoverArtUrl("art", 100),
        client.getStreamUrl("track", { format: "raw" }),
      ])
        expectCredentials(new URL(url).searchParams, credentials);
    },
  );

  it.each(methods)(
    "does not allow extra metadata options to mix $method credentials",
    async (credentials) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ "subsonic-response": { status: "ok", searchResult3: {} } }),
          ),
      );
      const client = new SubsonicClient({ host, credentials }, { fetch: fetcher });
      await client.search3({
        artistCount: 0,
        artistOffset: 0,
        albumCount: 0,
        albumOffset: 0,
        songCount: 0,
        songOffset: 0,
        ...{ u: "other", p: "injected", t: "injected", s: "injected" },
      });
      expectCredentials(new URL(String(fetcher.mock.calls[0][0])).searchParams, credentials);
    },
  );

  it.each([40, 41, 42, 0])(
    "preserves protocol code %s while sanitizing echoed credential URLs",
    async (code) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              "subsonic-response": {
                status: "failed",
                error: { code, message: `${host}/rest/ping.view?p=secret` },
              },
            }),
          ),
      );
      await expect(
        new SubsonicClient({ host, credentials: methods[1] }, { fetch: fetcher }).ping(),
      ).rejects.toMatchObject({
        name: "SubsonicError",
        code,
        message: "The Subsonic server rejected the request.",
      });
    },
  );

  it("preserves useful invalid-credentials text and code", async () => {
    const client = new SubsonicClient(
      { host, credentials: methods[0] },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              "subsonic-response": {
                status: "failed",
                error: { code: 40, message: "Wrong username or password" },
              },
            }),
          ),
      },
    );
    await expect(client.ping()).rejects.toBeInstanceOf(SubsonicError);
    await expect(client.ping()).rejects.toMatchObject({
      code: 40,
      message: "Wrong username or password",
    });
  });

  it.each(methods)(
    "redacts raw and encoded $method secrets from protocol messages",
    async (credentials) => {
      const secret = credentials.method === "token" ? credentials.token : credentials.password;
      const echo = [
        secret,
        encodeURIComponent(secret),
        new URLSearchParams({ x: secret }).toString().slice(2),
      ].join(" / ");
      const client = new SubsonicClient(
        { host, credentials },
        {
          fetch: async () =>
            new Response(
              JSON.stringify({
                "subsonic-response": {
                  status: "failed",
                  error: { code: 40, message: `Denied ${echo}` },
                },
              }),
            ),
        },
      );
      await expect(client.ping()).rejects.toMatchObject({
        code: 40,
        message: "Denied [redacted] / [redacted] / [redacted]",
      });
    },
  );

  it.each(["fetch", "json", "queue"])(
    "does not retain secret-bearing request causes (%s)",
    async (kind) => {
      const cause = new TypeError(`${host}?p=password-secret`);
      const fetcher: typeof fetch = async () => {
        if (kind !== "json") throw cause;
        const response = ok();
        vi.spyOn(response, "json").mockRejectedValue(cause);
        return response;
      };
      const client = new SubsonicClient({ host, credentials: methods[1] }, { fetch: fetcher });
      const request =
        kind === "queue" ? client.savePlayQueue({ tracks: [], position: 0 }) : client.ping();
      await expect(request).rejects.not.toHaveProperty("cause");
      await expect(request).rejects.toThrow(
        kind === "json" ? "invalid Subsonic response" : "The server request failed.",
      );
      if (kind !== "json") await expect(request).rejects.toBeInstanceOf(SubsonicTransportError);
    },
  );

  it("blocks insecure restored direct-password sessions before any request or media URL", () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const host of ["http://music.example", "http://localhost:4533", "http://127.0.0.1:4533"])
      expect(
        () => new SubsonicClient({ host, credentials: methods[1] }, { fetch: fetcher }),
      ).toThrow("requires HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

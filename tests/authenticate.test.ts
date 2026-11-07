import { describe, expect, it, vi } from "vitest";
import { authenticate } from "../src/auth";
import { Network } from "../src/network.svelte";
import { SubsonicError, SubsonicTransportError } from "../src/subsonic-client";

const input = { host: "https://music.example", username: "listener", password: "secret" };

describe("authenticate", () => {
  it.each([
    new SubsonicError(40, "Wrong username or password"),
    new SubsonicTransportError(),
    new Error("Generic failure"),
    Object.assign(new Error("Not a structured Subsonic error"), { code: 41 }),
  ])("does not retry $message", async (error) => {
    const network = new Network();
    const prepare = vi.spyOn(network, "prepare");
    vi.spyOn(network, "validate").mockRejectedValueOnce(error);
    try {
      await expect(authenticate(input, network, new AbortController().signal)).rejects.toBe(error);
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.results[0].value.signal.aborted).toBe(true);
      expect(network.mode).toBe("offline");
    } finally {
      network.cancelPending();
    }
  });

  it("retries only the password entered for this attempt", async () => {
    const network = new Network();
    let reject!: (error: unknown) => void;
    vi.spyOn(network, "validate")
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const entered = { ...input };
    try {
      const result = authenticate(entered, network, new AbortController().signal);
      entered.password = "changed-after-submit";
      reject(new SubsonicError(41, "Token unsupported"));
      expect((await result).auth.credentials).toEqual({
        method: "password",
        username: input.username,
        password: input.password,
      });
    } finally {
      network.cancelPending();
    }
  });
});

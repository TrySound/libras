import { describe, expect, it, vi } from "vitest";
import { AuthWorkflow } from "../src/auth.svelte";
import { Network } from "../src/network.svelte";
import { SubsonicError, SubsonicTransportError } from "../src/subsonic-client";

const input = { host: "https://music.example", username: "listener", password: "secret" };

describe("AuthWorkflow", () => {
  it.each([
    new SubsonicError(40, "Wrong username or password"),
    new SubsonicTransportError(),
    new Error("Generic failure"),
    Object.assign(new Error("Not a structured Subsonic error"), { code: 41 }),
  ])("does not retry $message", async (error) => {
    const network = new Network();
    const prepare = vi.spyOn(network, "prepare");
    vi.spyOn(network, "validate").mockRejectedValueOnce(error);
    const workflow = new AuthWorkflow(network);
    try {
      await expect(workflow.connect(input)).rejects.toBe(error);
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.results[0].value.signal.aborted).toBe(true);
      expect(network.mode).toBe("offline");
    } finally {
      workflow.cancel();
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
    const workflow = new AuthWorkflow(network);
    const entered = { ...input };
    try {
      const result = workflow.connect(entered);
      entered.password = "changed-after-submit";
      reject(new SubsonicError(41, "Token unsupported"));
      expect((await result)?.auth.credentials).toEqual({
        method: "password",
        username: input.username,
        password: input.password,
      });
    } finally {
      workflow.cancel();
    }
  });

  it("guards reentrancy while verification is pending", async () => {
    const network = new Network();
    let finish!: () => void;
    vi.spyOn(network, "validate").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const prepare = vi.spyOn(network, "prepare");
    const workflow = new AuthWorkflow(network);
    try {
      const first = workflow.connect(input);
      expect(await workflow.connect(input)).toBeUndefined();
      expect(prepare).toHaveBeenCalledOnce();
      finish();
      expect((await first)?.auth.credentials.method).toBe("token");
    } finally {
      workflow.cancel();
    }
  });
});

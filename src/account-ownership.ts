import { hashAccountKey } from "./cache.svelte";

export class AccountOwnershipError extends Error {
  constructor(readonly reason: "blocked" | "unsupported") {
    super(
      reason === "blocked"
        ? "This account is open in another tab"
        : "This browser cannot safely open this account’s local data.",
    );
  }
}

/** One browser-managed exclusive lease, never queued or taken over. */
export async function acquireAccountOwnership(key: string): Promise<() => Promise<void>> {
  if (!navigator.locks) throw new AccountOwnershipError("unsupported");
  const name = `libras-account:${await hashAccountKey(key)}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accept!: (release: () => Promise<void>) => void;
  let reject!: (error: unknown) => void;
  const acquired = new Promise<() => Promise<void>>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const request = navigator.locks.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) throw new AccountOwnershipError("blocked");
      accept(async () => {
        release();
        await request;
      });
      await held;
    },
  );
  void request.catch(reject);
  return acquired;
}

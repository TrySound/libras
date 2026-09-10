import type { QueueConnection } from "./network.svelte";
import type { QueueEngine } from "./queue.svelte";
import { SyncEngine } from "./sync.svelte";

const bindings = new WeakMap<QueueEngine, { connection: QueueConnection; sync: SyncEngine }>();

/** Attach the production network coordinator without library fixtures. */
export function attachQueue(queue: QueueEngine, connection?: QueueConnection) {
  const previous = bindings.get(queue);
  if (connection && previous?.connection === connection) return previous.sync;
  previous?.sync.stop();
  bindings.delete(queue);
  if (!connection) return;
  const sync = new SyncEngine({
    queue,
    metadata: {
      refresh: async () => {},
      revalidate: async () => {},
      status: "ready",
      error: undefined,
      warning: undefined,
    },
    covers: { refresh: async () => {} },
  });
  sync.start(connection);
  bindings.set(queue, { connection, sync });
  return sync;
}

export async function refreshQueue(queue: QueueEngine, connection: QueueConnection) {
  const sync = attachQueue(queue, connection);
  if (!sync) throw new Error("Queue sync was not attached.");
  await sync.refresh();
  return sync;
}

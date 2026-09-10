import type { MetadataEngine } from "./metadata.svelte";
import type { MetadataConnection } from "./network.svelte";
import { SyncEngine } from "./sync.svelte";

const bindings = new WeakMap<MetadataEngine, SyncEngine>();
export function metadataSync(metadata: MetadataEngine) {
  let sync = bindings.get(metadata);
  if (!sync) {
    sync = new SyncEngine({
      metadata,
      covers: { refresh: async () => {} },
      queue: {
        setConnection: () => {},
        refresh: async () => {},
        error: undefined,
        storageError: undefined,
      },
    });
    bindings.set(metadata, sync);
  }
  return sync;
}
export function attachMetadata(metadata: MetadataEngine, connection?: MetadataConnection) {
  const sync = metadataSync(metadata);
  if (!connection) sync.stop();
  else
    sync.start(
      {
        account: connection.account,
        signal: connection.signal,
        read: async () => ({ trackIds: [], position: 0 }),
        write: async () => {},
      },
      connection,
    );
}

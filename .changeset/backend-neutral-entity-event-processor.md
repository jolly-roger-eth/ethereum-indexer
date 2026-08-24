---
'@etherfold/processor-entities': minor
'@etherfold/processor-sqlite': minor
---

**`EntityEventProcessor`: run an entity processor against ANY `StateStore`.**

The runtime the storage seam was built for and the one thing that was missing from it. `new EntityEventProcessor(store, processor)` is an `EventProcessor` the core drives, with the store INJECTED, so the same processor definition (entity declarations plus `on<EventName>` handlers over a `MutationContext`) indexes to SQLite on a server, to IndexedDB in a browser tab, to the light patch store or to memory in a test, with nothing about the processor changed. `fromEntityProcessor(processor, options)(store)` is the factory form, mirroring `fromJSProcessor`.

`process()` hands back an **`EntityStateView`**: the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) plus the capability report. `queryCurrent` / `queryAsOf` are deliberately NOT on it, and not stubbed to throw either, so asking a backend-neutral handle for caller-supplied SQL is a compile error in the editor rather than a runtime throw in a browser tab. `VersionedStateView` (`@etherfold/processor-sqlite`) is the tier that has them.

**The sync cursor moved behind the storage seam** (ADR-0027) and is written in the same transaction as the block it describes. `serializeLastSync` / `deserializeLastSync` now live here, alongside `SYNC_CURSOR_KEY`, `parseStoredCursor` and `syncedThrough`; `@etherfold/processor-sqlite` re-exports all four from its `sync.ts`, and its `_sync` table is gone, so the SQL that reached it goes with it: **`SYNC_TABLE`, `SYNC_ROW_ID`, `SYNC_SCHEMA_DDL`, `readLastSync`, `writeLastSyncStatement` and `deleteLastSyncStatement` are removed** from `@etherfold/processor-sqlite`'s surface. The storage is `@etherfold/state-store-sqlite`'s neutral `_cursor (key, value)` table, reached through `StateStore.readCursor` / `writeCursor` / `clearCursor`. This closes a live defect: the cursor used to be a second round trip after the blocks, and a crash in that window left state ahead of the cursor, which is not self-healing — the restart replayed a block the store already held and `applyBlock` refused it, so the indexer wedged until a human intervened.

**`applyEventStream` takes an optional `cursor`** (`{key, lastSync}`) and applies each block together with the cursor that describes THAT block, because one `process` call carries many blocks and each is its own transaction. A stream with no blocks still records the range it scanned.

**`VersionedStateEventProcessor` is unchanged in behaviour and is now a thin SQLite flavour** of `EntityEventProcessor`: it builds a `VersionedStateStore` from a `RemoteSQL`, keeps the SQL read tier, and delegates the rest. Revert-then-apply, the block grouping, the version hash, the code fingerprint and the retention reconciliation exist once rather than twice.

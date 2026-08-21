---
'@ethereum-indexer/processor-sqlite': minor
---

New package: an `EventProcessor` whose derived state lives in the versioned-row state store instead of memory, so indexing a chain produces time-travellable state as a side effect of normal processing.

`VersionedStateEventProcessor` implements the existing contract (`getVersionHash` / `load` / `process` / `reset` / `clear`) and writes through `@ethereum-indexer/state-store-sqlite`. A `removed: true` event becomes a single `revertTo(forkPoint)` rather than any private undo mechanism, where the fork point is one below the lowest retracted block in the stream. That covers a reorg which removes a block's logs with no replacement (the `d24872f` case) as well as a hash replacement, because the revert is driven by the retraction itself and never by what replaced it.

`process` returns a read-only `VersionedStateView` (as-of and current reads on the hash, height and time axes) instead of a materialised state object, and the sync cursor is persisted in this package's own fixed `_sync` table.

Behavioural equivalence with the in-memory path is asserted rather than assumed: the tests run the same scenarios as `ethereum-indexer-js-processor`'s reorg characterization tests, and additionally run both processors over the same streams and compare the resulting states directly.

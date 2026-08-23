---
'@etherfold/state-store-sqlite': minor
---

Remove `parentHash` from `_blocks`, `BlockPointer` and `RecordedBlock`.

**Breaking for anyone already passing it:** `BlockPointer.parentHash` no longer exists, and the `_blocks` table has one fewer column. Existing databases need the column dropped (or recreated), since the insert no longer supplies it.

The field was carried over from the design sketch and could never be filled honestly. A block's parent hash is not on a log, so recording it would cost the extra `eth_getBlockByHash` round-trip per block that this design exists to avoid, and ADR-0002 makes that cost acute: the in-browser path is primary and a browser provider often cannot batch those calls at all.

It would also have described a linkage this table does not have. `_blocks` is deliberately sparse, holding only blocks that carry our logs, so two consecutive rows are almost never parent and child. A `parentHash` stored there could not be walked, and the `''` default the store was applying was a placeholder that a future chain-linkage check would have read as a real value. The cross-check it would have served (`verifyBlocks`, ADR-0004) is deferred in the design's §9, and if it is ever built it needs the field plumbed onto the log stream rather than reconstructed at this layer.

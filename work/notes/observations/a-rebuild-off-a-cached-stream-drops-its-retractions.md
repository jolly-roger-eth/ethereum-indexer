# A rebuild off a cached stream DROPS the retractions the stream carries

2026-09-02, noticed while porting `packages/browser/test/streamSegments.test.ts` off the free-form processor path in `retire-the-js-object-processor-path`.

Sharpens `a-replayed-reorg-reapplies-the-replacement-block.md`, which observed the symptom on the same path; this is the mechanism, and it is now a hard failure rather than a silently wrong state.

`EthereumIndexer.promiseToFeed` derives retractions from `this.lastSync.unconfirmedBlocks` only, and `groupLogsPerBlock` (`packages/core/src/internal/engine/utils.ts`) *skips* `removed` events out of what it is handed. A REBUILD starts from `freshLastSync`, whose window is empty, so a stored stream containing a reorg (`0xa104` events, then those events flagged `removed`, then `0xb104`) is replayed with its retractions discarded: `generateStreamToAppend` emits both branches as live blocks, no `revertTo` happens, and both are applied at height 104.

On the free-form path that was invisible: the object took both branches' writes and the tab rebuilt a state derived in part from a dead branch, with nothing asserting the rebuilt state against the live one. On the entity path the store refuses the second block at that height (`block 104 is already recorded`, `IndexedDBStateStore.applyBlock`), which is how it surfaced. Pinned as a characterization case in `packages/browser/test/streamSegments.test.ts` ("is REFUSED on a rebuild, because the replay drops the stored retractions"), which will go red when this is fixed.

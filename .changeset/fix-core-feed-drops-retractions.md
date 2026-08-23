---
'@etherfold/core': patch
---

fix(core): `feed()` dropped every retraction, so the feed path could not revert

`promiseToFeed` batched the generated stream with `groupLogsPerBlock`, which deliberately skips `removed: true` events. That is correct for logs coming IN from a fetch, where a retraction has no business existing, and wrong for the stream going OUT to a processor, where a `removed` marker is the only instruction a processor ever gets to revert.

The consequence was that the same stream produced two different states depending on which entry point delivered it: reverted correctly through `indexMore()`, and silently derived from a dead branch through `feed()`. `feed()` is the kept-stream replay on load and the indexer-server's import route, so a reorg that arrived through either was applied and never taken back.

Retractions are now grouped and delivered by `groupStreamPerBlock`, which keeps them, and keeps a retracted block apart from a re-applied one when they share a hash (which happens when a reorg is detected at the first unconfirmed block and a later one is re-applied unchanged). All retractions in a stream go in a single `process` call regardless of `feedBatchSize`, since a revert is one decision about one fork point and a processor that reverts to the lowest retracted block must not compute it from a partial view. A retraction-only batch no longer drags `lastToBlock` backwards.

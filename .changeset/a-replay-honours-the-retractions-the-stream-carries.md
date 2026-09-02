---
'@etherfold/core': minor
---

Fix: rebuilding off a cached event stream no longer throws away the retractions that stream carries.

A stored stream is an EMISSION stream: a reorged-out block is in it TWICE, once as it was emitted and once at its original block flagged `removed`. `EthereumIndexer.feed()` handed whatever it was given to `generateStreamToAppend`, which is FETCH-shaped -- it derives retractions from the cursor's unconfirmed window, and `groupLogsPerBlock` drops `removed` events out of its input, both of which are right for raw logs from a stateless `eth_getLogs`. A rebuild starts from a fresh cursor whose window is EMPTY, so a stream containing a reorg replayed as BOTH branches applied as live blocks with no revert at all: refused by the entity store (`block 104 is already recorded`), and silently wrong state derived partly from a dead branch on any path that tolerated the double-apply. ADR-0008 rests a processor upgrade on that replay, so its fidelity is load-bearing.

**New: `EthereumIndexer.replay(eventStream, lastSyncStored)`**, the entry for a stream that carries its own verdicts, and what `load()` now uses for both the rebuild and the catch-up shape of a kept-stream replay. `feed()` keeps its meaning -- a FETCH, complete over its range, whose retractions this engine derives -- and now REFUSES a batch carrying `removed` markers with an `InvalidBatchError` naming `replay()`, instead of accepting it and dropping them.

**The cursor a replay leaves behind is the one the live run held, window included.** The window is rebuilt by WALKING the stream (an applied block enters it, a retracted block leaves it, keyed by block HASH), not by filtering out its `removed` entries -- which would leave both branches of a reorg at one height and make the first tip cycle after the rebuild apply the replacement block a SECOND time. No stream keeper stores `unconfirmedBlocks` and none needs to; see ADR-0042.

`groupStreamPerBlock` now groups CONSECUTIVE runs rather than keying a map over the whole list, so a stream that applies a block, retracts it and applies it again under the same hash is delivered in that order.

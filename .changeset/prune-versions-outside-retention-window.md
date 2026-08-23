---
'@etherfold/state-store': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/processor-sqlite': minor
'@etherfold/state-store-conformance': minor
---

A configured retention window is now ENFORCED against storage, so a store that declares one stops growing.

**`StateStore.prune(options?)` is the new verb**, on the seam and implemented by both shipped stores. It deletes the versions the declared retention no longer covers and reports what went: `{tip, floor, versionsDeleted, complete}`. Assert on `versionsDeleted`, never on reported bytes: `navigator.storage.estimate()` is quantised and lags badly enough that the spike measured it reporting MORE space used after a prune that dropped nothing.

**It is a call the HOST schedules, and that is a decision rather than an omission (ADR-0022).** A prune plus `VACUUM` measured 1.1 seconds at 62,553 versions while a block on the same real stream carries a median of 7 mutations, so folding it into `applyBlock` would stall whichever block happened to cross a threshold, for work that block did not cause, and would have a store picking a maintenance cadence for a browser tab, a backfilling CLI and a long-running server alike. An amortised policy is `prune({maxVersions: n})` on your own schedule (watch `complete`); a background policy is `prune()` on a timer. Pruning a store with nothing to enforce (`unbounded`, or `revert-only` with no declared `finalityDepth`) is a NO-OP and not an error, so a host may schedule it unconditionally. `VersionedStateEventProcessor.prune()` is the same call for a deployment that configured retention through the processor; it is on the processor and not on the read-only `state` view, because it is a write.

**The LIVE version of an entity is never dropped, however old it is.** A row written once at block 12,082,307 and never touched again is still the current state, and on the real measured stream (event-bearing blocks median 429 apart, rows written once and never revisited) that is the normal case rather than an edge. The floor is `retentionFloor`, which is exactly `retainedRange(...).from`, so the block a read is refused below and the block a version is deleted at cannot drift apart, and `revertTo` still reaches the full depth of the window afterwards.

**A store with a window configured now REPORTS that window** instead of downgrading to `unbounded`, on `@etherfold/state-store-sqlite` and on `MemoryStateStore` alike, because both now enforce it on both halves: refused on every as-of read, and dropped from storage by `prune`. `retentionWithoutPruning` is REMOVED (it existed only to express "this store cannot enforce what it was asked"). The report remains about what a caller may RELY on rather than about bytes on disk, so a host that has not pruned yet still refuses the reads its window excludes -- the safe direction, and the same one a `revert-only` store already took.

**`BatchBounds` gains `maxRowsPerStatement` (default 500).** The existing bounds cap a batch and say nothing about a single statement touching an unbounded number of rows, which is exactly the shape a hosted backend rejects, so a prune deletes by an explicit bounded list of row ids instead of by predicate. That also makes the count exact, which `remote-sql` (rows, no affected-row count) could not otherwise supply.

`@etherfold/state-store-conformance` gains a `pruning, and what must survive it` group, asked of every backend under each retention claim, and its windowed subjects are now ordinary configuration rather than test doubles.

# Pruning is a call the host schedules, and it deletes an explicit bounded set of rows

Enforcing a retention window against storage costs time proportional to what it drops, so `StateStore.prune` is an explicit verb a host calls rather than something `applyBlock` does on its way past. It deletes by a bounded, named list of row ids (`bounds.maxRowsPerStatement`) rather than by a predicate, so one request never carries unbounded work. This is what earns a store the right to REPORT a window (ADR-0019), which neither shipped store could do before.

## Why not in the write path

The measurement decides it. A prune plus `VACUUM` took **1.1 seconds at 62,553 versions** on SQLite and a full-scan prune took 6.3 seconds on the IndexedDB prototype (`work/notes/findings/sqlite-in-the-browser.md`), while a block on the same real stream carries a median of **7 mutations**. Pruning inside `applyBlock` would therefore put a second-long stall onto whichever block happened to cross a threshold, for work that block did not cause, on the path that is otherwise one round-trip. Worse, the store would be choosing a maintenance schedule on the host's behalf: a browser tab, a backfilling CLI and a long-running indexer-server want three different answers, and none of them is "on the next block".

An amortised policy and a background policy are both expressible ON this verb (`prune({maxVersions: n})` on a schedule, or `prune()` on a timer) and neither needs the store to invent a cadence. The cost of the choice is named rather than hidden: a deployment that configures a window and never prunes gets a store that is bounded in what it ANSWERS and unbounded in what it HOLDS. That is the safe direction (no read is ever wrong) and it is why `capabilities` reports the window regardless: the report is about what a caller may rely on, exactly as a `revert-only` store refuses history it is still physically holding.

## Why an explicit list of row ids, and not `DELETE ... WHERE _upper <= ?`

The one-line predicate is one small statement that deletes an unbounded number of rows, which is the shape that runs on a local file and is rejected by a hosted backend capping rows written or wall-clock per request. `remote-sql` also reports rows and no affected-row count, so a blind bounded DELETE could report neither what it did nor whether it had finished. Selecting the row ids first (bounded, ordered by `_upper` so a budgeted pass drops the OLDEST first) makes the deletion bounded, countable and auditable, at the cost of one extra round-trip per chunk. Version COUNTS are the honest measure anyway: the same finding records `navigator.storage.estimate()` reporting MORE space used after a prune that dropped nothing.

## What is never dropped

The LIVE version of an entity, however old. `_upper IS NOT NULL` is written into the prune predicate explicitly because a row written once at block 12,082,307 and never touched again is still the current state, and on the real stream (event-bearing blocks median 429 apart, rows written once and never revisited) that is the normal case rather than an edge. The floor itself is `retentionFloor`, which is `retainedRange(...).from` -- the same boundary a read is refused at -- so the boundary a version is deleted at and the boundary an answer is refused at cannot drift apart.

The block table is not pruned either. A block row is three columns, and it is how an address resolves: dropping it would turn `BlockNotRetainedError` ("that block is fine, its state is outside what I keep") into `NoSuchBlockError` ("never indexed, or reorged out"), which is a worse answer and, for a consumer that pinned the hash, a wrong one. Nor does pruning `VACUUM`: it cannot run inside a transaction (the only thing `remote-sql` exposes for writes), it rewrites the whole file, and it is unavailable on some backends behind that interface. SQLite reuses the freed pages, so the file stops growing even though it does not shrink.

## Consequences

- **A `revert-only` store prunes to its declared finality depth**, because that kind means "kept only as long as reorg revert needs them" and the depth is how long that is. A `revert-only` store that declared no `finalityDepth` states no floor and prunes nothing, rather than deleting against a number nobody wrote down.
- **`prune` is at the SEAM, not on one backend.** Retention is a seam-level declared capability, so the enforcement has to be reachable through the seam by whatever schedules it; a backend-only method would leave a host holding a `StateStore` unable to bound it. It is a no-op wherever there is no floor, so a host may schedule it unconditionally.
- **`MemoryStateStore` prunes for real** rather than stubbing the verb. It is the reference implementation, and a lenient one would let a caller bug through in a test and surface it in production. It also keeps "one retention spelling means the same thing on both backends" true.
- **ADR-0019's "no store claims a window it does not enforce" is unchanged and now satisfied**; its consequence that a configured window is downgraded to `unbounded` is superseded by this ADR.

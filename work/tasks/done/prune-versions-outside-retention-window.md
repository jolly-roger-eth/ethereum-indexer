---
title: Actually prune versions outside the retention window (state-store-sqlite has no pruning at all)
slug: prune-versions-outside-retention-window
spec: one-processor-everywhere
blockedBy: [retention-capability-and-refusal]
covers: [11]
---

## What to build

The pruning the spec promises and no shipped backend performs.

`@etherfold/state-store-sqlite` has NO pruning today. Not "a naive prune", not "a prune with a bad default": none. Every backend it ships is therefore effectively `unbounded`, and a long-running server grows without limit whatever a deployment sets. This was surfaced by `work/notes/findings/sqlite-in-the-browser.md`, whose footprint numbers had to be produced by a prune written inside the spike because the package could not do it.

Prune drops versions whose upper bound is older than the window: a version is a complete row with a half-open block-validity range, so a version that was CLOSED at a block below the retention floor can no longer be reached by any legal read, and only the live version of each entity must survive regardless of age. The retention floor is `tip - window`, in block numbers, which the previous task already made the one unit in the system.

Two things the spike measured that this task should not rediscover. Pruning is not free: at 20,775 live rows and 62,553 versions, a prune plus `VACUUM` took 1.1 seconds on SQLite and a full-scan prune on the IndexedDB prototype took 6.3 seconds. And `navigator.storage.estimate()` is quantised and lags badly (it reported MORE space used after a prune that dropped nothing), so record counts are the honest measure of whether a prune worked, not reported bytes. Any test asserting "pruning reclaimed space" should assert on version counts.

Because it is not free, WHEN it runs is a real decision and should not be smuggled in. Pruning inside the per-block write path would put a 1.1-second stall onto whichever block crosses a threshold, on a workload whose blocks are median 7 mutations. Decide deliberately between an explicit call the operator or the host schedules, an amortised incremental prune, and a background pass, and record which and why.

Once this lands, a SQLite store configured with a window may HONESTLY report that window, so the capability report stops saying `unbounded` when a window is set. The conformance suite's capability cases are what prove it.

The existing `snapshot-prune-script` task in the backlog is about CLI snapshots, a different thing; check it before starting so the two do not collide on naming or on the meaning of "prune".

## Acceptance criteria

- [ ] A store configured with a window of N blocks physically drops versions closed below `tip - N`, and a version count taken before and after proves it.
- [ ] The live version of every entity survives pruning regardless of how old it is, including an entity untouched for millions of blocks. (This is the case a naive "delete rows older than the floor" gets wrong, and it destroys state.)
- [ ] A read INSIDE the window still answers correctly after a prune, and a read outside it produces the typed refusal rather than a wrong answer or a crash.
- [ ] `revertTo` still works to the finality depth after a prune, on a store whose window equals the finality depth. (Pruning must never eat the reorg floor.)
- [ ] Pruning a store with `unbounded` retention is a no-op, not an error.
- [ ] When pruning runs is an explicit, documented choice, not an implicit side effect of a write, and the reasoning is recorded.
- [ ] With a window configured, the store's capability report stops saying `unbounded` and the conformance suite's capability cases pass against it.
- [ ] Tests assert on version COUNTS, not on reported storage bytes.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset.

## Blocked by

- `retention-capability-and-refusal`: the window has to be declared, validated against the finality floor, and reported before there is anything to enforce.

## Prompt

> Implement retention pruning in the versioned state store in the `etherfold` monorepo. Note the starting point: there is currently no pruning at all, so this is new code and not a fix.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), confirm `retention-capability-and-refusal` landed and that the window is declared in block numbers with a finality floor. Read `packages/state-store-sqlite/src/store.ts` (`revertTo` shows how the version ranges are manipulated), `src/statements.ts` (statements are built as plain data so they can be asserted and batched, and pruning should follow that), and `src/batching.ts` (per-request limits are real on remote backends, so a prune that deletes an unbounded number of rows in one statement will not run on all of them). Also read the existing `work/tasks/backlog/snapshot-prune-script.md`, which is about CLI snapshots and is a different kind of prune.
>
> The vocabulary: a VERSION is a complete row with a half-open block-validity range, `_lower` inclusive and `_upper` exclusive with NULL meaning live; the RETENTION FLOOR is `tip - window` in block numbers; the FINALITY DEPTH is the floor below which the window may not go, because reorg revert reopens versions closed after the fork point.
>
> The dangerous case, and the one to write first: the LIVE version of an entity must survive no matter how old it is. An entity written once at block 12,082,307 and never touched again is still current state; a prune that deletes rows by age alone destroys it. `work/notes/findings/sqlite-in-the-browser.md` records that the real stream's event-bearing blocks are median 429 apart and its state includes rows written once and never revisited, so this is the normal case, not an edge.
>
> Two measured facts to build on rather than rediscover: a prune plus `VACUUM` cost 1.1 seconds at 62,553 versions, and `navigator.storage.estimate()` is quantised and lags so badly that it reported MORE used space after a prune that dropped nothing. Assert on version counts. And because pruning costs real time, decide deliberately WHEN it runs (explicit call, amortised, or background) rather than dropping it into the per-block write path where it would stall one block by a second on a workload whose blocks are median 7 mutations.
>
> Done means: a store with a window configured stops growing, still answers everything inside the window, still reverts to the finality depth, and can honestly report the window it enforces.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular when pruning runs and how it is bounded per request.

## Decisions

- **Pruning runs when the HOST calls `prune()`; never as a side effect of a write.** A prune plus `VACUUM` measured 1.1 s at 62,553 versions while a block on the same stream carries a median of 7 mutations, so folding it into `applyBlock` would stall whichever block crossed a threshold, for work that block did not cause, and would have the store choose a maintenance cadence on behalf of a browser tab, a backfilling CLI and a long-running server alike. Alternatives considered: amortised-inside-`applyBlock` (rejected: the store invents a cadence nobody chose, and the stall lands on an arbitrary block) and a background timer owned by the store (rejected: a store that schedules its own work is unstoppable from the host and untestable without fake timers). Both are expressible *on* this verb instead. Named cost, recorded in ADR-0022: a deployment that sets a window and never prunes is bounded in what it ANSWERS and unbounded in what it HOLDS. Touches `VersionedStateEventProcessor.prune`, `one-processor-cli-and-split-server` (which will decide the CLI/server schedule), and `indexeddb-row-backend-browser-default` / `light-store-behind-the-seam` (which must implement the verb).
- **Bounded per request by an explicit list of row ids, not by predicate**, via a new `BatchBounds.maxRowsPerStatement` (default 500). `DELETE ... WHERE _upper <= ?` is one small statement that deletes unbounded rows: the exact shape that runs on a local file and is rejected by a hosted backend capping rows-written or wall-clock per request. `remote-sql`'s result carries rows and no affected-row count, so a blind bounded DELETE could report neither what it did nor whether it had finished; selecting first costs one extra round-trip per chunk and buys an exact count and an exact `complete`. Ordered by `_upper` so a budgeted pass drops the OLDEST first and a partially pruned store converges from the far end. Touches every deployment's `bounds` option (a new key, defaulted).
- **`prune` goes on the SEAM, not on the SQLite class.** Retention is a seam-level declared capability, so its enforcement must be reachable by whatever schedules it; a backend-only method would leave a host holding a `StateStore` unable to bound it. Consequence: `MemoryStateStore` implements it for real rather than stubbing, which also keeps "one retention spelling means the same thing on both backends" true (`processor-entities/test/two-backends.test.ts`). Alternative: a backend-only method plus a `StateStore & {prune}` feature-test at call sites — rejected as an optional-method surface callers must probe. Touches `light-store-behind-the-seam` and `indexeddb-row-backend-browser-default`, which now owe a `prune`.
- **A `revert-only` store prunes to its declared `finalityDepth`; with no depth declared it prunes nothing.** `revert-only` already *means* "kept only as long as reorg revert needs them" (`capabilities.ts`), so this implements the declared meaning rather than adding one; and leaving `revert-only` — the tightest retention — as the only unbounded-storage kind would have been absurd. It introduces no new refusal and changes no default: an undeclared depth states no floor and gets a no-op, because a store deleting against a number nobody wrote down is worse than one that keeps rows. Alternative: prune only `{kind:'window'}` and tell users to spell the tightest window as `{blocks: F}` — rejected because that spelling also *answers* history, so "refuse history AND bound storage" would have been inexpressible. Touches `RetentionOptions.finalityDepth`, which is now load-bearing for a second kind.
- **A window is now REPORTED even before the host has pruned.** The window is enforced on reads from the moment it is configured (`assertRetained`), so the report never promises history that is gone — it only ever refuses history that is still physically present, which is the same safe direction a `revert-only` SQLite store already took (recorded in `retention-capability-and-refusal`). Alternative: report `unbounded` until a prune has actually run — rejected as a report that changes under the caller's feet and cannot be read at startup, which is the whole point of story 7. Touches ADR-0019's superseded consequence bullet, `processor-sqlite`'s reported capabilities, and the conformance suite's claim-driven case selection.
- **The `_blocks` table is not pruned, and `prune` does not `VACUUM`.** Dropping a block row would turn `BlockNotRetainedError` ("that block is fine, its state is outside what I keep") into `NoSuchBlockError` ("never indexed, or reorged out") — a worse answer, and a wrong one for a consumer that pinned the hash; a block row is three columns against a version count two orders of magnitude larger. `VACUUM` cannot run inside a transaction (the only write surface `remote-sql` exposes), rewrites the whole file, and is unavailable on some backends; SQLite reuses the freed pages, so the file stops growing without shrinking, and reclaiming bytes is the operator's call. Pinned by a test so neither is "tidied up" later. Consequence to name: retention bounds VERSIONS, and `_blocks` still grows slowly and unboundedly at one row per event-bearing block.
- **Coherence: `prune` is a third use of an existing word, at a new layer.** The core already prunes `unconfirmedBlocks` past the finality window and `History` prunes reverse-patches by block distance — same meaning ("drop what is outside the retention window"), different object. The backlog's `snapshot-prune-script` prunes orphaned CLI snapshot *files*, a genuinely different object. I reused the word rather than inventing one because the meaning matches, and added a `CONTEXT.md` glossary entry that names all four so the overlap is documented rather than discovered.

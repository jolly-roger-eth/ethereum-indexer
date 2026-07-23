# Findings: RevertableDatabase review

**Reviewed:**
- `packages/ethereum-indexer-db-processors/src/processor/RevertableDatabase.ts` (~231 LOC)
- `packages/ethereum-indexer-db-processors/src/processor/EventProcessorOnDatabase.ts` (~148 LOC, the driver)

**Status of the code:** functional prototype, with several rough edges and TODOs. PouchDB-specific in
places (`_rev`). No tests. Not obviously "unfinished" so much as "early / not hardened".

> This file captures ground-truth about how reorg/revert + historical state work **today**, to feed
> into `plan-historical-state-database.md` (and `plan-trigger-system.md`, which needs as-of-block
> state). See "Implications for the historical-state DB plan" at the bottom.
>
> **Live revert contract (the behavior the new store must mirror):** the production path is NOT this
> PouchDB prototype but the in-memory JS-object reducer in `ethereum-indexer-js-processor`
> (`JSObjectEventProcessor` -> `History.reverseBlock`), used by stratagems-world ->
> stratagems-snapshots. Its revert-and-reapply contract is now pinned by characterization tests in
> `packages/ethereum-indexer-js-processor/test/reorg.test.ts` (apply, single-block revert, multi-block
> revert-restores-prior-state, below-finality immutable path). The indexer-side reorg engine
> (`generateStreamToAppend`) is likewise characterized in `packages/ethereum-indexer/test/utils.test.ts`.
> Together these two test files ARE the "revert and re-apply" the SQLite `revertTo(N)` must reproduce.

## How it works today

It already implements a **per-document validity-range historical model** — which is exactly one of the
data-model options the historical-state plan is meant to compare. Key mechanics:

- Each stored doc carries `startBlock` and `endBlock` (`endBlock = Number.MAX_SAFE_INTEGER` means
  "current / still valid"), plus the `eventID` of the event that produced it.
- **`put` (update):** if a doc already exists at a different `startBlock`, the previous version is
  copied to an **archive** doc keyed by `computeArchiveID(id, currentBlock - 1)` with
  `endBlock = currentBlock - 1`, then the new version is written with `startBlock = currentBlock`,
  `endBlock = MAX`. So history is preserved as archived rows with closed ranges.
- **`delete`:** archives the latest (as above) and writes a tombstone doc (`removed: true`) with the
  current validity range — i.e. deletes are themselves versioned.
- **`remove(event)` (reorg revert):** finds docs by `eventID`, and for each, looks up the immediately
  preceding archive (`computeArchiveID(id, startBlock - 1)`); if found it is restored
  (`endBlock = MAX`, archive deleted), otherwise the doc is deleted. This is the inverse of `put`.
- **`queryAtBlock({blockHash | blockNumber})`:** resolves a blockHash → number via a stored
  `block_<hash>` doc, then returns docs whose `[startBlock, endBlock]` range contains the target
  block. Negative `blockNumber` is treated as relative-to-latest.
- **History retention:** by default `keepAllHistory` is **false**. `postBlock` purges archives with
  `endBlock < blockNumber - 13` — i.e. only ~13 blocks (≈ finality) of history are kept; older
  time-travel is rejected ("Cannot go that far in the past"). With `keepAllHistory = true`, full
  time-travel is possible but the constructor comment says it "will not scale".
- **Driver (`EventProcessorOnDatabase.process`)** walks the event stream: on `removed` events it calls
  `deleteBlock` + `remove`; on normal events it sets a `block` doc + `prepareBlock` + `prepareEvent`
  then runs the user's `processEvent`. `lastSync` is persisted as a doc.

## Bugs / correctness risks found

1. **Hardcoded `- 13` finality in `postBlock`.** The class has `setFinality()` (used by `queryAtBlock`),
   but `postBlock` purges history using a literal `13` instead of `this.finality`. If finality ≠ 13,
   archives are purged inconsistently with what `queryAtBlock` will allow → either premature purge
   (queries that should succeed error out) or retained-too-long.

2. **`postBlock` called inside the loop on every iteration.** In `EventProcessorOnDatabase.process`,
   `postBlock(lastBlock)` is called both in the block-transition branch *and* unconditionally after
   each event (`if (lastBlock) { await postBlock(lastBlock) }`). That runs a purge query per event —
   expensive, and purges using `lastBlock` mid-stream. Likely should run once per block (or once at
   end of stream).

3. **`queryAtBlock` mutates the caller's `query` object** (`delete query.blockHash` /
   `delete query.blockNumber`). Side-effecting the input is surprising and can break reuse/retries.

4. **Negative-blockNumber handling is duplicated and inconsistent** between the `!keepAllHistory` and
   `keepAllHistory` branches (the latter applies the relative offset twice in some paths). Needs a
   single clear rule.

5. **`endBlock >= blockNumber` filter with `MAX_SAFE_INTEGER` sentinel.** Works, but couples
   "currently valid" to a magic number and makes range queries depend on a sentinel rather than NULL /
   open-ended semantics. Worth reconsidering for a SQL/D1 schema (NULL `end_block` + index).

6. **Reorg revert relies on archive existing at exactly `startBlock - 1`.** If multiple updates
   happened to the same key within one block, or archive purging removed the relevant archive, the
   revert can delete a doc that should instead roll back to an earlier value. Interaction between the
   `- 13` purge window and revert depth (finality) is the key risk — needs explicit reasoning/tests.

7. **PouchDB coupling** (`delete latestDoc._rev`, `block_<hash>` docs, `$lt` selectors). Not a bug, but
   constrains portability to D1/SQLite.

8. **No tests, lots of `console.info` tracing** (via named-logs aliased to `console`) — fine, but the
   `remove`-with-no-doc path only logs an error and continues, which could silently mis-revert.

## Implications for the historical-state DB plan

- **The validity-range model is already prototyped here** — the plan should treat this as the
  reference implementation of the "per-key validity ranges `[fromBlock, toBlock)`" option, including
  its archive-on-write / restore-on-revert mechanics. Much of this maps cleanly onto a SQL/D1 schema
  (a row per (key, version) with `start_block` / `end_block`, `end_block IS NULL` for current).
- **Finality vs. history-retention is the central tension.** Today: only ~finality blocks of history
  by default (cheap, bounded) vs. `keepAllHistory` (full time-travel, "won't scale"). The plan must
  decide the retention policy per query axis (the trigger system needs *at least* as-of-block reads
  back to the triggering log's block, which is within finality if processed promptly — but not if the
  processor lags).
- **Reorg revert = "restore previous archived version".** The plan's reorg section should adopt/refine
  this inverse-operation approach rather than inventing a new one. The semantics to mirror are pinned
  by `ethereum-indexer-js-processor/test/reorg.test.ts` (live path) and
  `ethereum-indexer/test/utils.test.ts` (the `generateStreamToAppend` stream-shaping that produces the
  `removed: true` markers those reverts consume) — check the SQLite `revertTo(N)` against the same
  cases (single-block reorg restores end-of-prior-block state; below-finality events are not
  revertable).
- **Block hash → number mapping** is needed for hash-based queries; today stored as `block_<hash>`
  docs. The plan should specify this table explicitly (and consider pruning alongside history).
- **`queryAtBlock` semantics** (range-contains + relative/negative block) are a usable starting point
  for the query API surface in the plan.

## Suggested follow-ups (separate from the plan)

- Add characterization tests for `put`/`delete`/`remove`/`queryAtBlock` (in-memory Database stub) —
  TDD any of bugs #1–#4 before fixing.
- Fix `postBlock` to use `this.finality` and run once per block.
- Make `queryAtBlock` non-mutating.

_(These follow-ups should likely wait until the historical-state DB plan decides whether this code is
evolved or superseded.)_

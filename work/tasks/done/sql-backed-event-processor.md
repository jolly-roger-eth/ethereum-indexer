---
title: An EventProcessor whose state lives in the versioned store
slug: sql-backed-event-processor
spec: historical-state-database
blockedBy: [sql-versioned-state-store, block-addressing-hash-height-time]
covers: [4]
---

> Completed in `39e10b1` (the package plus the naming ADR it forced), landed as `@ethereum-indexer/processor-sqlite` in `packages/processor-sqlite/`. `VersionedStateEventProcessor` implements `getVersionHash` / `load` / `process` / `reset` / `clear` and writes through `@ethereum-indexer/state-store-sqlite`. 6 vitest files, 42 tests, against real in-memory libSQL. Changeset `.changeset/sql-backed-event-processor.md` (minor, new package); naming settled in **ADR-0016**.
>
> Checking the task against reality first (as its prompt requires) invalidated two of its premises and forced four sibling changes, all landed separately: `68b2afe` removes `parentHash` from the store (it cannot be filled without the round-trip this design exists to avoid), `0957f8c` makes the core read `blockTimestamp` off the log, `c681b79` caches the fallback fetches, and `9d21d67` takes the field from `eip-1193@0.6.6`. Building it also surfaced an unrelated live bug, fixed in `939364a`: `feed()` dropped every retraction, so the feed path could not revert at all.

## What to build

The seam that makes the store usable: an `EventProcessor` implementation whose derived state is written to the versioned-row store instead of being held in memory, so that indexing a chain produces time-travellable state as a side effect of normal processing.

It must satisfy the existing processor contract (`load` / `process` / `reset` / `clear` / `getVersionHash`), and in particular it must handle a `removed: true` event by reverting through the store rather than by any private mechanism of its own.

**The acceptance is unusually precise for greenfield work, and that is the point:** the revert-and-reapply behaviour is already pinned by tests in this repo, and this processor must reproduce it. `packages/ethereum-indexer-js-processor/test/reorg.test.ts` characterises the live in-memory path; `packages/ethereum-indexer/test/utils.test.ts` characterises the stream that drives it.

That contract gained a case on 2026-08-21 (commit `d24872f`) that is easy to miss and expensive to get wrong: **a reorg that removes a block's logs without replacing them at another block-with-logs must still retract them.** A `revertTo` wired only for the hash-replacement case would reproduce, at the database layer, the exact bug that was just fixed in the engine.

## Acceptance criteria

- [x] A processor's state is written as versions, and after indexing a range the state as of any earlier block in that range is queryable and correct. (`test/time-travel.test.ts`, 6 tests, on all three axes: height, hash and timestamp)
- [x] A single-block reorg (same height, new hash) reverts and re-applies, ending in the same state the in-memory path reaches for the same stream. (`test/reorg.test.ts`, and `test/equivalence.test.ts` which compares against the real `JSObjectEventProcessor` rather than a transcribed number)
- [x] A reorg that **removes** a block's logs with no replacement retracts them, mirroring the `d24872f` case rather than only the hash-replacement case. (`test/vanished-block.test.ts`, 4 tests, plus the differential case; verified load-bearing by wiring the revert to hash-replacement only, which turns 6 tests red)
- [x] Reverting restores end-of-prior-block state exactly, including for entities untouched by the reorged block. (`test/reorg.test.ts`; `test/equivalence.test.ts` reorgs token 2's block and asserts token 1 survives in both paths)
- [x] Below-finality events are applied but not treated as revertable, matching the existing contract. (`test/store-contract.test.ts`; the honest asymmetry is recorded in decision 9 below)
- [x] The processor's behaviour is asserted **against the same scenarios** as the existing reorg tests, so divergence between the in-memory and SQL paths is a test failure rather than a discovery in production. (`test/reorg.test.ts` ports the scenarios; `test/equivalence.test.ts` removes the transcription step by running both processors over the same streams and comparing states directly)
- [x] Tests run against real local SQLite/libSQL in the repo's vitest style. (in-memory libSQL via `remote-sql-libsql`; `test/utils/db.ts` copied from the store package rather than imported, since a test helper is not published surface)

## Blocked by

- `sql-versioned-state-store` (the store and its `revertTo`).
- `block-addressing-hash-height-time` (as-of reads used in assertions).

## Prompt

> Build an `EventProcessor` backed by the versioned-row state store, in the `ethereum-indexer` monorepo, so that indexed state becomes time-travellable without the processor author doing anything special.
>
> FIRST, check this task against current reality: confirm `sql-versioned-state-store` and `block-addressing-hash-height-time` landed as assumed, and read `docs/design/historical-state-database.md` plus `docs/adr/0001` (which explains why the in-memory path uses immer reverse-patches and what would justify replay instead). If a dependency landed differently, route to needs-attention.
>
> Implement the existing `EventProcessor` contract (`load` / `process` / `reset` / `clear` / `getVersionHash`), writing state through the store. A `removed: true` event must revert through the store's `revertTo`, not through a private mechanism.
>
> The definition of done is behavioural equivalence with the already-characterised live path. Read `packages/ethereum-indexer-js-processor/test/reorg.test.ts` and `packages/ethereum-indexer/test/utils.test.ts` first: they pin apply, single-block revert, multi-block revert-restores-prior-state, and the below-finality window. Your processor must reach the same states for the same streams.
>
> Pay attention to one case in particular. On 2026-08-21 (`d24872f`) the engine was fixed for a reorg that REMOVES a block's logs without replacing them at another block-with-logs: the re-fetch legitimately returns a shorter list, and the vanished block must still be retracted. A revert path wired only for "same height, different hash" will reproduce that bug at the database layer, where it is harder to see. Cover it explicitly.
>
> Test against real local SQLite/libSQL in the repo's vitest style, add a changeset, and do not commit without confirmation.

## Decisions

Non-obvious choices the task did not specify, transcribed from the builder's final reports.

1. **`process` returns a read-only `VersionedStateView`, not materialised state.** The core settles it: `indexer.ts` never inspects the value — the outcome of `process` and the `state` from `load` go to `_onStateUpdated`, which forwards them to the optional `onStateUpdated` callback and nothing else, while the engine's own decisions run off `lastSync`. Materialising a versioned store into an object would defeat its purpose; `void` would type-check and be a lie by omission (a consumer told the state changed with no way to read it). The view is read-only because returning the `VersionedStateStore` would put `applyBlock` and `revertTo` in reach of a UI callback. Touches: any future HTTP/GraphQL layer, which inherits this as its read surface.

2. **The revert fork point is `min(blockNumber of removed events) - 1`, computed over the whole stream and applied once, before anything is applied.** Driven by `removed` alone and never by what replaced anything, which is what makes the `d24872f` absence case fall out rather than needing a second code path. Reverting per event would issue N reverts and, on a high-to-low ordering, revert to the wrong height. Revert-before-apply is also what makes replay safe against the store's plain `INSERT` on the block row: `revertTo` deletes every block row above the fork, and the canonical events in the same stream are all at or above `fork + 1` (the engine's `startingBlockForNewEvent` guarantees it).

3. **The `LastSync` cursor lives in this package, in a fixed `_sync` table, as ONE row rather than one per context.** Not in the store, because `state-store-sqlite/test/no-platform-leakage.test.ts` asserts it imports nothing but `remote-sql` and `named-logs`, and `LastSync` is a core `ethereum-indexer` type. One row because the core's discard-and-clear branch lives *inside* `if (loaded)` (`indexer.ts`): a context-keyed table would answer "no row" after a processor upgrade, `load` would return `undefined`, the core would start a fresh sync, and `clear()` would never run — leaving the previous processor's entity rows to be indexed on top of. This deliberately contradicts the design's §1 "keyed by `{source, config, processor}`"; the contradiction is the point and is pinned by a test.

4. **Package `@ethereum-indexer/processor-sqlite`, directory `packages/processor-sqlite/`.** Escalated to **ADR-0016**, because ADR-0014's `<role>-store-<backend>` does not answer a package that is not a store, and inventing a scheme silently is what both ADRs exist to prevent. What generalises from ADR-0014 is its stated ordering rule (role first, backend last); `-store-` is part of the *role*, not a separator. Rejected `versioned-state-processor` for ADR-0014's own reason against `state-store-sql`: a Postgres-backed sibling would force a rename. Touches: the eventual rename of `ethereum-indexer-js-processor` to `@ethereum-indexer/processor-js`.

5. **`getVersionHash()` hashes the entity declarations alongside the version and config**, unlike the in-memory path which hashes version and config only. The schema is part of what the stored rows *mean*: a renamed field at an unchanged version would let the core adopt rows whose columns no longer say what the handlers assume. Touches `processor-version-hash-cannot-silently-lie`, which is written as if the JS path were the only implementation.

6. **Mutations are coalesced per business key within a block**, in first-touch order. Emitting one per event is correct but leaves zero-width versions (`_lower = _upper = N`) that no as-of predicate can ever match: table growth that is invisible by construction.

7. **Events are grouped by block HASH, not height**, matching the core's `groupLogsPerBlock`. Two hashes at one height then become two blocks and collide loudly on the block-row primary key, rather than being silently merged into a mixture of two branches under one row. (`indexer.ts` explicitly warns that a merged fetch can produce this.)

8. **`clear()` is `reset()`.** The in-memory path distinguishes them because it has two places to forget — its own object, and the `KeepState` keeper. Here there is one, the database. `reset()` is `revertTo(-1)` through the store's public API (every version has `_lower >= 0`, so "drop everything opened above -1" is "drop everything", and the same statement clears the block table) plus a delete of this package's own cursor row.

9. **Below-finality is a strictly wider capability, not a divergence.** In a versioned store nothing is ever discarded, so a retraction below finality would *succeed* here where the in-memory path throws (it has dropped the reverse-patches). The engine never emits one — a block past the finality window leaves `unconfirmedBlocks`, pinned in `ethereum-indexer/test/utils.test.ts` — so observable state on real streams is identical. This is the revisit ADR-0001 explicitly left open, taken in the direction it anticipated. The reasoning is written into the test rather than left implicit.

10. **`blockTimestamp` is taken opportunistically off the log, with no gate at `load`.** The task inherited the design's §3 claim that timestamps "come free"; that was true of the spec and false of this codebase, where the fetcher dropped the field and `indexer.ts` only filled it from a separate `getBlocks` call under `alwaysFetchTimestamps`. Rather than requiring the flag (which would force a pointless second round-trip per block on every compliant node) the core now keeps the log's own field and fetches only the blocks missing one. A load-time gate was built first and then removed: it cannot be known in advance whether a node supplies timestamps, and it would have rejected a perfectly good anvil or geth setup. The check that survives is per-block, in `blockPointer`, and it throws rather than guessing — a zero would not fail, it would answer confidently about the wrong block forever, and `getAsOf({timestamp})` has no way to tell a caller it was lied to. Verified against real nodes: anvil 1.5.1 costs zero block fetches, Hardhat 3.14.0 (whose EDR does not implement the field) falls back correctly.

11. **`parentHash` was removed from the store entirely rather than left unfilled.** Nothing in the stream carries it, so the processor could only invent it. Leaving the column with the store's `''` default would have been worse than removing it: `_blocks` is deliberately sparse (rows only for blocks carrying our logs), so consecutive rows are almost never parent and child, and a future chain-linkage check would have read a placeholder as a real value. The cost is stated plainly — no chain-linkage verification is possible from processor-written blocks — and `verifyBlocks` is already deferred in the design's §9. Touches: `state-store-sqlite`'s schema (breaking, `68b2afe`) and the design doc's §3.

12. **The cursor is serialized with BigInts tagged as `{__bigint__: "..."}`, not as a `"123n"` suffix.** `LastSync.unconfirmedBlocks` holds real decoded `LogEvent`s, whose `args` carry BigInt for every `uint256`, and plain `JSON.stringify` throws on those. Found only by running the whole thing end to end against a real anvil — every hand-built cursor in the tests had an empty unconfirmed window. The suffix convention (which the js-processor's dead `bnReviver` uses) is rejected because it has to guess: it cannot tell a real BigInt from a contract-emitted string ending in `n`, and guessing wrong silently rewrites event data.

## Follow-on

- **`processor-version-hash-cannot-silently-lie` (in `tasks/ready/`) predates this task and is scoped to the JS path only.** There are now two `EventProcessor` implementations, this one already folds the entity schema into its hash (decision 5) and already persists its context in `_sync` — which is exactly the "where the fingerprint is persisted" question its own prompt says to re-check. It needs a re-scope before it is built.
- **`@ethereum-indexer/processor-sqlite` is still at `0.0.0`.** Its first published version is a deliberate choice, not one to leave to changesets.
- **The author-facing surface is minimal on purpose**: `set` writes a whole row (a version is a complete row, mirroring close-then-insert), and `get` is read-your-writes within the block being processed. Read-modify-write of a single field is `get`-then-spread. If that proves a footgun in real processors, the fix is a documented helper, not silent merging.

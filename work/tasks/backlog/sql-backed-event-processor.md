---
title: An EventProcessor whose state lives in the versioned store
slug: sql-backed-event-processor
spec: historical-state-database
blockedBy: [sql-versioned-state-store, block-addressing-hash-height-time]
covers: [4]
---

## What to build

The seam that makes the store usable: an `EventProcessor` implementation whose derived state is written to the versioned-row store instead of being held in memory, so that indexing a chain produces time-travellable state as a side effect of normal processing.

It must satisfy the existing processor contract (`load` / `process` / `reset` / `clear` / `getVersionHash`), and in particular it must handle a `removed: true` event by reverting through the store rather than by any private mechanism of its own.

**The acceptance is unusually precise for greenfield work, and that is the point:** the revert-and-reapply behaviour is already pinned by tests in this repo, and this processor must reproduce it. `packages/ethereum-indexer-js-processor/test/reorg.test.ts` characterises the live in-memory path; `packages/ethereum-indexer/test/utils.test.ts` characterises the stream that drives it.

That contract gained a case on 2026-08-21 (commit `d24872f`) that is easy to miss and expensive to get wrong: **a reorg that removes a block's logs without replacing them at another block-with-logs must still retract them.** A `revertTo` wired only for the hash-replacement case would reproduce, at the database layer, the exact bug that was just fixed in the engine.

## Acceptance criteria

- [ ] A processor's state is written as versions, and after indexing a range the state as of any earlier block in that range is queryable and correct.
- [ ] A single-block reorg (same height, new hash) reverts and re-applies, ending in the same state the in-memory path reaches for the same stream.
- [ ] A reorg that **removes** a block's logs with no replacement retracts them, mirroring the `d24872f` case rather than only the hash-replacement case.
- [ ] Reverting restores end-of-prior-block state exactly, including for entities untouched by the reorged block.
- [ ] Below-finality events are applied but not treated as revertable, matching the existing contract.
- [ ] The processor's behaviour is asserted **against the same scenarios** as the existing reorg tests, so divergence between the in-memory and SQL paths is a test failure rather than a discovery in production.
- [ ] Tests run against real local SQLite/libSQL in the repo's vitest style.

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

# Review: EventCache

**Area:** `packages/ethereum-indexer-db-utils`
**Type:** Code review
**Status:** todo

## Context

`EventCache` is a **separate concern** from `RevertableDatabase` (which lives in the
`ethereum-indexer-db-processors` package). `EventCache` is in the `ethereum-indexer-db-utils` package
and is about caching the event stream (the `keepStream` mechanism described in the core README:
fetched events are cached so that, when a processor version changes, the state can be recomputed
without re-fetching all logs).

Reviewing it separately from `RevertableDatabase` keeps the two concerns isolated.

Relevant files:
- `packages/ethereum-indexer-db-utils/src/processor/EventCache.ts` (~210 LOC)
- `packages/ethereum-indexer-db-utils/src/cache/StreamDBCache.ts` (~71 LOC)
- `packages/ethereum-indexer-db-utils/src/db/SyncDB.ts` (~143 LOC)
- `packages/ethereum-indexer-db-utils/src/db/PouchDatabase.ts` (~120 LOC)
- Core stream types for reference: `packages/ethereum-indexer/src/types.ts`
  (`StreamFetcher`, `StreamSaver`, `StreamClearer`, `ExistingStream`).

## Goal

1. Summarise what `EventCache` does and how it interacts with the core `ExistingStream` contract
   (`fetchFrom` / `saveNewEvents` / `clear`).
2. Identify correctness risks: partial/duplicate appends, ordering, handling of `removed` (reorged)
   events in the cache, and what happens when the cached stream no longer matches the indexer context
   (the core already clears in some cases — check the cache side agrees).
3. Add vitest tests where the logic is testable (TDD: failing test first for any bug found).
4. Tidy logging/error handling per repo conventions where it makes sense.

## Constraints / conventions

- vitest tests in the package's `test/` folder.
- Do not auto-commit; present diffs. Small commits.
- Note that this package wraps PouchDB — keep DB-backed tests light (prefer testing pure logic, or
  use an in-memory adapter if one is already a dependency).

## Prompt (paste into a fresh context)

> Review the `EventCache` implementation in `packages/ethereum-indexer-db-utils`
> (`src/processor/EventCache.ts`, plus `cache/StreamDBCache.ts`, `db/SyncDB.ts`, `db/PouchDatabase.ts`).
> This is the event-stream caching layer (the `keepStream` / `ExistingStream` mechanism — see
> `StreamFetcher`/`StreamSaver`/`StreamClearer`/`ExistingStream` in
> `packages/ethereum-indexer/src/types.ts`). It is separate from `RevertableDatabase` (different
> package). Summarise what it does, identify correctness risks (duplicate/partial appends, ordering,
> handling of `removed` reorged events, cache-vs-context mismatch), and add vitest tests for the
> testable logic using a TDD approach (failing test first for any bug). Follow repo conventions:
> vitest in the package's `test/` folder, prefer testing pure logic over PouchDB-backed paths, and do
> not commit without my confirmation.

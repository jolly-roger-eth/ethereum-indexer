# Review: RevertableDatabase

**Area:** `packages/ethereum-indexer-db-processors`
**Type:** Code review (note: this code may be in an unfinished state)
**Status:** done (initial review) — see `tasks/findings/revertable-database.md`

> An initial review has been completed. Findings (how reorg/revert + historical state work today,
> bugs found, and implications for the historical-state DB plan) are written up in
> `tasks/findings/revertable-database.md`. Remaining work = the test/fix follow-ups listed there,
> ideally after the historical-state DB plan decides whether this code is evolved or superseded.

## Context

`RevertableDatabase` is the server-side equivalent of the reorg handling that lives in the core
`ethereum-indexer` engine. Where the browser/core path reverts and replays events in memory (see
`generateStreamToAppend` in `packages/ethereum-indexer/src/internal/engine/utils.ts`, covered by
`packages/ethereum-indexer/test/utils.test.ts`), `RevertableDatabase` does the equivalent against a
persisted database: it must be able to revert previously-applied writes when a reorg occurs and
re-apply the canonical chain.

This is high-value to review because a bug here silently corrupts indexed state (wrong reverts,
off-by-one on block ranges, ordering issues on replay), and it has no tests yet.

Relevant files:
- `packages/ethereum-indexer-db-processors/src/processor/RevertableDatabase.ts` (~231 LOC)
- `packages/ethereum-indexer-db-processors/src/processor/EventProcessorWithBatchDBUpdate.ts` (~295 LOC) — main consumer
- `packages/ethereum-indexer-db-processors/src/processor/EventProcessorOnDatabase.ts` (~148 LOC)
- For comparison (already reviewed + tested): `packages/ethereum-indexer/src/internal/engine/utils.ts`

> NOTE from the maintainer: RevertableDatabase might not be in a finished state. Part of the task is
> to determine what is implemented vs. stubbed/incomplete, and to report that clearly rather than
> assuming it is meant to be complete.

## Goal

1. Read `RevertableDatabase` and its consumers; produce a clear summary of:
   - what it does, how revert/replay works, and how it tracks which writes belong to which block;
   - which parts appear complete vs. unfinished/stubbed/TODO.
2. Identify correctness risks, especially around: reorg revert ordering, finality window handling,
   off-by-one on block numbers, and what happens to writes that have no inverse.
3. Where the logic is pure/testable, add vitest tests (mirror the style of
   `packages/ethereum-indexer/test/utils.test.ts`) — ideally write a failing test first for any bug found.
4. Replace any silent `catch {}` / `console.*` as appropriate (match repo conventions — this package
   may legitimately use console in places; use judgement).

## Constraints / conventions

- vitest tests in the package's `test/` folder.
- Do not auto-commit; present diffs for review. Small, reviewable commits.
- If the code is genuinely unfinished, prefer documenting the gaps + adding characterization tests
  over large speculative rewrites — confirm direction with the maintainer before refactoring.

## Prompt (paste into a fresh context)

> Review the `RevertableDatabase` implementation in `packages/ethereum-indexer-db-processors`
> (`src/processor/RevertableDatabase.ts` and its consumers `EventProcessorWithBatchDBUpdate.ts` /
> `EventProcessorOnDatabase.ts`). This is the server-side, persisted equivalent of the in-memory
> reorg handling in `packages/ethereum-indexer/src/internal/engine/utils.ts` (which is already tested
> in `packages/ethereum-indexer/test/utils.test.ts`). Note the code may be unfinished — first tell me
> what is implemented vs. stubbed. Then identify correctness risks (reorg revert ordering, finality,
> off-by-one, writes with no inverse) and, where the logic is testable, add vitest tests in the
> package's `test/` folder using a TDD approach (failing test first for any bug). Follow repo
> conventions: vitest, named-logs over console where appropriate, changeset for any public API
> change, and do not commit without my confirmation.

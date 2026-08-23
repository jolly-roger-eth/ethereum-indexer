---
title: Retention declared in blocks, with an out-of-window read refused as a typed error
slug: retention-capability-and-refusal
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam]
covers: [7, 9, 10]
---

## What to build

Retention as a number a deployment SETS and a backend REPORTS, plus the refusal that makes the report meaningful.

The unit is BLOCK NUMBERS and there is only one unit. A backend declares `revert-only`, a window of N blocks, or `unbounded`; the floor is the finality depth, because reorg revert already requires retaining superseded versions that far back whether or not anyone calls it history; and a window is a distance in block numbers compared against the tip's block number. One unit means one enforcement path, one thing to test, one thing to prune on.

**A read the backend cannot serve is a typed error, never a tip read.** That is the whole point of story 9 and it is the failure mode that makes a missing capability dangerous rather than merely absent: an as-of read silently answered from the tip is a plausible wrong number, and nothing downstream can tell. Model the refusal on `NoSuchBlockError` and ADR-0015, which already settled that an unresolvable block address is an error and not an empty result: same family, distinguishable by type, carrying enough context to say WHAT was asked and WHAT the backend retains.

**"Last N updates" is not a second mode.** If the ergonomics are wanted, they are a resolver ABOVE the seam, not something a backend must implement: every backend already keeps a sparse index of the blocks that changed something, so "the last N updates" resolves to a floor BLOCK NUMBER with one indexed lookup, and the block-number path does the rest. Do not add it as a retention kind. (Whether to add the resolver at all in this task is your call; if you do, it is a helper that returns a block number, and nothing below the seam learns about it.)

**Time is not a retention unit at all.** On the read side it is already solved, because block addressing resolves a timestamp to the latest block at or before it. As a retention unit it prunes on WALL-CLOCK progress rather than CHAIN progress, so a stalled indexer would prune history it never finished writing and a halted chain would expire its whole window while the tip stands still. Do not accept a duration anywhere in this surface.

Read the trap before choosing a default, because it is genuinely counter-intuitive: a window of N BLOCKS is not N updates of history. On the real launched stratagems stream, event-bearing blocks are median 429 blocks apart, so a 64-block window contains exactly ONE event-bearing block. A default that looks generous in blocks can be nearly empty in updates, and it is wrong in the direction that produces confident wrong answers. Whatever default you pick, its documentation says this.

This task lands the declaration, the plumbing and the refusal. It does NOT land pruning: `@etherfold/state-store-sqlite` has no pruning at all today, so a SQLite store's honest report until `prune-versions-outside-retention-window` lands is `unbounded`, and it must not claim a window it does not enforce.

## Acceptance criteria

- [ ] A deployment sets retention as a block count (or `unbounded`, or `revert-only`), and the backend reports what it actually provides, readable before any read is attempted.
- [ ] A retention setting BELOW the configured finality depth is rejected at configuration time with a message naming both numbers, because reorg revert already requires that floor.
- [ ] An as-of read outside the retained window throws a typed error of the same family as `NoSuchBlockError`, carrying the requested block and the retained range. It NEVER returns the tip value, and never returns undefined-as-if-absent.
- [ ] A backend that cannot answer as-of reads at all reports `revert-only` and refuses every historical read with the same typed error, while `revertTo` continues to work.
- [ ] No API in this surface accepts a duration, and no retention kind is expressed in updates. A test pins that the only unit that reaches a backend is a block number.
- [ ] The SQLite store reports `unbounded` and does not claim a window while pruning is unimplemented.
- [ ] The conformance suite's capability cases pass against the SQLite store and an in-memory store.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset for each package whose public surface changed.

## Blocked by

- `portable-mutation-context-seam`: the capability report's shape lands there; this task gives it teeth.

## Prompt

> Make retention an explicit, declared, enforced capability in the `etherfold` monorepo, measured in block numbers, with an out-of-window read refused as a typed error.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), its retention decisions, and `work/notes/findings/sqlite-in-the-browser.md` (section "Does the light backend answer as-of reads at all"). Confirm `portable-mutation-context-seam` landed and that the capability report is where this task assumes. Read `packages/state-store-sqlite/src/blocks.ts` and ADR-0015 for the existing refusal family (`NoSuchBlockError`), which this refusal should join rather than reinvent.
>
> The vocabulary: RETENTION is how far back superseded versions are kept, measured as a distance in BLOCK NUMBERS from the tip; the FINALITY DEPTH is its floor, because reorg revert reopens versions closed after the fork point; a BLOCK ADDRESS is a hash, a height or a timestamp, resolved by the store; `revert-only` means the backend can undo a reorg but cannot answer a historical read.
>
> Three constraints are decisions, not preferences, and the spec records why for each. One unit only: block numbers, never updates, never a duration. "Last N updates" resolves to a floor block number ABOVE the seam if it is wanted at all, because every backend already indexes the blocks that changed something. Time is excluded because it prunes on wall-clock rather than chain progress, which is wrong for a stalled indexer, and because block addressing already solves time on the read side.
>
> Know the trap before you choose a default: on the real measured stream, event-bearing blocks are median 429 blocks apart, so a 64-block window holds exactly one event-bearing block. A window in blocks is NOT a number of updates, and the naive reading is wrong by orders of magnitude on a sparse contract.
>
> Do not implement pruning here (that is `prune-versions-outside-retention-window`), and do not let the SQLite store claim a window it cannot yet enforce: today it has no pruning at all, so `unbounded` is its honest report.
>
> Done means: a caller can discover at startup what history is available, and asking for what is not available produces an error naming what was asked and what is kept.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular the default retention, the error type's shape, and whether you added the "last N updates" resolver.

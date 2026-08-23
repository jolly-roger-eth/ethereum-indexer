---
title: One conformance suite every backend must pass, including its capability claims
slug: state-store-conformance-suite
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam]
covers: [13, 14]
---

## What to build

A single test suite, parameterised by backend, that a store must pass to earn its place behind the seam. It is the mechanism that stops two implementations drifting into answering the same question differently, and it is worth more than either implementation.

It asserts EXTERNAL BEHAVIOUR only: what a read returns after a write, after a revert, as of a block. Never implementation shape, never a table layout, never a statement. A backend that stores versioned rows and a backend that stores a patch log must both be able to pass the parts they claim.

The cases, at minimum:

- **Versioned reads.** Write, overwrite, delete; read current and read as of each intermediate block; a deleted entity is absent from its delete block onward and fully readable as of any earlier block.
- **As-of reads INSIDE the declared window**, and a refusal outside it. This is where the suite meets the capability report: the suite reads what the backend CLAIMS and tests it against behaviour, so a backend claiming an as-of window and failing to deliver it fails a test rather than a user.
- **Reorg revert, with a counter that must DECREASE.** The load-bearing case, and the canonical bug this whole design exists to prevent. The spike's own run is the shape to copy: reverting the real stream to a block made an accumulated `computedPoints` go from 12 back to 6. A stored counter that does not decrease when its block is reverted is the failure this suite must catch on every backend, not on one.
- **Read-your-writes within a block**, including through the id-prefix listing once that lands.
- **Atomicity of a block.** A block's mutations apply as one unit; a failure mid-block leaves no half-applied block behind.

The suite is parameterised, so adding a backend is providing a factory and running it. Prior art to mirror for style: `packages/state-store-sqlite/test/` (particularly `as-of.test.ts`, `revert.test.ts`, `revert-order.test.ts`) and the reorg tests in `packages/processor-sqlite/test/reorg.test.ts` and `packages/js-processor/test/reorg.test.ts`. Where an existing test already encodes one of these cases against SQLite specifically, move it into the shared suite rather than duplicating it.

The workload is a separate task (`promote-stratagems-conformance-workload`) and should not be inlined here. This task lands the suite with small, hand-written cases; that one adds the real captured stream as a second, heavier subject.

## Acceptance criteria

- [ ] One exported suite, taking a backend factory, runnable against any implementation of the seam's backend interface.
- [ ] It runs against at least two backends in CI (the SQLite store and an in-memory one) and both are green.
- [ ] The reorg case asserts a counter DECREASING after revert, on every backend the suite is run against.
- [ ] The suite reads the backend's declared capabilities and asserts behaviour against the CLAIM: a backend claiming a window answers inside it and refuses outside it; a backend claiming `revert-only` refuses every historical read; a backend claiming `unbounded` answers at any depth.
- [ ] A deliberately-lying fake backend (claims a window it does not honour) FAILS the suite. This is the test that proves the capability tests are real.
- [ ] The SQLite-specific tests that duplicate a shared case are moved into the suite rather than left as a second copy.
- [ ] Tests live in the affected packages' `test/`, vitest, matching the repo's existing style; a changeset for any package whose public surface changed.

## Blocked by

- `portable-mutation-context-seam`: the backend interface and the capability report are what the suite is parameterised over.

## Prompt

> Build the shared conformance suite for storage backends in the `etherfold` monorepo, so that two backends cannot drift into answering the same question differently.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), confirm `portable-mutation-context-seam` landed and that the backend interface plus the capability report are where this task assumes. Read `packages/state-store-sqlite/test/` and `packages/processor-sqlite/test/reorg.test.ts` for the repo's testing style and for cases that already exist and should MOVE into the suite rather than be rewritten.
>
> The vocabulary: a VERSION is a complete row with a half-open block-validity range; AS-OF is a read at a past block address (hash, height or timestamp, see ADR-0015 and `packages/state-store-sqlite/src/blocks.ts`); REVERT is `revertTo(N)`, reopening versions closed after the fork point; RETENTION is a declared capability whose unit is BLOCK NUMBERS, reported by the backend.
>
> Assert external behaviour only. A patch-log backend and a versioned-rows backend must both be able to pass the parts they claim, so a test that reaches for a table, a statement or an internal field is a defect in the test.
>
> The reorg case is the load-bearing one and deserves the most care: a stored counter that does NOT decrease when its block is reverted is the exact bug this design exists to make impossible, and `work/notes/findings/sqlite-in-the-browser.md` records the real instance (an accumulated `computedPoints` going 12 back to 6 on revert). Make that shape a test on every backend, not one shared happy path.
>
> Include a fake backend that LIES about its capabilities and assert the suite fails it. Without that, the capability tests are decoration.
>
> Done means: adding a backend is providing a factory and running one suite, and a backend that claims something it cannot do goes red.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report.

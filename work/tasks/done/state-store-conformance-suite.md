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

## Decisions

- **The suite is a fourth package (`@etherfold/state-store-conformance`), not a module or subpath of `@etherfold/state-store`.** ADR-0018 makes the seam's *zero dependencies* load-bearing, and `state-store-sqlite`'s leakage test asserts that emptiness; a suite needs an assertion library, so hosting it in the seam would either add a dependency there or hide one behind an optional peer that npm auto-installs anyway. Alternatives considered and rejected: a subpath export of the seam (breaks the emptiness assertion), and copies in each backend's `test/` (the drift the suite exists to prevent). Consequence, and the one visible cost: `MemoryStateStore`'s conformance run lives in the conformance package, because `state-store` cannot depend back on it. Touches every future backend (`light-store-behind-the-seam`, `indexeddb-row-backend-browser-default`), `promote-stratagems-conformance-workload`, and ADR-0018's package map. Recorded as **ADR-0020**.
- **The name fills ADR-0014's trailing slot with a non-engine, as ADR-0018 already did.** `state-store-conformance` = the state-store role's conformance suite, sorting adjacent to `state-store` / `state-store-sqlite`. `conformance-state-store` was rejected for breaking the ordering rule and reading as a backend named "conformance".
- **Cases are DATA (`{group, name, run}`), with vitest registration as a thin adapter.** This is what makes the lying-backend requirement satisfiable: a suite that has already reported itself to a runner can be run but not asserted on, and nesting a second vitest process would make the proof slower than the suite and dependent on a reporter format. Alternative rejected: `describe`/`it` at import time. Cost: a top-level `await` in each backend's test file (the case list depends on the claim, and a claim can only be read from a store); vitest is still a peer dependency, since the assertions are its `expect`. What the case list buys is independence from the RUNNER, not from the assertion library.
- **The suite tests a backend against its OWN claim, and says where it decides.** `claimedDepth` / `answersHistoryOverLadder` gate the history cases: a store claiming a window shorter than the suite's 8-block ladder is asked only the refusal cases. Testing a backend against a capability it never claimed would fail honest backends; the risk in the other direction (a tiny claimed window being asked less) is why the gate is one named, documented function rather than scattered `if`s. Touches `prune-versions-outside-retention-window`, which will make a real store able to claim a window.
- **The refusal is asserted as `BlockNotRetainedError`, not merely as "it threw".** That makes the error family part of the backend contract: a caller must be able to tell a retention boundary from a reorg (`NoSuchBlockError`) and both from an absent entity (`undefined`). This raises the bar for a third-party backend, so it is recorded rather than buried.
- **`applyBlock` sharp edges are contract, not implementation accident.** The suite requires that re-applying a block raises, that a second hash at a recorded height raises, that a block with no mutations is still recorded, and that a rejected mutation leaves the height free. Both shipped backends already behave this way and `two-backends.test.ts` had pinned them as shared meaning; making them suite cases means a future backend must honour them too. "The block was not recorded" is observed by re-applying the height, never by asking for a block table, which the seam deliberately does not expose.
- **Changeset lists `state-store`, `state-store-sqlite` and `processor-entities` as `patch`** although only their tests changed: `changeset status --since=main` treats any file in a package as a change and would otherwise go red at land time.

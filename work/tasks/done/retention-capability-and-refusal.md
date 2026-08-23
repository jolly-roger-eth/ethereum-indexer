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

## Decisions

- **Default retention is `unbounded`, and there is no numeric default window.** No shipped store prunes, so `unbounded` is the only report true of them, and a default window would be both a claim nothing enforces and — at any size that reads as generous — nearly empty in updates (median 429 blocks between event-bearing blocks; 64 blocks holds one). Alternative considered: defaulting to the finality depth, rejected because it silently turns every existing store into one that refuses almost all history. Touches: every deployment that does not set retention (behaviour unchanged from today), and `prune-versions-outside-retention-window`, which inherits this default.
- **A window is spelled `{blocks: N}`; a bare number is refused, and `finalityDepth` is REQUIRED alongside a window.** The key names the unit at every call site, which is the cheapest defence against the "N blocks = N updates" trap, and a window is only meaningful next to the floor it must not go under. Alternative: accept `retention: 128` — rejected (a bare number names no unit) — and defaulting the floor to core's `finality: 17` — rejected, because a store silently assuming the core's stream default would validate against a number the deployment never stated. Touches every future backend's options type.
- **The refusal is `BlockNotRetainedError` under a new shared base `BlockUnavailableError`, with `NoSuchBlockError` re-parented onto it.** ADR-0015 settled the argument once; a retention boundary is the second way a historical read fails, so it is a member of that family, not a new one. The base lives at the seam because every backend throws the retention member and two classes of one name in two packages would break `instanceof`. Alternatives: a `reason` on `NoSuchBlockError` (rejected: the address resolved fine, so the name would lie) and a discriminated result (rejected for the same reason ADR-0015 rejected it — it changes every read's return type). Carries `requested`, `retained` (`{from, to}` block numbers, `undefined` for `revert-only`), `reason`, `retention`. Touches `state-store-conformance-suite`, `prune-versions-outside-retention-window`, `light-store-behind-the-seam`, and any HTTP read layer that must map it to a status.
- **A store that cannot prune ACCEPTS a window, validates it, and reports `unbounded` (with a warning on SQLite), rather than throwing.** Acceptance criterion 1 requires a deployment to be able to set a block count; refusing it at configuration would make that unreachable until pruning lands, and the report-vs-setting distinction is exactly what the criterion describes. Understating retention is the safe direction (a caller relies on less history than exists). Alternative: throw "this store cannot provide a window" — louder about the storage expectation, rejected because it makes a correct-in-intent config fail at boot. Touches `prune-versions-outside-retention-window`, which flips the downgrade off.
- **`revert-only` is honoured by BOTH shipped stores, including SQLite.** It is enforceable with no pruning at all (refuse every as-of read, keep reverting), and it is how the refusal a patch-log backend will produce is exercised before that backend exists. Consequence worth naming: a SQLite store set to `revert-only` refuses history while still physically holding it — the report is about what a caller may rely on, not about bytes on disk.
- **A new refusal at `load`: the store's declared `finalityDepth` vs the stream's `finality`.** The window is validated at construction against the depth the deployment declared, but the depth a reorg actually reaches comes from `UsedStreamConfig.finality`, so the two can disagree and the disagreement is silent until a deep reorg. It raises only for a deployment that opted into retention (the default states no floor). Alternative: warn instead of raise — rejected, the failure it guards against is unrecoverable state corruption. Coherence note: `finality` already means the stream's reorg window in this repo; the store option is deliberately named `finalityDepth` ("the depth this retention protects") and reconciled with the stream's number rather than becoming a second, independent meaning.
- **No "last N updates" resolver was added.** Nothing asks for one today, and the honest implementation needs an indexed "blocks that changed something" lookup the seam does not expose (`bounded-id-prefix-listing` is the read side that would make it cheap). Adding it now would either force a new backend method or a full scan. ADR-0019 records the shape it must take when it arrives: a helper above the seam returning a block number, invisible below it.
- **The window refusal is exercised through test doubles, not a shipped configuration**, since no shipped store may honestly claim a window yet. The cross-backend capability cases live in `processor-entities/test/two-backends.test.ts` for now; `state-store-conformance-suite` should absorb them into the suite it exports rather than duplicating them.
- **ADR-0019** (`docs/adr/0019-retention-is-block-numbers-and-an-unretained-read-is-refused.md`) records the one-unit rule, the 429-block trap, the refusal family, and report-what-you-provide. CONTEXT.md's `retention` entry was extended and a `BlockUnavailableError` entry added, so the new vocabulary is in the glossary rather than only in code.

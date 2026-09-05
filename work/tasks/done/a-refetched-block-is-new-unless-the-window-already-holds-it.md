---
title: 'A re-fetched block is NEW unless the window already holds it, hash included'
slug: a-refetched-block-is-new-unless-the-window-already-holds-it
promotedFrom: observation:a-reorg-drops-new-logs-below-the-lowest-block-we-held
blockedBy: []
covers: []
---

## What to build

Stop `generateStreamToAppend` (`packages/core/src/internal/engine/utils.ts`) from silently discarding
logs the new branch of a reorg carries BELOW the lowest block our window happened to hold.

This is SILENT PERMANENT DATA LOSS, not an observability gap. The logs are fetched, dropped in
memory, and never fetched again, because the next range starts above them.

### The defect, exactly

On a concluded reorg the function sets `startingBlockForNewEvent = reorgBlock.number` and then admits
an incoming block only when `block.number >= startingBlockForNewEvent`. That threshold encodes the
claim "we already hold everything below this height", and the claim is FALSE: `unconfirmedBlocks`
holds only EVENT-BEARING blocks, so the window is sparse and its lowest entry is usually far above
the height the chain actually forked at.

So when the fork is below the lowest block we held logs for, every log the replacement branch carries
in that gap is inside the re-fetched range, is dropped by that comparison, and is gone.

**Reproduced, not theorised.** This test fails on `main` today:

```ts
// We hold ONE event-bearing block, at 200. The chain forks at 195, where we
// held nothing because 195 carried no logs for our filter.
const ls: LastSync<TestABI> = {
	context: CONTEXT,
	latestBlock: 205,
	lastFromBlock: 190,
	lastToBlock: 205,
	unconfirmedBlocks: [{hash: '0xa200', number: 200, events: [makeEvent(200, '0xa200')]}],
};

// the re-fetch carries a log at 196 (in the gap) and a replacement at 200
const incoming = [makeEvent(196, '0xb196'), makeEvent(200, '0xb200')];

const {eventStream, reorg} = generateStreamToAppend(ls, 0, incoming, {
	newLatestBlock: 210,
	newLastFromBlock: 193, // = getFromBlock: min(lastToBlock + 1, latestBlock - finality)
	newLastToBlock: 210,
	finality: 12,
});

expect(reorg).toBeDefined();
const delivered = eventStream.filter((e) => !e.removed).map((e) => `${e.blockNumber}:${e.blockHash}`);
expect(delivered).toContain('196:0xb196');
//   AssertionError: expected [ '200:0xb200' ] to include '196:0xb196'
```

### The shape of the fix, DECIDED

**A window MEMBERSHIP test replaces the scalar threshold.** An incoming block is NEW unless the
retained window already holds it by `(number, hash)`. It is not "new" merely by being above some
height, and it is not "known" merely by being below one.

This is not an invention. The REPLAY path in this same file already documents exactly this rule, and
says so in as many words: "an applied block whose hash is already there is SKIPPED rather than
delivered twice. That is the same job `startingBlockForNewEvent` does". The two paths were meant to
agree; only one of them got the sparse-window case right. Converge the live path onto the rule the
replay path already states.

**Why this is sound, and the invariant that makes it so.** A re-fetch never starts below
`latestBlock - finality` (`getFromBlock` clamps it), so every incoming block is inside the finality
window. Any block we previously applied that carried events is therefore still in `unconfirmedBlocks`
unless it was retracted. So "the window holds it" is a complete test for "we already applied it", and
nothing gets delivered twice.

## What this is NOT

- **NOT a change to reorg DETECTION.** How `reorgBlock` and `reorgCause` are found, and the
  absence-versus-contradiction split (ADR-0004), are untouched. If you are editing the detection
  loop, you have left this task.
- **NOT a change to retraction generation.** The blocks from `reorgedBlockIndex` onward are still
  re-emitted as `removed: true`, unchanged.
- **NOT a change to finality pruning** of the rebuilt `unconfirmedBlocks`.
- **NOT a widening of the re-fetched range.** The fix delivers logs already IN the range; do not make
  the fetcher reach further back to find a true fork point. That is a different and much larger
  design question, and this task must not open it.
- **NOT an incidental change to the no-reorg cases.** The scalar also serves the no-reorg branches
  (`last.number + 1`, and the empty-window case). Replacing the whole rule with window membership is
  ACCEPTABLE and probably right, but any resulting behaviour change on those paths must be
  deliberate, stated and tested, never a side effect nobody noticed.

## Acceptance criteria

- [ ] The reproduction above passes: a fork below the lowest held block delivers the new branch's
      logs in the gap. Asserted at the `generateStreamToAppend` seam.
- [ ] The same is asserted END TO END through a receiver, not only at the util, so the logs reach the
      stored emission stream and both feed views rather than only the in-memory stream.
- [ ] Nothing is delivered TWICE: a re-fetch that re-offers blocks the window already holds, at the
      same hashes, applies them once. Asserted, because this is what the discarded threshold was
      protecting and the fix must keep.
- [ ] A retracted block is still retracted: the existing reorg behaviour, including the
      absence-versus-contradiction classification and the `removed: true` re-emission, is unchanged.
      The existing engine and equivalence suites stay green without being edited to fit.
- [ ] The reorg COUNTERS still count once per concluded reorg in every shape (ADR-0050), unaffected
      by this change.
- [ ] Any deliberate change to the no-reorg paths is named in the report and covered by a test.
- [ ] Ship a changeset for `@etherfold/core` and any other published package whose behaviour changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None.

## Prompt

> Fix silent, permanent log loss in `generateStreamToAppend`
> (`packages/core/src/internal/engine/utils.ts`).
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/` and the ADRs (0004 on the wire contract and the two
> reorg classifications, 0050 on where a concluded reorg is counted)? If a premise no longer holds,
> route to needs-attention with the discrepancy rather than building on it.
>
> The defect: on a reorg the function admits an incoming block only when
> `block.number >= startingBlockForNewEvent`, where that value is `reorgBlock.number`. The threshold
> means "we already hold everything below this", which is false, because `unconfirmedBlocks` holds
> only EVENT-BEARING blocks and is therefore sparse. When the chain forks below the lowest block we
> held logs for, the replacement branch's logs in that gap are fetched, dropped by that comparison,
> and never fetched again because the next range starts above them. The task body carries a failing
> test that reproduces it; start by making it fail on your branch, then make it pass.
>
> It affects every deployment shape, because `StreamBuilder.receive` and `indexer.ts` both go through
> this util, and the loss propagates into the stored emission stream and both feed views.
>
> The fix is DECIDED: replace the scalar threshold with a WINDOW MEMBERSHIP test. An incoming block is
> new unless the retained window already holds it by `(number, hash)`. This is the rule the REPLAY
> path in this same file already documents ("an applied block whose hash is already there is SKIPPED
> rather than delivered twice. That is the same job `startingBlockForNewEvent` does"), so you are
> converging the live path onto a rule the file already states rather than inventing one. It is sound
> because a re-fetch never starts below `latestBlock - finality`, so every incoming block is inside
> the finality window and anything we applied with events is still in the window unless it was
> retracted.
>
> Do NOT touch reorg detection, retraction generation, or finality pruning, and do NOT widen the
> re-fetched range to hunt for a true fork point: the logs this delivers are already in the range.
>
> Test the once-only property as hard as the delivery property. The threshold you are removing was
> preventing double-application, so prove the window test still prevents it.
>
> Done means: the reproduction passes, the same is proven end to end through a receiver into the
> stored stream, nothing is applied twice, and every existing engine and equivalence test is still
> green WITHOUT being edited to fit.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular what happened to the no-reorg branches of the old scalar and whether their behaviour
> changed. This may well meet the ADR gate (`work/protocol/ADR-FORMAT.md`); if it does, write the ADR
> and name it in the block.

## Decisions

- **The no-reorg branches of the old scalar were replaced too, and one of them CHANGED BEHAVIOUR deliberately.** The scalar served three cases. (1) Empty window (`logEventsGroupedPerBlock[0].number`, or `0`): unchanged — an empty window holds nothing, so everything incoming is new, exactly as before. (2) Non-empty window, no reorg (`top + 1`): **changed** — a block inside the re-fetched range that the window does not hold is now delivered even when it sits below the window's top and nothing reorged. It is the same silent loss wearing different clothes (by the finality invariant we can never have applied it, or it would be in the window), so admitting it is the point rather than a side effect. Covered by `delivers a block the window never held even when NOTHING reorged`. Alternatives considered: keep the scalar for the no-reorg branches and only change the reorg branch (rejected: two rules for one question, and it leaves the same loss reachable without a fork), or lower the threshold to `newLastFromBlock` (rejected: it re-delivers the whole window every cycle, since the range always reaches back over it). Touches: every caller of `generateStreamToAppend` — `IndexerGeneration.feed`/`indexMore` and `StreamBuilder.receive` — and therefore the stored emission stream and both feed views.
- **The rebuilt `unconfirmedBlocks` is now SORTED ascending.** Under a height threshold nothing below a retained block could be delivered, so the window came out ordered for free; membership removes that, and the next cycle's reorg walk (which stops at the first contradiction) and `cursorSyncedThrough` (which cuts the window as a prefix) both read it in block order. `generateStreamFromReplay` already sorts, with the same comment. Alternative considered: insert delivered blocks in order instead of sorting (rejected: more code for a list bounded by the finality window, and the sort is what the replay path already does, so the two paths read alike). Touches: anything reading `LastSync.unconfirmedBlocks` — `checkTxInclusion`, `cursorSyncedThrough`, the replay walk.
- **A delivered gap block can sit BELOW a block the processor already applied, and that is safe rather than tolerated.** Any block above it that contributed state carried events, so it is in the window, so it was retracted in the same stream, so `forkPoint` reverts below it before the gap block is applied; a block with no events changed no state. This is why the fix needs no change to `applyEventStream` or to any store. Recorded because a reader meeting an apply at 103 after a revert to 104 would reasonably suspect an ordering bug.
- **Recorded as ADR-0051** (`docs/adr/0051-a-refetched-block-is-new-unless-the-window-already-holds-it.md`): hard to reverse (it decides what reaches the persisted emission stream), surprising without context (a fetch delivering below the fork point), and a real trade-off (widening the range to hunt the true fork point was the rejected alternative, explicitly out of scope here). ADR-0042 names `startingBlockForNewEvent`, which no longer exists; ADR-0051 states that it is what that rule became rather than editing the older record.

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

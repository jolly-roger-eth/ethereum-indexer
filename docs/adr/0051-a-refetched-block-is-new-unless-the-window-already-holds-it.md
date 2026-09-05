# A re-fetched block is NEW unless the unconfirmed window already holds it, hash included

`generateStreamToAppend` decided which incoming blocks to deliver with a HEIGHT: a block was new at or above `startingBlockForNewEvent` (`reorgBlock.number` on a concluded reorg, the window's top plus one otherwise). That threshold encodes the claim "we already hold everything below this height", and `unconfirmedBlocks` holds only EVENT-BEARING blocks, so the claim is false: the window is SPARSE and its lowest entry is usually far above the height the chain actually forked at. A fork below the lowest block we held logs for therefore lost every log the replacement branch carried in the gap — fetched, dropped in memory, and never fetched again, because the next range starts above them. We now decide by MEMBERSHIP instead: an incoming block is new unless the RETAINED window (what survived this cycle's retraction) already holds it by `(number, hash)`.

## Why membership is complete, and what it rests on

`getFromBlock` never starts a re-fetch below `latestBlock - finality`, and a block that carried events inside that window entered `unconfirmedBlocks` when it was applied. So every incoming block we have already applied is still in the window unless it was retracted, which makes "the window holds it" a complete test for "we already applied it". That is the property the removed threshold was really protecting, and it is why nothing is delivered twice: every cycle re-reads the last `finality` blocks and re-offers exactly the blocks the window holds.

Reading the RETAINED window rather than the one we arrived with is load-bearing in the other direction. A reorg concluded at the first window block retracts every later one too, and a re-fetch that still contains one of them must re-apply it under the same hash; a retracted block has left the window, so its re-offer is new again.

It is also the rule the REPLAY path already applied, by hash, for the same de-duplication reason (ADR-0042, which describes it as "the same job `startingBlockForNewEvent` does on the fetch path" — that name is gone, and this is what it became). The two entries were meant to agree; only one of them got the sparse-window case right.

## Considered options

- **Widen the re-fetched range to find the true fork point.** Rejected here: it is a much larger design question (how far back, on whose evidence, at what cost per cycle), and it is not needed for this loss. The logs being lost were already IN the range.
- **Lower the threshold to `newLastFromBlock`.** It would deliver the gap, and it would also re-deliver every held block in the range on every cycle, because the range always reaches back over the window. The threshold cannot be both a delivery bound and a de-duplication test.
- **Keep the threshold and accept the loss as an observability gap.** Rejected: the loss is silent, permanent and reaches the stored emission stream and both feed views, not just an in-memory stream.

## Consequences

- **The no-reorg path changed too, deliberately.** The scalar also served the two non-reorg branches, and membership replaces the whole rule. The empty-window branch is unchanged (an empty window holds nothing, so everything incoming is new, which is what `logEventsGroupedPerBlock[0].number` and `0` already produced). The non-empty branch is NOT unchanged: a block inside the re-fetched range that the window does not hold is now delivered even where it sits below the window's top and nothing reorged. That is the same silent loss wearing different clothes — by the invariant above we never applied it — and it is asserted rather than incidental.
- **The rebuilt window is SORTED ascending.** Under a height threshold nothing below a retained block could be delivered, so the order fell out for free; membership removes that guarantee, and the next cycle's reorg walk and `cursorSyncedThrough`'s prefix cut both read the window in block order. `generateStreamFromReplay` already sorted for the same reason.
- **A delivered gap block can sit below a block the processor already applied, and this is safe for the same reason membership is complete.** Any block above it that contributed state carried events, so it is in the window, so it was retracted in this same stream, so `forkPoint` reverts below it before the gap block is applied. A block that carried no events changed no state.
- **The fetch payload must still ASCEND** (`assertAscendingByBlock`), and the refusal is now about the ORDER OF DELIVERY alone rather than about blocks being dropped.

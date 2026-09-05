---
'@etherfold/core': patch
'@etherfold/server': patch
---

A concluded reorg no longer DROPS the logs the replacement branch carries below the lowest block we held logs for. They were fetched, discarded in memory and never fetched again, because the next range starts above them: silent, permanent loss, reaching the stored emission stream and both feed views and not only the in-memory stream.

`generateStreamToAppend` admitted an incoming block only at or above a HEIGHT (`reorgBlock.number` on a reorg, the window's top plus one otherwise). That threshold claims "we already hold everything below this", and `unconfirmedBlocks` holds only EVENT-BEARING blocks, so the window is SPARSE and its lowest entry is usually far above the height the chain actually forked at. Fork at 195 while the lowest block we held logs for is 200, and every log the new branch carries in 195..199 is inside the re-fetched range, dropped by the comparison, and gone.

The rule is now MEMBERSHIP of the retained window, by `(number, hash)`: a re-fetched block is NEW unless the window that survived this cycle's retraction already holds it. Nothing is delivered twice, which is the job the threshold was really doing — a re-fetch never starts below `latestBlock - finality`, and a block that carried events inside that window entered `unconfirmedBlocks` when it was applied, so anything we already applied is still there unless it was retracted. It is also the rule the REPLAY path in the same file already applied, by hash, for the same de-duplication reason; the two entries now agree.

Reorg DETECTION is untouched: the absence-versus-contradiction classification (ADR-0004), the retractions from the reorged block onward, the finality prune and the reorg counters (ADR-0050) all behave exactly as before, and no re-fetched range was widened.

Two deliberate consequences. The no-reorg path changed on the same ground: a block inside the re-fetched range the window does not hold is now delivered even when nothing reorged and it sits below the window's top (by the same invariant, we never applied it). And the rebuilt `unconfirmedBlocks` is sorted ascending, which a height threshold used to guarantee for free and the readers of that window still assume. See ADR-0051.

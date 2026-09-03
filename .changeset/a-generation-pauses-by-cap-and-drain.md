---
'@etherfold/core': minor
---

A generation PAUSES by capping `toBlock` and DRAINING, and resumes by removing the cap. It truncates nothing and reverts nothing.

`pause()` sets `maxToBlock` to the generation's cursor and does nothing else. The generation keeps being polled, fetches nothing above the cap but still re-scans the reorg window up to it, and goes idle by itself once the cap falls below `latestBlock - finality`. At that point every block it holds is FINAL and it is genuinely idle.

**It needs no new mechanism, which is the strongest argument for it.** The cap goes on `toBlock` BEFORE the existing `fromBlock > toBlock` guard, and the existing `getFromBlock` produces the whole behaviour: while `latestBlock - finality <= cap` it returns `latestBlock - finality`, so each round re-scans a SHRINKING `[latestBlock - finality, cap]` and corrects a reorg striking at or below the cap; once `latestBlock - finality > cap` it returns `cap + 1`, which is above the capped `toBlock`, so the indexer takes its existing "no new block" branch and fetches nothing. There is no timer, no new branch and no state machine. `lastSync.latestBlock` deliberately keeps tracking the REAL head — cap that too and the drain never idles.

The hazard this removes is real: a generation that simply STOPS carries an unconfirmed window it can no longer correct, so a reorg inside it is never found and the state permanently holds events from blocks that no longer exist. Draining waits that out instead of cutting it off — which is also what keeps a paused generation revertible-TO: moving the canonical pointer back to it restores its answers EXACTLY, minus nothing.

New API:

- **`IndexerGeneration.pause()` / `resume()`** — cap at the current cursor, and remove the cap. The cap is PINNED by the first paused cycle rather than by `pause()` itself, so a fetch in flight cannot leave the cursor above the cap with an unconfirmed window nothing re-scans.
- **`IndexerGeneration.pauseState`** and **`PauseState`** (`'running' | 'draining' | 'drained'`) — where a pause has got to, DERIVED from the cap and `getFromBlock` rather than stored, so `drained` is true exactly when the fetch loop takes its no-new-block branch. A pause is NOT instant: it takes up to `finality` blocks of continued light polling, and a driver that stops calling `indexMore()` when it pauses never completes it.
- **`IndexerGeneration.maxToBlock`** — the block a paused generation will not fetch above.
- **`Indexer.pause(id)` / `Indexer.resume(id)`** — the same, naming WHICH generation. Synchronous, because a pause is in memory and is deliberately not recorded in the registry: the registry holds what a generation IS, a pause is what one is DOING, so a reload comes back running.
- **`HeldGeneration.pauseState`** — read afresh from the engine on every access, so a consumer holding the object sees the drain complete.
- **`CannotPauseFollowerError`** — a FOLLOWER is refused: it fetches nothing and advances exactly as far as the stream it folds (ADR-0044), so a cap would govern a verb that never runs and `pauseState` would report a drain that is not happening. What stops a follower is stopping its stream's writer, or deleting it.

Two things this deliberately does NOT claim. `unconfirmedBlocks` may still LIST blocks once drained, because the re-add rule compares against the frozen `lastToBlock`; that is cosmetic, since every block it lists is final. And `revertTo` is never called on this path at all — it is destructive and capability-gated, and draining does not need it. See ADR-0045.

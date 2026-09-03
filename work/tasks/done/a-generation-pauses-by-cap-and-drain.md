---
title: 'A generation pauses by capping and draining, losing nothing, and resumes by uncapping'
slug: a-generation-pauses-by-cap-and-drain
spec: a-reconfigure-is-not-an-outage
blockedBy: [a-non-canonical-generation-advances-on-a-shared-stream]
covers: [10]
---

## What to build

PAUSE a generation so it stops indexing without being deleted, and resume it later, **without it ever
answering with state a reorg has invalidated underneath it**.

### Pause CAPS and DRAINS. It truncates nothing and reverts nothing.

Pause sets `maxToBlock = x` (the generation's current `lastToBlock`). The generation KEEPS POLLING,
fetching nothing above `x` but still re-scanning the reorg window up to it, until `x` falls below
`latestBlock - finality`. At that point every block it holds is FINAL and it is genuinely idle.

The hazard this addresses is real: a generation that simply STOPS carries an UNCONFIRMED window it can
no longer correct, so if one of those blocks is reorged away it never finds out and its state
permanently contains events from blocks that no longer exist. Draining removes the hazard by waiting it
out instead of by cutting it off.

### It needs NO new mechanism, which is the strongest argument for it

With `toBlock` capped at `x` and `lastToBlock = x`, the EXISTING `getFromBlock`
(`max(min(lastToBlock + 1, latestBlock - finality), 0)`) does the whole thing:

- while `latestBlock - finality <= x`, it returns `latestBlock - finality`, so each round re-scans
  `[latestBlock - finality, x]` — a SHRINKING window, correcting any reorg that touches what the
  generation holds;
- once `latestBlock - finality > x`, it returns `x + 1`, which is ABOVE the capped `toBlock`, so the
  indexer takes its existing `fromBlock > toBlock` "no new block" branch and fetches nothing.

So a paused generation self-terminates into a no-op poll.

**Two build details the spec settles, and both are easy to get backwards:**

1. The cap must be applied to `toBlock` **BEFORE** the existing `fromBlock > toBlock` guard.
2. `lastSync.latestBlock` must keep tracking the **REAL head**. Capping that too makes `getFromBlock`
   return `latestBlock - finality` forever and **the drain never idles**.

**Do not overclaim the end state.** `unconfirmedBlocks` may still LIST blocks, because the re-add rule
compares against `lastToBlock` and `lastToBlock` is frozen. That is COSMETIC: every block it lists is
below `latestBlock - finality` and therefore final, so nothing it describes can be invalidated and
nothing re-fetches to compare against it.

### Why this keeps stories 4 and 10 compatible

A TRUNCATING pause would have made them contradictory: story 4 wants the pointer moved BACK to restore
a generation's answers EXACTLY, while a truncating pause changes those answers. Draining preserves them
completely — a paused generation answers precisely what it answered at pause, minus nothing.

Two consequences to build deliberately: pause is NOT INSTANT (it takes up to `finality` blocks of
continued light polling), and a consumer should be able to SEE that draining state. `revertTo` is NOT
needed on this path, which matters because it is destructive and capability-gated.

This task owns the DRAINING state a consumer can see, which would otherwise fall between this and
`generation-progress-is-visible-and-a-bad-stream-degrades`.

## Acceptance criteria

- [ ] Pausing caps the generation's `toBlock` at its current `lastToBlock`; nothing is truncated and
      nothing is reverted. `revertTo` is not called on this path.
- [ ] **The generation keeps re-scanning a SHRINKING window and corrects a reorg that strikes at or
      below the cap**, asserted separately: its answers then differ from the pause instant, CORRECTLY,
      because they were wrong before.
- [ ] **Once the cap falls below `latestBlock - finality` it fetches nothing**, via the existing
      `fromBlock > toBlock` branch — assert no new branch was added for this.
- [ ] **A paused generation loses NOTHING**: in a NO-REORG scenario, its answers once idle are EXACTLY
      what they were at pause. (Asserted no-reorg, because this and the reorg-correction criterion are
      mutually exclusive once a reorg is corrected.)
- [ ] `lastSync.latestBlock` keeps tracking the REAL head; assert the drain actually reaches idle. A
      build that caps `latestBlock` too passes several criteria here and hangs on this one.
- [ ] **A paused generation is revertible-to**: move the pointer to it and assert it answers precisely
      what it answered before, with no re-index and no fetch (the story 4 / story 10 compatibility
      guard).
- [ ] **Resume is removing the cap**, and is correct: a reorg that struck BELOW the cap while draining
      was already corrected; one that struck ABOVE it is re-derived on the first uncapped round, since
      `getFromBlock` re-scans from `latestBlock - finality`.
- [ ] The DRAINING state is visible to a consumer.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-non-canonical-generation-advances-on-a-shared-stream` — pausing is pausing something that
  advances, and both edit the same browser module.

## Prompt

> Implement PAUSE and RESUME for a generation in the `etherfold` monorepo, by CAPPING its `toBlock` and
> letting it DRAIN — never by truncating it.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **The whole design is that this needs NO new mechanism.** Cap `toBlock` and the existing
> `getFromBlock` produces the drain for free: a shrinking re-scan while the cap is inside the finality
> window, then the existing "no new block" branch once it falls out of it. If you find yourself adding
> a branch, a timer or a state machine, re-read the spec — you have left the design.
>
> **Domain vocabulary.** *Pausing* caps and drains; it does not truncate and does not revert.
> *Draining* is the period of continued light polling until every block held is final. *Finality* is
> the existing reorg-window depth.
>
> **Where to look.** `getFromBlock` and the `fromBlock > toBlock` "no new block" branch in the core
> indexer; `lastSync` (`lastToBlock`, `latestBlock`, `unconfirmedBlocks`); the generation container.
>
> **Easy to get wrong:**
>
> - Capping `lastSync.latestBlock` as well as `toBlock`. Then `getFromBlock` returns
>   `latestBlock - finality` forever and the drain NEVER idles.
> - Applying the cap AFTER the `fromBlock > toBlock` guard instead of before it.
> - Truncating on pause. It would contradict the promise that moving the pointer back restores a
>   generation's answers exactly.
> - Claiming `unconfirmedBlocks` empties. It may still list blocks; that is cosmetic, because every one
>   of them is final.
>
> **Scope fence.** Do NOT build the promotion policy or its trigger. Do NOT use `revertTo` (destructive
> and capability-gated, and not needed on this path). Do NOT build the progress/degradation reporting
> beyond the DRAINING state this task owns.
>
> Done means: pause caps and drains to a genuine idle, a reorg at or below the cap is still corrected,
> a no-reorg pause loses nothing, the pointer can move back to it exactly, and resume is just removing
> the cap.

## Decisions

**Pausing a FOLLOWER is REFUSED (`CannotPauseFollowerError`) rather than silently accepted.** A cap governs the verb that FETCHES; a follower fetches nothing and advances exactly as far as the stream it folds (ADR-0044), so a cap would sit on a verb that never runs and `pauseState` would report a drain that is not happening. A pause that lies is worse than a refusal, because the entire value of `drained` is knowing nothing invalidatable is still being answered. Alternatives considered: (a) accept and no-op — rejected as a lying report; (b) honour the cap on the follow path by clamping the replayed stream — rejected because it does not work without also changing the follow path's "nothing new" guard: clamping before it makes the follower idle instantly with an uncorrected window, and clamping after it still misses corrections once the writer's own cursor freezes, and its drain would not terminate. That is a follow-path redesign, outside this task's fence. Touches `a-non-canonical-generation-advances-on-a-shared-stream` (the guard) and `the-promotion-policy-moves-the-canonical-pointer` (what pausing/deleting a stream's writer does to its followers). Recorded in ADR-0045 and in the error's JSDoc.

**The cap is PINNED BY THE FIRST PAUSED CYCLE, not by `pause()` itself.** `pause()` is synchronous and a fetch may be in flight; a cap pinned from the cursor at that instant could sit BELOW the cursor the racing batch leaves behind, and `getFromBlock` would then immediately ask above it — so the generation would go idle holding an unconfirmed window it never re-scanned, which is the exact hazard draining exists to remove. Pinned inside the serialized index action it is, by construction, the cursor the paused generation actually has. Alternative considered: pin eagerly and clamp with `max(cap, lastToBlock)` at fetch time — rejected as a self-adjusting cap whose reported value nobody could trust. Visible consequence: `maxToBlock` is `undefined` between `pause()` and the next cycle, and `pauseState` reports `draining` there.

**A pause is IN MEMORY and is not recorded in the registry, so `Indexer.pause` is synchronous.** The registry holds what a generation IS; a pause is what one is DOING. A reload comes back running, which costs one more drain to re-pause and never costs correctness. Alternative considered: a `paused` field on `GenerationRecord` — rejected as a registry surface change (that task's), for durability nothing has asked for yet. Touches `generations-are-registered-and-one-pointer-is-canonical` if durable pause is ever wanted.

**A pause SURVIVES a reconfigure within the session** (`reinit` does not clear the cap; only `resume()` lifts it), because "do not go above x" is a decision about this generation, not about the source it was made under. Documented at `pause()`.

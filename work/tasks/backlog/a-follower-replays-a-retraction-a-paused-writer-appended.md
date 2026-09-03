---
title: 'A follower replays a retraction a PAUSED writer appended, instead of keeping a dead branch'
slug: a-follower-replays-a-retraction-a-paused-writer-appended
promotedFrom: observation:a-paused-writers-frozen-cursor-can-hide-a-retraction-from-its-followers
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

Make a follower notice a retraction that the writer it follows appended WHILE PAUSED. Today it does
not, and the result is silent: the follower keeps events from a branch the chain abandoned, its state
diverges from the stream it claims to be a fold of, and nothing reports it.

The mechanism is already diagnosed and the fix should start from it rather than re-deriving it.
`IndexerGeneration.promiseToFollow` decides whether there is anything to follow by comparing the
STORED stream cursor's `lastToBlock` against its own:

```ts
if (lastSyncStored.lastToBlock <= current.lastToBlock) return current;
```

That is sound for a RUNNING writer, whose `lastToBlock` rises with the tip on every cycle, so any
append is preceded by the cursor moving. It is wrong for a PAUSED one. `a-generation-pauses-by-cap-and-drain`
caps `toBlock` at the cursor the generation paused on and keeps re-scanning a SHRINKING window, which
is exactly the state in which the writer can still DETECT a reorg at or below the cap, append the
retraction and its replacement to the stream, and leave `lastToBlock` unmoved. A follower level with
the cap then takes the early return and never replays either.

**This is a composition defect, not a mistake in either task.** The guard was written by
`a-non-canonical-generation-advances-on-a-shared-stream` when a frozen cursor could not exist, and
`a-generation-pauses-by-cap-and-drain` created one. Both are individually correct; the bug lives only
in their meeting. Say that in the fix's reasoning, because the next person to add a cursor-derived
shortcut needs to know why this one was replaced.

### The shape of the fix

The follower's advance must be driven by WHAT THE STREAM NOW SAYS, not by a cursor comparison that
assumes a monotonically advancing writer. That is the same correction `a-non-canonical-generation-advances-on-a-shared-stream`
already made once at a different level (a replay HONOURS the verdicts it is handed rather than
recomputing them), and the same reason `Indexer.pause` refuses a follower outright
(`CannotPauseFollowerError`, ADR-0045): a follower's advance is a function of the stream, and a cursor
is a summary of it that can lie.

Do NOT simply delete the early return. It is there so an idle follower does no work, and removing it
makes every cycle re-walk the whole stream. Find the cheap question that is actually equivalent to
"has this stream changed since I last folded it" under a paused writer as well as a running one, and
say why the one you choose cannot go stale the way `lastToBlock` does.

## What this is NOT

- **NOT a change to pause.** Capping `toBlock` and leaving `latestBlock` tracking the real head is
  settled by ADR-0045 and its criteria; the paused writer is behaving correctly here, and a fix that
  makes a paused writer move its `lastToBlock` would break the drain's own termination condition.
- **NOT a relaxation of the one-writer rule.** The follower still holds a read-only stream view and
  still appends nothing (ADR-0044).
- **NOT a fix for `Indexer.pause`'s refusal of a follower.** That refusal is correct and stays.

## Acceptance criteria

- [ ] **The regression is pinned FIRST, and fails before the fix**: a writer indexes past a reorg
      point, is PAUSED, then detects a reorg at or below its cap and appends the retraction plus the
      replacement to the shared stream, while a follower sits level with the cap. Assert the follower
      currently keeps the dead branch, then invert it.
- [ ] After the fix the follower replays the retraction and the replacement, in the same order the
      writer emitted them, and lands on the SAME state a from-scratch fold of that stream lands on.
- [ ] The follower still does NO work when the stream genuinely has not changed: assert a cycle over
      an unchanged stream neither re-walks it nor re-delivers anything to the processor, so the fix
      is not "remove the early return".
- [ ] The follower still fetches nothing and writes nothing (`a-non-canonical-generation-advances-on-a-shared-stream`'s
      criteria stay green): zero `eth_getLogs`, zero segments written, zero clears.
- [ ] The same scenario with a RUNNING (unpaused) writer behaves exactly as it does today, asserted so
      the fix is not a behaviour change on the path that was already correct.
- [ ] A resumed writer's followers are unaffected: after `resume` removes the cap, following works as
      it does today.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None. `a-non-canonical-generation-advances-on-a-shared-stream` and `a-generation-pauses-by-cap-and-drain`
  are both in `work/tasks/done/`; this is the seam between them.

## Prompt

> Fix a silent correctness bug in the etherfold generation model: a follower does not replay a
> retraction that the writer it follows appended while PAUSED, so it keeps state derived from a chain
> branch that was abandoned.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, the tasks in `work/tasks/done/`, and the relevant ADRs (0044 on how a
> successor advances, 0045 on pause, 0042 on a replay honouring the verdicts it carries)? If a
> dependency landed differently than this task assumes, do not build on the stale premise — route the
> task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> The behaviour required is settled and needs no new design: a follower's state must be a function of
> the stream it follows, whatever the writer's cursor happens to say. What is open is only the
> MECHANISM by which a follower cheaply decides there is something new to fold.
>
> Vocabulary. A **generation** is a stream plus a fold over it; an **indexer** holds several and one is
> **canonical**. A generation on a SHARED stream is a **follower**: it fetches nothing, re-folds the
> stored stream and then follows it as the writer appends (ADR-0044). **Pause** caps a generation's
> `toBlock` at the cursor it paused on and re-scans a SHRINKING window until the cap falls below
> `latestBlock - finality`, while `latestBlock` keeps tracking the real head (ADR-0045).
>
> The defect: `IndexerGeneration.promiseToFollow` returns early when `lastSyncStored.lastToBlock <=
> current.lastToBlock`. A paused writer's `lastToBlock` is FROZEN at its cap, so a reorg it detects and
> appends during its drain moves the stream without moving that cursor, and a follower level with the
> cap takes the early return and never replays the retraction. It was unreachable before pause landed,
> because a running writer's `lastToBlock` rises with the tip every cycle.
>
> Where to work: `packages/core`, the follow path. Write the failing test FIRST and confirm it goes red
> before the fix and green after; the scenario is a paused writer appending a retraction below its cap
> while a follower sits level with it.
>
> Hard constraints. (1) Do NOT change pause: a paused writer freezing `lastToBlock` while `latestBlock`
> tracks the head is ADR-0045 and its drain terminates on it. (2) Do NOT delete the early return
> outright — an idle follower must still do no work, and a fix that re-walks the whole stream every
> cycle trades a correctness bug for a performance one. Find the question that is genuinely equivalent
> to "has this stream changed", and say why your answer cannot go stale the way `lastToBlock` did.
> (3) Do NOT relax the one-writer rule: the follower keeps its read-only stream view.
>
> Done means: the pinned regression is inverted, the follower lands on the same state a from-scratch
> fold of that stream lands on, an unchanged stream still costs nothing, and the follower still issues
> zero `eth_getLogs` and writes zero segments.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT — in
> particular the question you replaced the cursor comparison with, and why it cannot go stale. If the
> choice meets the ADR gate (hard to reverse + surprising without context + a real trade-off, see
> `work/protocol/ADR-FORMAT.md`), ALSO write it as an ADR in `docs/adr/` and name it in the block.

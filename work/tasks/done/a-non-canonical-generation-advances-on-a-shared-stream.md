---
title: 'A non-canonical generation actually advances, following a shared stream without fetching'
slug: a-non-canonical-generation-advances-on-a-shared-stream
spec: a-reconfigure-is-not-an-outage
blockedBy: [the-old-indexer-shape-is-deleted]
covers: []
---

## What to build

A second generation that ACTUALLY ADVANCES, alongside the canonical one. The registry CREATES
generations and the container HOLDS them — both testable with no indexer running — and pausing only
STOPS one. Nothing yet makes a non-canonical generation move, and the spec's headline rests on it.

This task is never a named deliverer of a story, and that is deliberate rather than an orphan: it is
the DEPENDENCY under stories 1, 3, 13 and 14, whose observable behaviour
`the-promotion-policy-moves-the-canonical-pointer` delivers.

### HOW it advances is DETERMINED, not configured

This is the load-bearing rule, and an earlier draft of the spec got it wrong by offering it as a knob.
Whether the successor fetches is decided by whether it SHARES A STREAM, and by nothing else.

**SAME stream** (a processor-only change — the free case): **the successor FETCHES NOTHING.** It
re-folds the stored stream from the start, then FOLLOWS it as the canonical generation's indexer
appends. Anything else breaks three things at once:

1. The spec's own test says a processor-only change re-fetches NOTHING, "zero, not fewer" — a
   head-following poller makes it fewer.
2. The one-writer rule breaks, because an ordinary indexer pointed at that stream APPENDS to it: the
   save is driven by the indexing loop rather than by the caller's intent, so "a second generation
   that merely reads" is not expressible by configuration — it needs the read-only view below.
3. Most seriously, the successor's state would become a function of ITS OWN FETCH rather than of the
   stream, so a later re-fold of the stored stream yields a DIFFERENT state. That stops a generation
   being "a stream plus a fold over it", and breaks story 4's promise that moving the pointer back
   restores answers EXACTLY, and the server's rebuild-from-the-stored-stream story with it.

**DIFFERENT streams** (a filter change): the successor fetches its own, because it must — the logs it
needs were never requested under the old filter. Nothing new is built for this case: it is an ordinary
indexer with a different stream address.

### The genuinely new mechanism: a READ-ONLY STREAM VIEW

A pure reader is not expressible by simply declining to write, because READ and WRITE share ONE
`ExistingStream` seam: a generation handed the stream to fold is handed the thing that also appends.
The follower needs a **read-only stream view whose `saveNewEvents` is a no-op**.

**A precedent already exists — GENERALISE it, do not write a second one.** `replayStream` (core's
stream fixture module) is exactly this shape: it never writes and its `saveNewEvents` is documented as
a no-op. Start from it rather than inventing a parallel view, and say in your Decisions block whether
you generalised it or deliberately kept them separate.

## Acceptance criteria

- [ ] A non-canonical generation ADVANCES alongside the canonical one, in both the shared-stream and
      the separate-stream case.
- [ ] **On a SHARED stream the follower issues NO `eth_getLogs` AT ALL and writes NO segment.** Assert
      both directly, at the fetch seam and at the stream keeper. This is the criterion that fails if
      anyone reaches for a head-following poller.
- [ ] The shared-stream follower re-folds the stored stream from the start, then follows it as the
      canonical generation's indexer appends. Assert it converges to the same state as a from-scratch
      fold of that stream.
- [ ] **The successor's state is a function of the STREAM, not of its own fetch**: re-folding the
      stored stream later yields the SAME state. This is what keeps story 4's exact-revert promise
      true.
- [ ] A read-only stream view exists whose `saveNewEvents` is a no-op, and the follower uses it.
      Assert the one-writer rule holds: only the indexing generation appends.
- [ ] On DIFFERENT streams the successor fetches its own history, and the two streams never share
      entries.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `the-old-indexer-shape-is-deleted` — the container must be the only shape before a second generation
  can be run inside it, and both edit the same browser module.

## Prompt

> Make a NON-CANONICAL generation actually advance in the `etherfold` monorepo, alongside the canonical
> one, without breaking the rule that a generation is "a stream plus a fold over it".
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) and ADR-0008 (the
> blue/green rebuild from the stored stream) before starting. The design record
> `work/notes/ideas/stream-grafting-what-we-established.md` carries the invariants and the options
> weighed, including the read-only stream view that was removed and is now needed again.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **The rule that decides everything: HOW a successor advances is DETERMINED by whether it shares a
> stream, and is NEVER a configuration knob.** Same stream: fetch NOTHING, re-fold the stored stream,
> then follow it. Different stream: fetch your own, which is just an ordinary indexer at a different
> address.
>
> **Domain vocabulary.** A *generation* is a stream plus a fold over it. The *canonical* generation
> answers reads. A *follower* is a non-canonical generation on a SHARED stream; the *one-writer rule*
> is that only the indexing generation appends to a stream.
>
> **Where to look.** The indexer's fetch loop and its unconditional `saveNewEvents` call; the
> `ExistingStream` seam and the segmented-stream helper; the generation container.
>
> **Easy to get wrong:**
>
> - Giving the follower a head-following poller. It makes the fetch count "fewer" instead of ZERO,
>   breaks the one-writer rule because `saveNewEvents` is unconditional, and — worst — makes the
>   successor's state a function of its own fetch, so a later re-fold gives a DIFFERENT state and the
>   exact-revert promise dies.
> - Trying to express "read-only" by just not calling save. Read and write share one `ExistingStream`
>   seam; use a read-only view whose `saveNewEvents` is a no-op, generalising the existing
>   `replayStream` precedent rather than adding a second one.
>
> **Scope fence.** Do NOT build the promotion POLICY or its trigger (that is
> `the-promotion-policy-moves-the-canonical-pointer`). Do NOT build pause/resume. Do NOT implement
> seeding from a published artifact (a separate proposed spec) — creation already takes its starting
> stream as an input.
>
> Done means: a second generation advances, a shared-stream follower fetches zero logs and writes zero
> segments, and re-folding the stored stream later reproduces its state exactly.

## Decisions

**Which generation WRITES a shared stream: the FIRST one held on it (registration order), not the canonical one.** Chosen because the writer must be stable: moving the canonical pointer is one small record write and must not silently hand the append duty to a different engine mid-flight. Alternative considered: "the canonical generation writes", which makes the writer move with every promotion and would make a promoted follower start fetching a stream it had been folding. In the ordinary case the two coincide, since the registry makes the first generation registered canonical. Touches `the-promotion-policy-moves-the-canonical-pointer` (after a promotion the retired generation goes on writing the shared stream and the new canonical one keeps following it — which is the correct model, but that task owns confirming it) and `a-generation-pauses-by-cap-and-drain` (pausing or deleting a stream's writer strands its followers). Recorded in ADR-0044 and in `Indexer.add`'s JSDoc.

**`GenerationSpec.source` is per generation; the stream CONFIG is not.** A stream is its fetch filter, so naming a different `source` is the only way to express the separate-stream case, and it is also what makes the follow-or-fetch rule determined rather than configured. I deliberately did **not** add a per-spec `streamConfig`: `setStreamConfig` is a single mutable value on the ONE keeper a container holds ("one keeper serves one indexer"), so two generations under different configs would clobber each other's stream address. Alternative considered: a per-generation keeper on the spec, which is a larger surface nothing needs yet. A config change is still a new stream; reaching it needs a keeper per generation. Touches any later task that turns a stream-config reconfigure into a new generation. Documented at the field and in ADR-0044's consequences.

**`Indexer.load()`, `indexMore()`, `disableProcessing()` and `reenableProcessing()` now apply to EVERY held generation, not the canonical one alone.** A generation that never loaded has no state and no cursor to advance from, so "a non-canonical generation advances" is not reachable without it; and a container whose stop verb only stopped one of N generations would be lying. `indexMore` still returns the canonical generation's cursor, resolved before the loop so a mid-cycle promotion cannot swap what is reported. Alternative considered: a separate `advanceOthers()` verb, rejected because it makes every driver in the repo (browser hook, CLI, tests) responsible for remembering to call it, and forgetting is silent. Touches `packages/browser`'s `IndexerState` drive loop, which holds one generation today and is unaffected.

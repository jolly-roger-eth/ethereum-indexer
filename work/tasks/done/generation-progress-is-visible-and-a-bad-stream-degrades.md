---
title: 'A non-canonical generation reports its progress, and an unusable stream degrades to a re-index'
slug: generation-progress-is-visible-and-a-bad-stream-degrades
spec: a-reconfigure-is-not-an-outage
blockedBy: [the-promotion-policy-moves-the-canonical-pointer]
covers: [5, 12]
---

## What to build

Two small things that were unowned by every other landable, and one of them is the guard that stops a
corrupt stream taking the app down with it.

### Progress (story 5)

`SyncingState` reports that a NON-CANONICAL generation exists and how far it has caught up.

The reason this is the developer's business and not the library's: **only the developer knows whether
their reconfigure made the old answers WRONG or merely INCOMPLETE.** So the library's job is to report
the fact and the distance, and the app decides whether to render, dim or hide. Do not decide it for
them.

Progress is reported while a generation is BEHIND and **stops being reported once it is canonical**.

### Degradation (story 12)

When a generation's stream is UNAVAILABLE or UNREADABLE, fall back to a **full re-index, which is
today's behaviour**, so the feature degrades rather than breaks.

This is the guard that matters: without it, a corrupt or missing stream turns a reconfigure into a dead
app instead of a slow one. Note the existing precedent it must match rather than reinvent — the stream
keeper already CLEARS an inconsistent stream and returns nothing rather than throwing, precisely
because the indexer's `fetchFrom` call site has no `try`/`catch` and a throw makes the indexer
permanently unloadable. Degrade the same way.

## Acceptance criteria

- [ ] `SyncingState` reports that a non-canonical generation EXISTS and HOW FAR it has caught up
      (story 5).
- [ ] Progress is reported while the generation is behind and **stops being reported once it becomes
      canonical**.
- [ ] The library does NOT decide whether to render, dim or hide; it reports the fact and the distance
      and leaves the choice to the app. Assert the information is sufficient for all three choices.
- [ ] **A generation whose stream is unavailable or unreadable falls back to a FULL RE-INDEX** — today's
      behaviour — rather than throwing (story 12). Assert the app still works and the indexer does not
      become permanently unloadable.
- [ ] The degradation path matches the existing keeper precedent (clear/return-nothing, never throw
      into a call site with no `try`/`catch`).
- [ ] Round-trip through every stream keeper that actually exists. At the time of writing that is ONE
      (the browser's IndexedDB keeper over core's segmented-stream helper) — filesystem stream storage
      is deliberately not supported and its package is deleted. If a second keeper has landed by the
      time you build this, cover both; do not invent one to satisfy this line.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `the-promotion-policy-moves-the-canonical-pointer` — progress reporting stops AT promotion, so the
  promotion trigger must exist; and this is the last of the tasks sharing the same browser module.

## Prompt

> Make a non-canonical generation's PROGRESS visible, and make a generation whose stream is unusable
> DEGRADE to a full re-index rather than break, in the `etherfold` monorepo.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **Why the app decides, not the library.** Only the developer knows whether their reconfigure made the
> old answers WRONG or merely INCOMPLETE, so report the fact and the distance and let them choose to
> render, dim or hide. A library that picks for them is picking wrong half the time.
>
> **Domain vocabulary.** `SyncingState` is the existing reported sync status. A *non-canonical*
> generation is one that is not currently answering reads.
>
> **Where to look.** `SyncingState` at the top of the browser package's `IndexerState.ts`; the
> generation container and the canonical pointer; the stream keeper's existing
> clear-and-return-nothing behaviour on an inconsistent stream, and the `fetchFrom` call site in the
> core indexer that has no `try`/`catch` (which is WHY the degradation must not throw).
>
> **Easy to get wrong:**
>
> - Throwing when a stream is unusable. The `fetchFrom` call site does not catch, so a throw makes the
>   indexer permanently unloadable — for a LOCAL CACHE whose correct recovery is to re-index.
> - Continuing to report progress after the generation becomes canonical.
> - Deciding the render/dim/hide policy inside the library.
>
> **Scope fence.** Do NOT change the promotion policy or its trigger. Do NOT change pausing. Do NOT add
> per-read generation provenance — that is explicitly out of scope for this spec and belongs to a query
> layer.
>
> Done means: an app can see a second generation and how far behind it is, that reporting stops at
> promotion, and a corrupt stream costs a re-index rather than the app.

## Decisions

- **A failed WRITE still raises; only the read side degrades.** `degradingStream` guards `fetchFrom` and `clear` and passes `saveNewEvents` through. Chosen because the write path already has a caller that ACTS on the failure (`IndexerGeneration.promiseToSave` counts it, paces the retry, freezes the cache, and until then does not process the batch): swallowing it would report success there, so the state would advance past events the stream never received — a HOLE, which nothing downstream can detect and no reload repairs. Alternative considered and rejected: degrade all three methods for symmetry. **Touches:** the engine's freeze path (ADR-0038), and every present and future stream keeper — the asymmetry is documented at the choice site and in the changeset so it is not "fixed" later.
- **The guard lives in the KEEPER, not at the engine's `fetchFrom` call site.** Wrapping `config.keepStream` inside `IndexerGeneration` would have been the broader net, but it would also swallow a keeper's deliberate refusal (`replayStream` rejects a fixture captured on another chain) and would re-site a rule the repo already places on keepers ("`fetchFrom` must not throw", `the-stream-appends-in-segments-on-indexeddb`). The acceptance criterion asks for the existing keeper precedent, so keeper-side it is. **Touches:** any future keeper (SQL, OPFS) — one built over the segment port inherits the rule; one that is not must apply `degradingStream` itself, which is why it is exported.
- **Every non-canonical generation is reported, including the retained predecessor after a promotion** — not only generations that are *behind*. Filtering to "behind" would be the library deciding what matters; the predecessor being held (at distance 0) is the fact that makes moving the pointer BACK a revert, and an app that only cares about a successor filters on `blocksBehind !== 0`. Alternative considered: report only successors that have not caught up. **Touches:** apps reading `SyncingState`, and the revert story (4).
- **`blocksBehind` is floored at zero and no percentage is reported.** A generation ahead of the canonical one (which `manual` allows) reads as "not behind" rather than as a negative number, and the two cursors are both reported for an app that needs the exact relation. A percentage was rejected on coherence grounds: `ExtendedLastSync.syncPercentage` already means "processed over the span from `defaultFromBlock` to `latestBlock`", and a second `syncPercentage` over a catch-up span would make one word mean two things. **Touches:** app-side progress UI.
- **Naming (coherence check).** `SyncingState.nonCanonicalGenerations` deliberately does NOT reuse `generations`, which on the same hook already means *every* held generation including the canonical one; `GenerationProgress` is a new name with no prior use in `packages/*/src` or the `CONTEXT.md` glossary; `degradingStream` sits beside `readOnlyStream` as the second combinator on the same seam and takes the story's own word ("degrades rather than breaks"). `HeldGeneration.lastSync` reuses the existing `LastSync` vocabulary rather than inventing a "progress" record in core.
- **No ADR opened.** The read/write asymmetry is a COROLLARY of two ADRs already on the books (ADR-0035: an inconsistent stream is cleared rather than repaired; ADR-0038: the engine is the arbiter of the write path), not a decision that reverses either, so it is recorded at the choice site and in the changeset instead of minting ADR-0047. If a reviewer reads it as a new system-level invariant rather than a corollary, it is cheap to promote.

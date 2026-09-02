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

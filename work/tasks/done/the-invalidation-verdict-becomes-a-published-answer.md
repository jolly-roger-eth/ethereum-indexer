---
title: 'The invalidation verdict becomes a published, actionable answer'
slug: the-invalidation-verdict-becomes-a-published-answer
spec: a-reconfigure-is-not-an-outage
blockedBy: [generations-are-registered-and-one-pointer-is-canonical]
covers: []
---

## What to build

The invalidation verdict is computed today and then thrown away. `sourceInvalidationOf` is INTERNAL
(core re-exports only `ReorgCause`/`ReorgDetection` from that module, and core's `exports` map is `.`
plus `./package.json`), and `updateIndexer` computes the verdict and discards it — the code itself
says the block "is carried no further than the log line". The container that will act on it is
browser-side, so the verdict has to cross that boundary.

Publish it, and grow `ReconfigureOutcome` so a caller can act on it.

### This task is deliberately ADDITIVE

It publishes the verdict **while the verbs still discard as they do today.** Removing the discard
belongs to `the-generation-container-expands-beside-the-old-shape` and its migrate/contract batches,
which land the container that replaces it.

Keep the two-step, but for the RIGHT reason: it is NOT to spare a consumer a breaking change (nothing
is published, per `CONTEXT.md`). It is so **each landable lands GREEN on its own**, which is
`TASKING-PROTOCOL` §3a's expand-then-contract and applies whatever the release status.

A consequence worth stating so it is not read as a hole: a no-op reconfigure is not OBSERVABLY free
until the container removes the discard. **That is why this task carries `covers: []` and story 7 is
labelled on `the-old-indexer-shape-is-deleted`** — a task should not be the named deliverer of a story
whose observable half it explicitly defers. This task builds the verdict the story rests on; the
contract batch is where the story becomes true.

### The `stateDiscarded` sweep

`stateDiscarded` has **38 references**: `packages/core` (11), `packages/browser` (23),
`examples/browser-reference` (2), `docs/guide/indexing-in-a-browser-app/index.md` (2). Derive the list
rather than trusting these numbers — they are a launch snapshot — but do not discover them at build
time by going red: sweep them deliberately as part of this task.

### What must NOT regress

**Whether a reconfigure creates anything at all is still the VERDICT, not digest equality.**
`sourceInvalidationOf` deliberately ignores an added entry whose `startBlock` is above `lastToBlock`,
so appending an event above the cursor is FREE today, and digest inequality alone would regress exactly
the case ADR-0034 made free. The verdict decides whether anything is invalid; the digests decide WHICH
stream and WHICH generation the result belongs to. Both, at different jobs. An event appended above the
cursor is the regression guard.

## Acceptance criteria

- [ ] The invalidation verdict is PUBLISHED from `@etherfold/core` (a real export, reachable across
      the package boundary) rather than computed and dropped.
- [ ] `ReconfigureOutcome` grows to carry the verdict in an actionable form.
- [ ] **The verbs still discard exactly as they do today.** This task is additive; assert current
      behaviour is unchanged, so it lands green on its own.
- [ ] **A no-op reconfigure creates nothing**, asserted on ranges fetched AND state discarded — the
      pair ADR-0034 established. **An event appended ABOVE the cursor is the regression guard**: assert
      it is still FREE, i.e. the verdict, not digest inequality, decides.
- [ ] The `stateDiscarded` references are swept deliberately across core, browser, the example app and
      the guide doc, with the list DERIVED rather than read off this file.
- [ ] Ship a changeset for every published package whose surface changes (this changes core's public
      surface).
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `generations-are-registered-and-one-pointer-is-canonical` — this and every later browser-side task
  edit `IndexerState.ts` (`SyncingState`, `createIndexerState`, the `stateDiscarded` sites), so they
  are serialised to keep rebases trivial.

## Prompt

> Make the invalidation verdict a PUBLISHED, actionable answer in the `etherfold` monorepo, instead of
> a value that is computed and then discarded.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) and ADR-0034 (which
> made an append above the cursor free) before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **This task is deliberately ADDITIVE and that is the point.** Publish the verdict and grow
> `ReconfigureOutcome`, but leave the verbs discarding exactly as they do today. The container that
> consumes the verdict and removes the discard is a LATER task. The reason is not backward
> compatibility (nothing is published) — it is that each landable must go green on its own, per
> `TASKING-PROTOCOL` §3a.
>
> **Domain vocabulary.** The *verdict* is what `sourceInvalidationOf` answers about whether a
> reconfigure invalidates anything. It is distinct from the *stream digest*: the verdict decides
> WHETHER anything is invalid, the digest decides WHICH stream and generation a result belongs to.
>
> **Where to look.** `sourceInvalidationOf` and `ReorgCause`/`ReorgDetection` in `@etherfold/core`;
> core's `exports` map; `updateIndexer` where the verdict is currently dropped; `ReconfigureOutcome`;
> and the `stateDiscarded` references across core, browser, `examples/browser-reference` and the
> browser-app guide.
>
> **Easy to get wrong:**
>
> - Letting digest inequality decide whether a reconfigure invalidates anything. It must stay the
>   VERDICT: an entry added above `lastToBlock` is FREE today and must remain free.
> - Removing the discard here. That is the container's task; doing it now makes this landable
>   un-green in isolation and collides with the container work.
> - Discovering the `stateDiscarded` sites by going red. Sweep them deliberately.
>
> **Scope fence.** Do NOT build the container, the indirect handle, or the factory migration. Do NOT
> rename `EthereumIndexer`. Do NOT make a generation advance or promote.
>
> Done means: a consumer outside core can read the verdict and act on it, the verbs behave exactly as
> before, and a no-op reconfigure still costs nothing.

## Decisions

**`sourceInvalidation` is OPTIONAL, and absent on `updateProcessor` and `reset`.** Chosen because those two verbs ask no source question: a processor swap moves neither the fetch filter nor the decoding shape, and `reset` is a discard by fiat that also *clears* the cached stream. The alternative I considered was a non-optional field carrying the trivially-valid verdict (`{state: {valid: true}, stream: {valid: true}}`) for all three verbs, which is what literally computing it would return. I rejected it for `reset` specifically: `stream: {valid: true}` is true *of the source* but reads as "the cached stream stands" about a stream `reset` has just deleted, and the container that consumes this is exactly the caller that would act on it. `undefined` is the standard spelling of "not asked" and cannot be misread. What it touches: the later `the-generation-container-expands-beside-the-old-shape` / `every-caller-moves-onto-the-generation-container` tasks, which must handle `undefined` on those two verbs (the verb itself tells them what to do there); `@etherfold/browser`'s `IndexerState` forwards the outcome untouched, so nothing there changes.

**The verdict TYPES are exported; `sourceInvalidationOf` is NOT.** Chosen so the verdict stays *reported* rather than re-derived, which is the argument `ReconfigureOutcome`'s own doc already makes for `stateDiscarded`: a caller hashing its own source gets a second answer that can disagree with the one the core acted on, and it fails silently. The alternative was exporting the function too, which the acceptance criterion's "a real export" would also satisfy. What it touches: any later task that wants to ask the invalidation question *outside* a reconfigure would need a further, deliberate export decision rather than finding it already open.

**Field named `sourceInvalidation`, not `invalidation`.** Coherence check against `CONTEXT.md`'s glossary: `SourceInvalidation` / `sourceInvalidationOf` already name exactly this concept, so this reuses the existing language rather than forking a new one. The shorter `invalidation` would have re-meant it as "what this reconfigure invalidated", which for `reset` is a different (and larger) set than what the source comparison decided. No new concept was introduced.

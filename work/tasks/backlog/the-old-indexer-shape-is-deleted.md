---
title: 'CONTRACT: the old indexer name and factory shape are deleted'
slug: the-old-indexer-shape-is-deleted
spec: a-reconfigure-is-not-an-outage
blockedBy: [every-caller-moves-onto-the-generation-container]
covers: [2, 6, 7]
---

## What to build

The **CONTRACT** batch (`TASKING-PROTOCOL` §3a). No caller remains on the old form, so delete it:

- the `EthereumIndexer` ALIAS (which lives in **`@etherfold/core`**, `src/indexer.ts` — NOT the browser
  package — and is re-exported/read from `browser`, `processor-sqlite` and `server`),
- the old `createIndexerState` factory shape,
- and the browser hook's `stateDiscarded` RE-SEED, which the container makes redundant once the
  direct-state shape is gone.

With the container holding generations and every caller already on it, this is where the landable
completes: one name, one call shape, and no second path by which a reader can hold a stale fold.

**There are no users, so DELETE rather than deprecate.** Do not keep a compatibility re-export, a
shim or a deprecation window for the old name or the old shape, and do not soften the changeset: say
plainly that both are gone.

### The stories this keeps true, and where they are ALREADY asserted

All three landed with earlier tasks in this decomposition. This batch does not re-deliver them. It
keeps their assertions GREEN through the deletion, and RE-HOMES any assertion that lives in a test
file it removes.

- **Story 2** (a processor-only change re-fetches nothing) — asserted at
  `packages/browser/test/reconfigure.test.ts:418` and `packages/browser/test/invalidation.test.ts:177`
  as `expect(chain.ranges.length).toBe(fetchesBefore)`: ZERO, not fewer.
- **Story 6** (a handle held across a pointer move keeps answering) — asserted at
  `packages/core/test/container.test.ts:185` and, on the entities path,
  `packages/browser/test/generationContainer.test.ts:162`, both from the EXPAND batch.
- **Story 7** (a verdict-clean reconfigure costs nothing) — asserted at
  `packages/browser/test/eventRanges.test.ts:97`, landed by
  `the-invalidation-verdict-becomes-a-published-answer`.

### What this batch is NOT, and why it was narrowed

**It is not a behaviour change, and that is deliberate.** An earlier version of this task asked for
"the `stateDiscarded` discard removed and the published verdict acted on". A build STOPPED on that
criterion and was right to: it has no in-fence implementation.

- A verdict-clean reconfigure is ALREADY free. `IndexerGeneration.updateIndexer` discards only when
  `!invalidation.state.valid` (`packages/core/src/indexer.ts:558`), so there is no discard on that
  path left to remove.
- The only reading that WOULD be a behaviour change is "a reconfigure builds a NEW generation over the
  same stream instead of clearing the fold in place". That is the promotion policy's landable, as the
  EXPAND batch already recorded in shipped code (`packages/core/src/container.ts`, `updateProcessor`:
  reaching for it early "would be the outage-shaped in-place discard wearing a container"). Built here
  it would also be unsafe: without the shared-stream follower
  (`a-non-canonical-generation-advances-on-a-shared-stream`) and the policy
  (`the-promotion-policy-moves-the-canonical-pointer`), a successor that is created but neither
  advanced nor promoted leaves the canonical generation answering from a fold the reconfigure just
  invalidated — silent staleness, worse than the discard.

So what lands here is the browser-side RE-SEED deletion only, which is cleanup, not behaviour.

## Acceptance criteria

- [ ] The `EthereumIndexer` alias is deleted; the container name is the only name.
- [ ] The old `createIndexerState` factory shape is deleted; the processor-factory + per-generation
      state-factory shape is the only shape. One name, one call shape.
- [ ] The browser hook's `stateDiscarded` RE-SEED is deleted, because the container owns the discard
      once the direct-state shape is gone (`Indexer.updateIndexer`/`updateProcessor` already drop the
      published handle, and the indirect handle has stable identity). **No behaviour change**: the
      verbs still discard exactly when they discard today.
- [ ] **Story 2 stays green** — ALREADY asserted at `packages/browser/test/reconfigure.test.ts:418`
      and `packages/browser/test/invalidation.test.ts:177` (ZERO re-fetch, not fewer). Keep it
      passing and re-home it if the deletion removes its file. Do NOT write a duplicate: a second test
      asserting what one already asserts is noise, not coverage.
- [ ] **Story 6 stays green** — ALREADY asserted at `packages/core/test/container.test.ts:185` and
      `packages/browser/test/generationContainer.test.ts:162`. Same rule: keep, re-home if needed, do
      not duplicate.
- [ ] **Story 7 stays green** — ALREADY asserted at `packages/browser/test/eventRanges.test.ts:97`
      (the stream digest MOVES while the verdict stays valid, nothing is discarded, nothing below the
      cursor is re-fetched). Same rule.
- [ ] No workspace reference to the old name or old shape remains, in source, tests, examples or docs,
      across ALL FOUR packages that used the class (`core`, `browser`, `processor-sqlite`, `server`) —
      not the browser package alone. If a straggler exists, the migrate batch was incomplete: surface
      that rather than migrating it here.
- [ ] Ship a changeset for every published package whose surface changes (this is the breaking half).
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `every-caller-moves-onto-the-generation-container` — the old form cannot be deleted until no caller
  reads it. This batch's `blockedBy` IS the fan-in that guarantees that.

## Prompt

> Delete the old indexer name, the old factory shape and the `stateDiscarded` discard from the
> `etherfold` monorepo. This is the CONTRACT batch of an expand → migrate → contract refactor: every
> caller has already moved, so nothing should still reference what you are removing.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`), `TASKING-PROTOCOL` §3a,
> and ADR-0034 (which made an append above the cursor free) before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). In
> particular confirm the migrate batch actually landed and that NOTHING still uses the old name or
> shape; if something does, that is drift — surface it rather than migrating it here, because
> discovering a straggler at contract time means the migrate batch was incomplete.
>
> **This batch changes no behaviour, and that is deliberate.** The verbs still discard exactly when
> they discard today. The only `stateDiscarded` work here is deleting the BROWSER HOOK's re-seed,
> which the container makes redundant once the direct-state shape is gone. Read "What this batch is
> NOT" in the task body before touching anything named `stateDiscarded`: an earlier version of this
> task asked for more, a build stopped on it, and the narrowing is the answer.
>
> **Where to look.** The container and the alias are in **`@etherfold/core`** (`src/indexer.ts`), read
> from `core`, `browser`, `processor-sqlite` and `server`. `createIndexerState`'s two accepted shapes
> are browser-side. Also the `stateDiscarded` sites across core and browser, and the entities-path
> handle.
>
> **Easy to get wrong:**
>
> - Re-asserting stories 2, 6 and 7. They are ALREADY asserted, at the file:line sites named in the
>   task body. Keep them green and re-home any that lives in a file you delete; a duplicate test
>   asserts nothing new.
> - Reaching for "a reconfigure builds a new generation instead of discarding". That is the promotion
>   policy's landable and it is unsafe without the follower and the policy. Out of fence here.
> - Keeping the old name or the old shape alive "for compatibility". There are no users: delete them,
>   and say so plainly in the changeset.
>
> **Scope fence.** Do NOT build the promotion policy, pausing, or a running non-canonical generation.
> Do NOT change the read unit of work — it was settled in the expand batch.
>
> Done means: one name, one call shape, the browser re-seed gone, no workspace reference to either old
> form in any of the four packages, and every already-existing story assertion still green.

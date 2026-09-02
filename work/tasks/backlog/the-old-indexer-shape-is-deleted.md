---
title: 'CONTRACT: the old indexer name and factory shape are deleted'
slug: the-old-indexer-shape-is-deleted
spec: a-reconfigure-is-not-an-outage
blockedBy: [every-caller-moves-onto-the-generation-container]
covers: [2, 6]
---

## What to build

The **CONTRACT** batch (`TASKING-PROTOCOL` §3a). No caller remains on the old form, so delete it:

- the `EthereumIndexer` ALIAS,
- the old `createIndexerState` factory shape,
- and the `stateDiscarded` DISCARD that
  `the-invalidation-verdict-becomes-a-published-answer` deliberately left in place so that landable
  could go green on its own.

With the container holding generations and the verdict published and now ACTED ON, this is where the
landable completes and its two stories become true.

### The stories this completes

- **Story 2** — a developer changes the processor without re-fetching a single log, because the filter
  did not move. The digest task makes the stream RESOLVE to the same keyspace; the container is what
  makes the new generation use it. With both landed, this is now assertable end to end.
- **Story 6** — a reader holding a state handle across a pointer move keeps answering from whichever
  generation is now canonical. The indirect handle landed in the expand batch; this is where the old
  direct path stops existing, so holding a reference is never a way to be silently stale.

### The one thing that must not slip

Deleting the discard is a BEHAVIOUR change, and it is the point: a no-op reconfigure becomes
OBSERVABLY free, which is what story 7 was promised in the verdict task and could not demonstrate
until now. Assert it here rather than assuming the earlier task covered it — it explicitly did not.

## Acceptance criteria

- [ ] The `EthereumIndexer` alias is deleted; the container name is the only name.
- [ ] The old `createIndexerState` factory shape is deleted; the processor-factory + per-generation
      state-factory shape is the only shape. One name, one call shape.
- [ ] The `stateDiscarded` discard is removed and the published verdict is what the verbs act on.
- [ ] **A processor-only change re-fetches NOTHING**, asserted on the ranges the node was asked for —
      **zero, not fewer** (story 2). This is the spec's headline assertion.
- [ ] **A handle held across a pointer move keeps answering**, from the newly canonical generation
      (story 6).
- [ ] **A no-op reconfigure is now OBSERVABLY free**, asserted on ranges fetched AND state discarded.
      An event appended above the cursor remains the regression guard.
- [ ] No workspace reference to the old name or old shape remains, in source, tests, examples or docs.
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
> **The behaviour change to assert, not assume.** Removing the discard is what finally makes a no-op
> reconfigure OBSERVABLY free. The verdict task deliberately left the verbs discarding so it could go
> green alone, so nothing has asserted the observable half yet. Assert it here.
>
> **Where to look.** The container and the alias in the browser package; `createIndexerState`'s two
> accepted shapes; the `stateDiscarded` sites across core and browser; the entities-path handle.
>
> **Easy to get wrong:**
>
> - Assuming the earlier verdict task already asserted the free no-op. It explicitly did not — it was
>   additive by design.
> - Weakening the story-2 assertion to "fewer fetches". It is ZERO: the filter did not move, so the
>   stream is reused whole.
>
> **Scope fence.** Do NOT build the promotion policy, pausing, or a running non-canonical generation.
> Do NOT change the read unit of work — it was settled in the expand batch.
>
> Done means: one name, one call shape, no discard, a processor-only change fetches zero ranges, and a
> held handle follows the pointer.

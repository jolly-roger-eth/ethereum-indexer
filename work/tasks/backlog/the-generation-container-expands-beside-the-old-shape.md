---
title: 'EXPAND: the generation container lands beside the old indexer shape, both accepted'
slug: the-generation-container-expands-beside-the-old-shape
spec: a-reconfigure-is-not-an-outage
blockedBy: [the-invalidation-verdict-becomes-a-published-answer]
covers: []
---

## What to build

The **EXPAND** batch of a wide refactor (`TASKING-PROTOCOL` §3a). Add the new container BESIDE the old
shape so nothing breaks yet, and accept BOTH call shapes. Nothing is removed, and the gate stays green
because every existing caller still resolves.

Two non-indirected surfaces change across this landable — an exported CLASS NAME and the
`createIndexerState` signature — at 37 call sites plus five example apps. That is exactly the shape
§3a exists to catch: a linear hard swap of a non-indirected identifier read at that many sites cannot
leave `pnpm -r build` green in isolation. Hence three batches; this is the first.

### What the container is

An indexer holds ANY NUMBER of generations; one is canonical and answers every read. The container is
what holds them. `EthereumIndexer` — one source plus one processor plus one state — is a GENERATION
under this model, NOT the container, so its name means the wrong thing the moment the container
exists. `CONTEXT.md` already promises that rename and nothing else delivers it.

### This batch, precisely

- **Add the new class name as the REAL export, with the old name ALIASED to it.** The alias is what
  keeps the 37 call sites compiling.
- **Accept BOTH the old and the new factory shape.** The new shape passes the PROCESSOR FACTORY rather
  than its result, and takes per-generation state factories, because a container that holds N
  generations cannot be handed one already-constructed processor and one already-constructed store.
- **The indirect handle.** The entities path publishes a handle bound to a store, so a consumer holding
  one across a pointer move would silently read a retired generation. The handle must be INDIRECT,
  resolving to whichever generation is canonical.
- **The READ UNIT OF WORK in the browser is the interval between NOTIFICATIONS.** A pointer move is
  APPLIED AT a notification, so every read between two notifications answers from ONE generation
  without inventing a scope API. `createIndexerState` already returns subscribable stores and already
  pushes updates through the indexer's state callback, so the app already treats a notification as "the
  world moved, re-read". Reuse that; do not add a transaction handle or a timer.

  The residual is stated rather than discovered: a caller reading OUTSIDE any subscription (a one-off
  read in an event handler) gets per-CALL resolution, so two such reads either side of a promotion can
  straddle it. That is tolerable and bounded.

### What this batch does NOT do

It does not migrate any call site, does not delete the alias, and does not remove the `stateDiscarded`
discard. Those are the migrate and contract batches.

## Acceptance criteria

- [ ] The new container class is the REAL export and the old `EthereumIndexer` name is an ALIAS to it.
      Every existing call site still compiles untouched.
- [ ] The factory accepts BOTH the old shape and the new one (processor FACTORY plus per-generation
      state factories). Assert both paths work.
- [ ] The entities-path handle is INDIRECT: a handle held across a pointer move keeps answering, from
      the newly canonical generation (story 6's mechanism, asserted here where it is built).
- [ ] **The read unit of work is the interval between notifications**: assert that reads between two
      notifications all answer from ONE generation, and that a pointer move is applied AT a
      notification. No new scope API, no transaction handle, no timer.
- [ ] **This batch is green on its own**: `pnpm -r build` passes with NO call site migrated.
- [ ] Nothing is removed: the alias, the old factory shape and the current `stateDiscarded` behaviour
      all remain.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `the-invalidation-verdict-becomes-a-published-answer` — the container consumes the published verdict,
  and both edit `IndexerState.ts`, so they are serialised.

## Prompt

> Land the GENERATION CONTAINER beside the existing indexer shape in the `etherfold` monorepo, as the
> EXPAND batch of an expand → migrate → contract refactor. Nothing may be removed and every existing
> caller must still compile.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`), `TASKING-PROTOCOL` §3a
> (the wide-refactor rule this batching comes from), and `CONTEXT.md`'s entries for `indexer`,
> `generation` and `canonical pointer` before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **Domain vocabulary.** A *generation* is a stream plus a fold over it. The *container* is the indexer
> that holds several of them, one of which is canonical. `EthereumIndexer` as it exists today IS a
> generation, not a container, which is why the rename is part of this landable.
>
> **Where to look.** `createIndexerState` and `SyncingState` in the browser package; the
> `EthereumIndexer` class; the entities-path state handle and the store it binds to; the subscribable
> stores (`state`, `syncing`, `status`) and the indexer's state callback, which already define the
> notification boundary you are reusing as the read unit of work.
>
> **Easy to get wrong:**
>
> - Doing a linear hard swap of the class name. It is read at 37 call sites plus five example apps and
>   will not compile in isolation; that is why this is the expand batch and the old name must remain
>   as an alias.
> - Inventing a scope API, a transaction handle or a timer for the read unit of work. The notification
>   boundary already exists — apply the pointer move AT a notification.
> - Leaving the entities handle bound to a concrete store. A consumer holding one across a pointer move
>   would silently read a retired generation.
> - Removing the `stateDiscarded` discard here. That belongs to the contract batch.
>
> **Scope fence.** Do NOT migrate call sites (the migrate batch). Do NOT delete the alias or the old
> factory shape (the contract batch). Do NOT make a non-canonical generation advance or promote.
>
> Done means: the container and the new factory shape exist, the old name and shape still work, and the
> whole workspace builds with no call site touched.

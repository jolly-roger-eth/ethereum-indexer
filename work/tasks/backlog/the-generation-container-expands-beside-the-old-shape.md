---
title: 'EXPAND: the generation container lands beside the old indexer shape, both accepted'
slug: the-generation-container-expands-beside-the-old-shape
spec: a-reconfigure-is-not-an-outage
needsAnswers: true
blockedBy: [the-invalidation-verdict-becomes-a-published-answer]
covers: []
---

## Open questions

1. **What are the two concrete class names, and which one does the retained alias point at?** The
   direction is settled by `CONTEXT.md`: `EthereumIndexer` is "one source plus one processor plus one
   state, which is a GENERATION rather than the container, so that class is renamed when the container
   lands". So the existing class becomes the GENERATION and a NEW class becomes the container. What is
   NOT settled is the two identifiers. This blocks the build because the name propagates through three
   batches and 46 call sites, and two builders on two batches could choose differently.

   Concretely, answer both halves: (a) what is the existing class renamed TO (e.g. `Generation`,
   `IndexerGeneration`)? (b) what is the CONTAINER called (e.g. `EthereumIndexer` reused for it, since
   `CONTEXT.md` says "an indexer holds several generations", or a distinct new name)? Reusing
   `EthereumIndexer` for the container is the reading `CONTEXT.md` most supports, but it silently
   RE-MEANS an exported identifier that 46 sites already construct with generation-shaped arguments,
   so it must be a deliberate choice rather than a default.

## What to build

The **EXPAND** batch of a wide refactor (`TASKING-PROTOCOL` §3a). Add the new container BESIDE the old
shape so nothing breaks yet, and accept BOTH call shapes. Nothing is removed, and the gate stays green
because every existing caller still resolves.

Two non-indirected surfaces change across this landable, and they are DISJOINT — do not merge their
counts, because the migrate batch has to own both lists separately:

- **The exported CLASS NAME**, defined in **`@etherfold/core`** (`src/indexer.ts`), used at ~46 sites
  across `packages/core` (~22), `packages/browser` (~13), `packages/processor-sqlite` (~9) and
  `packages/server` (~2). It is NOT a browser-package symbol, and an earlier draft of this task said
  so wrongly.
- **The `createIndexerState` signature**, which is browser-side: its invocations live in the browser
  package's tests and workload plus the remaining example apps and the docs.

That is exactly the shape §3a exists to catch: a linear hard swap of a non-indirected identifier read
at that many sites, in four packages, cannot leave `pnpm -r build` green in isolation. Hence three
batches; this is the first.

> **Counts are a launch snapshot — DERIVE them.** They post-date
> `retire-the-js-object-processor-path`, which deleted several example apps and the `processorKinds`
> tests, so a number here that no longer matches is expected rather than drift.

### What the container is

An indexer holds ANY NUMBER of generations; one is canonical and answers every read. The container is
what holds them. `EthereumIndexer` — one source plus one processor plus one state — is a GENERATION
under this model, NOT the container, so its name means the wrong thing the moment the container
exists. `CONTEXT.md` already promises that rename and nothing else delivers it.

### This batch, precisely

- **Add the container as a NEW export, and rename the existing class to its generation name, keeping
  the OLD identifier as an alias to the GENERATION.** The alias must point at the GENERATION, not at
  the container — that is the whole correction. `EthereumIndexer` today is constructed as
  `new EthereumIndexer(provider, processor, source, config)` at ~46 sites; aliasing that identifier to
  a CONTAINER would mean "construct a multi-generation container from one already-constructed
  processor", which this very task declares impossible. The alias exists so those 46 sites keep
  compiling unchanged while they still mean a generation.
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

- [ ] The container is a NEW export; the existing class is renamed to its generation name; and the old
      `EthereumIndexer` identifier remains as an ALIAS **to the GENERATION**, so every existing
      construction site still compiles untouched and still means what it meant.
- [ ] **The expand covers the WHOLE non-indirected surface, in every package that reads it** — the
      class is defined in `@etherfold/core`, not the browser package, and is used across `core`,
      `browser`, `processor-sqlite` and `server`. Assert `pnpm -r build` is green with NO call site in
      ANY of those packages touched.
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
> **Where to look.** The `EthereumIndexer` class is in **`@etherfold/core`** (`src/indexer.ts`) — NOT
> the browser package — and is re-exported and constructed from `browser`, `processor-sqlite` and
> `server` too. `createIndexerState` and `SyncingState` are in the browser package. Also: the
> entities-path state handle and the store it binds to; and the subscribable stores (`state`,
> `syncing`, `status`) plus the indexer's state callback, which already define the notification
> boundary you are reusing as the read unit of work.
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

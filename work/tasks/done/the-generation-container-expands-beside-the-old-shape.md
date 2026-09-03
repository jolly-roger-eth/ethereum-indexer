---
title: 'EXPAND: the generation container lands beside the old indexer shape, both accepted'
slug: the-generation-container-expands-beside-the-old-shape
spec: a-reconfigure-is-not-an-outage
blockedBy: [the-invalidation-verdict-becomes-a-published-answer]
covers: []
---

## Answers

1. **The two class names.** The existing class `EthereumIndexer` (one source, one processor, one
   state) is renamed to **`IndexerGeneration`**. The container is **`Indexer`**, a new export. The
   retained `EthereumIndexer` alias points at **`IndexerGeneration`**, never at the container.

   `Indexer` is the container because `CONTEXT.md` already defines that word as the named unit holding
   generations, carrying the caps and the canonical pointer. Reusing `EthereumIndexer` for the
   container was rejected: it contradicts this task's own criterion that the alias means the
   generation, and re-meaning an exported identifier is the silent-change hazard the split exists to
   avoid.

   **No deprecation annotation on the alias.** This library has no users, so the alias is internal
   scaffolding that keeps this batch small, not a compatibility promise. Do not add `@deprecated`,
   migration prose, or consumer-facing notes; the contract batch deletes the alias outright.

   Rejected names, so no later batch reopens this: `EthereumGeneration` (reads as a chain era),
   `EtherfoldIndexer` (near-homograph of `EthereumIndexer`, and both are in scope during expand),
   `IndexerHost` (`host` already means the embedding runtime), `GenerationSet`/`GenerationPool` (drop
   the named, capped, one-canonical-answer meaning). Bare `Generation` was the runner-up, declined
   only to keep the exported identifier unambiguous.

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

## Decisions

- **A generation's factories are supplied PER GENERATION, and its state is built BEFORE its identity is known** (`createState` → `createProcessor(state)`, identity read off `processor.getVersionHash()` afterwards). The obvious shape, `createState(generationId)`, is unbuildable: the fold half of the identity needs the processor, the processor needs its state, and on a reload finding the record would need the hash it is keyed by. Alternatives considered and rejected: a caller-declared version (unwritable on the entity path, where the hash is `${version}-${simple_hash({entities, config})}`), a probe construction over a throwaway store, and a lazily-resolved store handle. Touches: the new call shape the MIGRATE batch moves every site onto, and `the-promotion-policy-moves-the-canonical-pointer`, which creates generations. Recorded as **ADR-0043**.
- **Two new refusals: `CanonicalGenerationNotHeldError` and `UnheldGenerationError`.** A registry whose canonical pointer names a generation this container has no spec for is refused at open, rather than silently promoting the one that was built (a pointer move nobody asked for) or answering reads from a non-canonical generation. Touches: the promotion-policy and shared-stream-follower tasks, which own resuming several generations across a restart.
- **New exported reference substrate in core (`createMemoryGenerationRegistryPort` / `openMemoryGenerationRegistry`).** Mirrors `MemoryStateStore` at the storage seam; it reports no stream subtrees because it stores none. Alternative was leaving the port with one real implementation and hand-rolling a memory port in every test. Touches: `@etherfold/core`'s public surface and the browser default below.
- **USER-VISIBLE DEFAULT: `createIndexerState`'s container shape defaults its registry to a MEMORY one under `BROWSER_GENERATION_CAPS`.** This hook knows no indexer NAME, and a durable registry is addressed under one, so defaulting to IndexedDB would have meant inventing a discriminator the stream address already carries; requiring a registry would have put a mandatory new argument on every site the migrate batch moves. Consequence, documented at the option: with the memory default the unregistered-subtree sweep has nothing to see, so an app that wants durable generations (and the sweep) passes `openGenerationRegistryOnIndexedDB(name, {dropState})`. Touches: `every-caller-moves-onto-the-generation-container` and `the-server-and-cli-hold-generations-too`.
- **The pointer is applied at a STATE notification only, not at a cursor (`onLastSyncUpdated`) one**, and the container publishes the INDIRECT handle to `onStateUpdated` rather than the value the generation produced — so a subscriber that keeps what it was handed keeps something that follows the pointer. Touches nothing outside the container, but it is what `the-old-indexer-shape-is-deleted` re-asserts.
- **`updateProcessor` / `updateIndexer` still reconfigure the canonical generation IN PLACE** (no behaviour change, per the scope fence), but the container now re-points its held entry's processor and drops its last published state on a discard, so the indirect handle cannot answer from a fold that was replaced. The registry record still names the fold the generation was registered with; closing that drift is the promotion policy's job, and it is flagged in the JSDoc.
- **Widened the CLI's source-text guard (`packages/cli/test/engine.test.ts`) to match `IndexerGeneration` as well as `EthereumIndexer`.** Not a call-site migration: the rename would otherwise have left that guard green and VACUOUS for the whole expand→contract window, since a CLI file could import the engine under its new name unnoticed. Verified it still bites (a probe file importing/constructing `IndexerGeneration` reds both cases). Deliberately NOT extended to `Indexer`, the container, because whether a CLI holds generations is `the-server-and-cli-hold-generations-too`'s question. Touches: the MIGRATE batch's item (c), which now finds this partly done and should still re-derive it.
- **The hook exposes no promotion surface.** Story 6 is asserted against the container directly (with real `EntityEventProcessor`s and stores) rather than by adding `generations`/`promote` to `createIndexerState`'s return, which would be surface no caller in this batch needs and which the promotion-policy task is better placed to shape. Touches: task 9, if it wants a hook-level promotion verb.

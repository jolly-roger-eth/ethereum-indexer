---
title: 'A reconfigure in the BROWSER is not a blank app: the live generation serves while its successor catches up'
slug: a-reconfigure-is-not-an-outage
taskedAfter: [appending-to-the-stream-costs-the-batch]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **The design record is `work/notes/ideas/stream-grafting-what-we-established.md`.** It carries the
> invariants this spec rests on (reorg bounds, why segments are immutable, why block ranges overlap,
> the key-collision-across-chains hazard), the options that were weighed and rejected, and why the
> unit is called a **generation** rather than a version, a deployment or a candidate. This spec
> states ONE design and does not re-argue it; a reader asking "why not X?" should go there.
>
> The promotion cost, which was that record's open question, is now measured:
> `work/notes/findings/promotion-cost-of-a-two-label-stream.md`.

> **SCOPE: the BROWSER runtime and the core engine. Nothing else.** The CLI never reconfigures (it is
> a one-shot `indexToTip` batch with zero `updateProcessor`/`updateIndexer` call sites, and its
> `serve` verb lazily imports the platform server), so it has no long-running drive to hang a
> promotion on. The ingest server has a real outage with a real mechanism and its own spec,
> `work/specs/proposed/an-ingest-server-reconfigure-is-not-a-blackout.md`.

## Problem Statement

An indexer has exactly one state, and reconfiguring mutates it in place. When ADR-0034 says a change
"discards the state and re-indexes from block 0", it means the running indexer has nothing to answer
with until it has caught up. In a browser that is a blank app: the UI reading the store sees it
emptied and refilled. The developer's only lever is to not reconfigure.

ADR-0033 and ADR-0034 shrank how OFTEN this happens. They did not change what happens when it does,
and the remaining cases are the ones that matter: a new event below the cursor, a changed address, a
new contract, and a processor upgrade.

The mechanism is not more invalidation cleverness. It is that **an indexer should hold more than one
generation at a time**: a new generation syncs alongside the old one and the canonical pointer moves
when it is ready.

## Solution

An indexer holds up to **two** generations: the LIVE one, which answers every read, and at most one
SUCCESSOR, which is catching up and answers nobody.

- Reconfiguring creates a successor instead of mutating the live generation.
- The successor builds its own state, re-folding from the stream and re-fetching only what its
  source needs and the stream does not already hold.
- Reads are served by the live generation throughout.
- **Promotion** makes the successor live. It is a policy knob whose axis is the ENVIRONMENT:
  automatic on catch-up (the browser default, and what a developer iterating on a processor wants,
  since hand-promoting after every edit would be absurd) or manual.
- Reconfiguring again while one is pending REPLACES the successor. Two, never three.

## The stream is ONE stream with TWO LABELS

This is the whole storage design, and everything else follows from it.

A stream is not split, branched or copied. Every stream entry carries a generation label, `live` or
`staging`, **in its KEY**. There is one stream per `(name, chainId)`, exactly as today.

```
live entries       stream_<name>_<chainId>_live_<seq>
staging entries    stream_<name>_<chainId>_staging_<seq>

staging reads      gen = staging OR (gen = live AND seq <= N)
promotion          delete  gen = live AND seq > N
                   rename  gen = staging  ->  gen = live
```

**`N` is a segment SEQUENCE, not a block, and it is FIXED when the successor is created.** It is the
highest live segment whose embedded `lastSync.lastToBlock` is below the `invalidFromBlock` the
verdict reported: the graft point rounded DOWN to a segment boundary. Nothing new has to be recorded
to compute it, because every segment already carries the `lastSync` current when it was written,
which is an atomic snapshot of the scanned extent at that boundary.

**Each generation writes only under its OWN label, so there are two writers over one keyspace and
their key sets are disjoint.** Neither can clobber the other, and no coordination rule is needed to
say so. The live generation keeps appending `live` segments the whole time; the successor appends
`staging` segments; the live entries at or below `N`, which both read, are immutable because nothing
in this system ever rewrites a segment.

**Staging numbers its segments from `N + 1`.** It can, because the label already separates the two
key spaces. So promotion is a rename that keeps the sequence number, and the promoted stream is
contiguous `0..K` with no hole — which matters, because `appending-to-the-stream-costs-the-batch`
refuses a gap in the ordinals as a lost fragment.

**Relabelling on promotion is what stops a chain forming.** After promotion every entry is simply
`live`, with no record of which generation wrote it, so there is never a second level to accumulate
across successive reconfigures. Exactly two labels, forever. This is the property that makes the
label model beat sharing a prefix by reference between two streams, and it is why there is no
lifetime rule, no reference counting and no reclamation problem in this design.

**The label is in the KEY because of a measurement, not a preference.**
`work/notes/findings/promotion-cost-of-a-two-label-stream.md` has the numbers. On the filesystem a
key-label promotion is a rename per segment and moves no payload at all (tens of milliseconds over a
136 MB stream); a value-label promotion rewrites every staging entry (seconds over the same stream).
On IndexedDB, which has no rename, the two cost the SAME, so IndexedDB does not decide the question
and the filesystem does. A value label additionally cannot be found without reading the values it is
in, so it needs a separate boundary pointer — a second source of truth that can disagree with the
entries, which is the objection `appending-to-the-stream-costs-the-batch` already raised against a
head pointer for enumeration.

## Identity, which is not digest equality

Identity is the invalidation **VERDICT** plus the `processor` hash: a new generation is needed
exactly when `sourceInvalidationOf` says something already indexed became invalid, or when the
processor hash moved.

Digest-set equality is the wrong test twice over, and both are load-bearing:

- `sourceInvalidationOf` deliberately ignores an added entry whose `startBlock` is above
  `lastToBlock`, so appending an event above the cursor is FREE today. Digest equality would spin up
  a successor and a full re-fold for precisely the case ADR-0034 made free.
- The digest set is not stable for a fixed state: on the kept-state path the core REWRITES
  `lastSync.context.source` to the new hashes, so one unchanged state legitimately carries two digest
  sets over time.

`config` is deliberately NOT in that list. `sourceInvalidationOf` compares `context.config` against
the stream config hash FIRST and returns both halves invalid on a mismatch, so config is already
INSIDE the verdict; listing it again would be a redundant second comparison. Only `processor` is
genuinely outside, because `sourceInvalidationOf` never reads `context.processor`.

Note that `simple_hash` is a 32-bit non-cryptographic hash. As a change DETECTOR a collision costs
one missed invalidation; as an IDENTITY it would silently adopt another generation's state. Resting
identity on the verdict rather than on hash equality keeps that exposure where it already is.

A changed processor hash makes a generation, so all three reconfigure entry points route through
this: `updateProcessor` creates a successor instead of clearing and reloading, `updateIndexer` does
the same on a source verdict, and `reset` stays what it is — an explicit unconditional discard,
because it is the one verb whose caller MEANS discard.

## User Stories

1. As a browser user, I want the app to keep rendering while a new generation builds, instead of
   going blank, and to switch when it is ready.
2. As a browser developer, I want to change the source OR the processor without blanking my app.
3. As a browser developer, I want to turn the auto-switch off and show catch-up progress instead.
4. As an app author, I want to know that a successor exists and how far it has caught up, so I
   decide whether to render, dim or hide the live state — since only I know whether my reconfigure
   made the old answers wrong or merely incomplete.
5. As a reader holding a state handle across a promotion ON THE ENTITIES PATH, I want it to keep
   answering from the generation that is now live, so holding a reference is never a way to be
   silently stale. (On the js-object path the published value is a plain object replaced wholesale,
   so a holder of the OLD reference is stale exactly as it is today; unchanged by this spec and not
   regressed by it.)
6. As a developer, I want a reconfigure the invalidation verdict calls a no-op to cost nothing.
7. As a developer reconfiguring twice, I want the second to replace the first successor.
8. As a developer, I want a generation whose stream is unavailable to fall back to a full re-index,
   which is today's behaviour, so the feature degrades rather than breaks.
9. As a developer iterating on a processor, I want promotion to happen automatically, rather than
   hand-promoting after every edit.
10. As a developer, I want a successor that never re-fetches history the stream already holds, so
    the common reconfigure costs a re-fold rather than a backfill.
11. As a developer, I want promotion itself to be cheap enough that it is not a second stall at the
    end of a catch-up I just waited through.

## Implementation Decisions

**Two generations, not N.** `StateStore` offers `revertTo(keepUpTo)` and capability-gated `asOf` and
NO fork verb, and `revertTo` is destructive (versions opened above the point are gone, versions the
dead branch closed become live again), so it cannot produce a branch without destroying the original.
Each generation materialises its own state by re-folding, at one full state each. Two covers the
reconfigure case; N buys rollback and A/B at N times the state storage and can be added later
without redesign.

**The successor is an ordinary `EthereumIndexer` over a staging view. One mechanism, not two.** Its
view's `fetchFrom` serves the live entries at or below `N` followed by its own staging entries; its
`saveNewEvents` appends staging entries. That `EthereumIndexer` calls `saveNewEvents` UNCONDITIONALLY
on every save is therefore not an obstacle to work around: writing is the successor's normal path,
and it writes to a label nobody else touches.

The three sharing cases are then not three mechanisms but three values of `N`, and which one applies
is decided by the verdict rather than chosen:

- **whole-stream** — a processor-only or decode-only change. The topic set is unchanged, so every log
  the successor needs is already stored and nothing below the cursor is invalid: `N` is the live tail
  at creation. The successor re-fetches NO history; it re-folds the whole stream and then follows the
  head itself. This is the most common case by far, since an ABI is regenerated far more often than
  it is meaningfully changed.
- **partial graft** — an event added or edited below the cursor. `N` is the last segment boundary
  beneath `invalidFromBlock`; the successor re-fetches from that boundary's `lastToBlock` upward.
  Bounded by how far back the boundary sits, not by the length of the history.
- **no sharing** — a changed address or a new contract. These land in the block-0 skeleton entry, so
  `invalidFromBlock` is 0, `N` selects no live entries, and the successor backfills the whole history
  into staging. The rare case, and the only one that genuinely pays twice.
- An event added ABOVE the cursor creates no generation at all: `sourceInvalidationOf` already calls
  it free.

**The doubled fetch is the head-following TAIL, never the history, and it is accepted.** Because `N`
is fixed at creation, the successor fetches every block above its graft boundary itself, which in the
whole-stream case is the tail accumulated since the reconfigure. Both generations therefore ask the
node for the head range while a successor is catching up. The alternative — driving the successor's
fold from the live generation's appends so it fetches literally nothing — is a SECOND successor
mechanism to build, test and reason about, bought with a saving on the one range that is bounded by
catch-up duration rather than by history. One mechanism is worth more than that saving.

**No finality clamp on the graft point, because the successor derives its own reorgs.** The successor
starts from segment `N`'s embedded `lastSync`, and `getFromBlock` returns
`max(min(lastToBlock + 1, latestBlock - finality), 0)`, so its FIRST round re-scans back to the reorg
window as it stood at that snapshot. A reorg that struck at or below `N` after the segment was
written is therefore re-derived by the successor from the node, not inherited. Below
`latestBlock - finality` no reorg can reach at all, so there is nothing left to protect against and
no clamp to apply.

The `unconfirmedBlocks` frozen inside segment `N` is stale, because nothing rewrites a segment. That
errs in the SAFE direction: it makes the successor's reorg search window too WIDE, never too narrow,
and it self-prunes on the successor's first save.

**Reorgs are handled per generation, independently.** Above their respective graft points each
generation follows the head and processes reorgs itself; they may briefly disagree, each is
internally consistent, and both converge. There is nothing to disagree about below, by the argument
above.

**No filter or lineage provenance is needed, and the graft point is why.** A stream is
decode-neutral but not filter-neutral: the absence of a log means something only against the filter
its range was fetched under. But the graft point is the block at which the two sources first differ,
so BELOW it the two generations want identical filters BY CONSTRUCTION, and a live entry at or below
`N` was fetched under exactly the filter its new reader would have used. Above `N` nothing is shared:
the successor fetches that range itself. So provenance is unnecessary in both directions rather than
merely deferred, and the `ExistingStream` CONTRACT — `fetchFrom`, `saveNewEvents`, `clear` — is
unchanged by this spec. `the-stream-stores-only-what-the-node-said` is therefore the only sibling
touching that seam, and the two dependents of the storage spec do not contend.

**Prerequisite: `appending-to-the-stream-costs-the-batch`, for three things it delivers.** Segments,
so a graft point can be a boundary at all; the `lastSync` embedded in every segment, which is what
makes `N` computable with no new metadata; and immutability plus independent readability, which is
what lets a successor read the live entries at or below `N` while the live generation appends above
them. It also delivers the append-cost fix, without which a successor's backfill and a live
generation's appends would each be quadratic.

**What is shared and what is not.** Two different stores, easily conflated:

- the **stream** is one store holding both generations' entries under different labels. Each
  generation reads what its predicate selects and writes only its own label.
- the **state store** CANNOT be shared, ever. It is the materialised fold, two generations have
  different folds by definition, and `StateStore` has no fork verb. Each generation materialises its
  own.

**`createIndexerState` stops EAGERLY INVOKING the processor factory that already exists, and gains a
per-generation factory for the state-holding resource.** The processor factory is NOT a new concept
and must not be re-invented: `fromJSProcessor(def)` returns `() => JSObjectEventProcessor` and
`fromEntityProcessor(def, options)` returns `(store: StateStore) => EntityEventProcessor`, and every
example already exports one as `createProcessor`. What apps do today is invoke it AT THE CALL SITE
and hand in the result (`fromJSProcessor(processor)()`, `fromEntityProcessor(tokenProcessor)(store)`),
so `createIndexerState` receives an already-bound instance and cannot build a second one.

The change is to pass the factory rather than its result, and to make the STATE-HOLDING resource
differ per generation:

- **entities**: `processor: (store) => Processor` unchanged, plus `storeFactory: (generation) => StateStore`.
- **js-object**: `processor: () => Processor` unchanged, plus `keepStateFactory: (generation) => KeepState`.

The generation argument belongs on the STATE factory and is load-bearing there: the store name must
be both STABLE across sessions (or a reload finds no data) and DISTINCT per generation (two
IndexedDB stores sharing a `databaseName` are one store by that store's own documentation, so a
successor would fold into the live generation's rows). Deriving it from the generation satisfies both
at once.

**A keeper cannot derive its own generation, which is why the container passes it.** Identity is the
invalidation verdict, and `sourceInvalidationOf` needs the STORED `ContextIdentifier`, which a keeper
is never handed — it sees only the CURRENT context. And `ProcessorContext` is not that triple: its
`config` is the PROCESSOR config, whereas `ContextIdentifier.config` is the `streamConfigHash`, so
the stream config is absent entirely and an `updateIndexer` changing only `streamConfig` would
produce a live generation and a successor with byte-identical `ProcessorContext`, colliding on one
key. That is the clobber
`work/notes/observations/keepstate-storage-id-omits-the-processor-version.md` warns about.

**`keepStream` stays ONE injected instance; the generation label is a parameter of the view.** The
container mints a live view and, when there is a successor, a staging view bounded at `N`, both over
the same keys. There is no generation-keyed stream name and no second stream to reclaim. `clear` on a
view removes that generation's entries; `reset` clears the whole stream, both labels, and is the only
path that does.

**Promotion is a step, not a blend.** The cursor jumps. Interpolating would serve a state neither
generation ever had. Promotion transfers nothing but the label: the newly-live generation continues
appending to the same stream, at the sequence its staging entries already occupy.

**`reset` also drops the successor.** It is the one verb whose caller means discard, so it discards
both generations and clears the stream. It must not run while a successor is mid-fold over entries it
would delete.

**A container owns the live-plus-successor pair.** `EthereumIndexer` holds exactly one processor, one
`lastSync` and one stream view, so it cannot hold both. A successor is a full second stack (its own
`EthereumIndexer`, processor and state store), and the container is what `createIndexerState`
returns: it holds the pair, publishes the indirect handle, owns promotion, and is what `SyncingState`
describes. `promote` is a method on that container, reached as a UI action, and there is exactly one
home for it.

**Reads do NOT carry generation identity, and the handle FOLLOWS promotion.** Per-read provenance
would be a breaking change to the four `StateStore` verbs, four backends and the conformance suite,
and it is REJECTED. The identity necessarily exists internally, because promotion cannot work without
the indexer knowing which generation is live, so exposing it later is purely additive and a query
layer is its natural home. What remains is not provenance but LIFETIME: the entities path publishes a
handle bound to a store, so a consumer holding one across a promotion would silently keep reading the
retired generation. The handle is therefore INDIRECT, a reference to whichever generation is live, so
promotion is transparent to every holder and the staleness class disappears instead of being made
detectable.

**The live generation KEEPS INDEXING while a successor catches up.** It is not "superseded" —
supersession is precisely the decision promotion has not yet made, and marking it so would be false
outright if the developer inspects the successor and rejects it.

Freezing it instead looks free and is not: an indexer that stops carries an UNCONFIRMED window of
blocks it has processed that are not yet final, and if one is reorged away it never finds out,
because it has retired the machinery that would have discovered it. Freezing safely would mean
`revertTo(finalisedHead)` first, which discards exactly the recent data a UI is showing.

Discarding immediately — today's behaviour — makes the INDEXER decide something only the APP knows.
Whether the old data is misleading depends entirely on WHY the reconfigure happened: after a
processor bug fix the old state is WRONG, after an added event it is merely INCOMPLETE, after a
renamed parameter it is FINE. `sourceInvalidationOf` can say what moved, never whether the old
answers are now lies. So the live state keeps being served and the consumer is told a successor
exists and how far it has caught up; the app renders, dims, banners or hides, because the app author
is the only party who knows which case they are in.

That signal is not a second thing to publish: catch-up progress and the existence of a successor are
the SAME fact, so it collapses into the `successor` block below and there is no flag on the live
generation at all.

**`SyncingState` grows an optional `successor` block, and the live fields stay flat.** Nesting both
under `live` and `successor` is a category error: the record mixes provider-level facts
(`waitingForProvider`), policy (`autoIndexing`) and per-generation facts (`lastSync`, `catchingUp`,
`fetchingLogs`, `processingFetchedLogs`, `loading`, `numRequests`), so a uniform nesting would assert
that the provider is per-generation, which is false. Leaving the live fields flat also means no
existing consumer changes, and the common case (no successor) is expressed as absence.
`syncPercentage` already rides on `lastSync`, so a successor's progress comes along inside its own
`lastSync` rather than needing a new field.

**An error is reported on every generation it actually breaks.** The successor carries its own
`error`. A successor-only failure (a processor that throws on replay, a decode error while
backfilling) sets `successor.error` alone, which is exactly the signal a developer needs before
promoting. A shared failure (the provider is down, and both generations use the same provider) breaks
both and is reported on both, which is accurate rather than duplicated; a consumer wanting to say it
once can compare the existing `id: ErrorCode`. No `scope` field is added, because two ids already
disambiguate what one would.

**`ReconfigureOutcome.stateDiscarded` is a published API this design falsifies, and it is owned
here.** Under a successor neither `updateIndexer` nor `updateProcessor` discards anything: the live
generation keeps its state throughout, so the flag collapses to a per-verb constant — `reset` always
discards, the two update verbs never do — and stops distinguishing the thing it was added to
distinguish. That is a DELETION SWEEP, not a detail: the reconfigure outcome must grow a shape that
says what actually happened (a successor was created, the verdict was a no-op, or `reset` discarded),
and every reference must be migrated by the task that changes it. There are **36** across three
trees: `packages/core` (11), `packages/browser` (23) and `examples/browser-reference` (2). A spec
that left this unnamed would have the first task to trip over it rewrite the corpus by guess.

## Testing Decisions

- **Not-an-outage is the claim, so assert on READS during catch-up**, not on the end state: reads
  succeed continuously across a reconfigure and answer from the live generation's state until
  promotion. Assert on the ANSWERS, since reads do not report identity.
- **The no-op claim** asserts on ranges fetched AND on state discarded, the pair ADR-0034
  established, since neither alone separates a resume from a rebuild.
- **Identity**: an event appended above the cursor does NOT create a successor, which is the
  regression guard for ADR-0034's headline.
- **A successor never writes a `live` key**, asserted at the write seam across a whole catch-up.
  This is the two-writer guard, and under the key label it is checkable by key inspection alone.
- **The live generation's entries at or below `N` are byte-identical** before and after a catch-up,
  which is the immutability half of the same guard.
- **A whole-stream reconfigure re-fetches NO history**: asserted on the ranges the node was asked
  for, which must all lie above the graft boundary's `lastToBlock`. This is the sharing test and it
  is the most common reconfigure.
- **A partial graft re-fetches only above its boundary**, asserted on the ranges the node was asked
  for, with `N` landing on the last segment boundary BENEATH `invalidFromBlock` and never above it.
- **Promotion leaves ONE contiguous live generation**: after promoting, every key is `live`, the
  sequence numbers are contiguous from 0, no `staging` key survives, and the superseded live entries
  above `N` are gone.
- **A replay after promotion equals a replay before it**, for the range both cover: promotion changes
  labels, never event order or content.
- **Promotion costs no payload rewrite on the filesystem**, asserted as WORK at the same instrumented
  write seam `appending-to-the-stream-costs-the-batch` establishes: a promotion issues renames and
  deletes and writes no segment bytes. Wall-clock would be flaky on a loaded machine (ADR-0032).
- **A reorg during catch-up** is derived independently by each generation, from its own first-round
  re-scan, and both converge. Includes the case where the reorg strikes at or below `N` after the
  successor was created, which the successor must find from the node rather than inherit.
- **Replacement**: reconfiguring twice leaves exactly two generations, and the first successor's
  staging entries and state store are reclaimed. Nothing at or below `N` is reclaimed, and no `live`
  key is touched.
- **A handle held across a promotion** keeps answering and answers from the newly-live generation,
  the regression guard for the silent staleness the indirect handle removes.
- **The reconfigure outcome** says what happened under a successor, and every existing reference to
  `stateDiscarded` is migrated rather than left inverted.
- **The live generation keeps advancing** while a successor is pending: its cursor moves and it
  processes a reorg in its own unconfirmed window. The regression guard against freezing it and
  stranding a tail it could never correct.
- **A successor's progress is visible** while one is pending and stops being reported at promotion.
- **A successor-only failure** sets `successor.error` while the top-level one stays clear; a shared
  provider failure sets BOTH, carrying the same `ErrorCode`.
- **The state factory is called per generation** on BOTH paths, and a successor's state is distinct
  from the live one's: a write to one is not visible in the other, the guard against the
  same-`databaseName` collision. The name is also STABLE across a reload for the same generation.
- **A `streamConfig`-only change** produces a live generation and a successor that do NOT collide,
  the regression guard for the `ProcessorContext` hole: that context cannot distinguish them, so the
  generation must come from the container.
- **`reset` clears both labels** and leaves no staging entry behind to be replayed into a rebuild.
- **Enumeration does not cross chains**, inherited from the prerequisite and re-asserted here because
  the label adds a key component: two streams sharing a name on chains `1` and `10`, where promoting
  one leaves the other intact.
- **Round-trip through BOTH keepers**, since they are independent implementations of one contract.

## Tasking note

This cuts into FIVE separable landables, which a tasker should follow rather than treating it as one
body of work. Cutting them together would produce one task nobody can review.

1. **The labelled stream.** The key layout, the graft-bounded staging read, and promotion as rename
   plus delete, in the shared segmentation helper the prerequisite establishes plus both keepers. It
   is buildable and testable on its own (write both labels, read with a bound, promote, assert one
   contiguous live generation) and it is the piece the spike measured. Everything else depends on it.
2. **The generation container plus promotion** — the live/successor pair, the indirect handle, the
   promotion policy knob. The core of the spec.
3. **The `createIndexerState` factory migration** — `storeFactory`, `keepStateFactory`, and passing
   the processor factory instead of its result. BREAKING and mostly mechanical. The footprint is
   larger than it looks and must be owned by the batch that changes the signature: **40 call sites**
   outside `dist/`, of which **31 are under `packages/browser/test/`** (`dispose` 3,
   `invalidation` 2, `liveReload` 8, `processorKinds` 10, `reconfigure` 2, `setupIndexing` 2,
   `txInclusion` 4), plus `packages/browser/browser/workload.ts`, plus **FIVE** example apps
   (`web-demo`, `event-processor-nfts`, `browser-reference`, `basic`, `mud`) and the README usage
   block. The examples and the README are the PUBLIC face of the change.
4. **The `stateDiscarded` deletion sweep** — 36 references across `packages/core`,
   `packages/browser` and `examples/browser-reference`.
5. **`SyncingState` growing its `successor` block.**

(3) and (4) are migrations with a large file footprint and little judgement; (1), (2) and (5) carry
the design.

One existing test reaches into the stream key directly and the label breaks it:
`packages/browser/test/invalidation.test.ts` does `get(stream_<tag>_<chainId>)` and rewrites
`lastSync` in place. The prerequisite already renames it into a segment; this spec adds the label.
Name it in the task that lands (1) so it is updated deliberately rather than patched blind.

## Out of Scope

- **N generations**, rollback, A/B. Reachable later at linear storage cost.
- **Sharing state between generations.** Not available; each re-folds.
- **Smoothing the promotion step.**
- **Driving the successor's fold from the live generation's appends** to remove the doubled tail
  fetch. A named, deliberately-declined optimisation: it is a second successor mechanism bought with
  a saving bounded by catch-up duration.
- **Pruning or retention of segments within a live generation.** Genuinely unowned and not needed
  here: reclaiming a retired successor means deleting its `staging` entries, which is a delete by
  label, not a retention policy over a generation that is still being read.
- **Exposing which generation answered a read.** Purely additive later; a query layer is its home.
- **The ingest server**, which is `an-ingest-server-reconfigure-is-not-a-blackout`.

## Further Notes

Came out of a design conversation about stream branching
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`), which framed the same mechanism
from the storage end, and settled in `work/notes/ideas/stream-grafting-what-we-established.md`.

The Graph is the closest prior art and was drawn on deliberately: grafting is a graft point, a
successor is a pending deployment, promotion is the canonical pointer moving, and the stable URL is
the indirection hiding the switch. This differs in having to work in a browser with no URL and no
operator. The word **generation** is taken from it too, which also avoids the `version` collision
recorded in the design record.

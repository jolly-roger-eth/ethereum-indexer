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
promotion          delete the superseded live entries, relabel staging to live
                   (journalled and per-sequence -- see below, the naive form loses data)
```

**Promotion is a multi-key mutation that cannot be atomic on either keeper, so it is JOURNALLED and
ORDERED.** A single `promoting` marker record is written before any key is touched and deleted only
once the promotion has completed.

```
promotion   0. write   marker {graftAt: N, throughSeq: K}   // K = highest staging seq
            1. for s in N+1..K:  delete live_s if staging_s exists; rename staging_s -> live_s
            2. delete  gen = live AND seq > K
            3. delete  marker
```

**Recovery is PER-SEQUENCE, and the marker must carry `K` for that to be possible.** The obvious
formulation — delete every live entry above `N`, then rename everything staging — is NOT re-runnable,
and the way it fails is silent and deterministic rather than unlucky. Once step 1 has promoted even
one entry, that entry is INDISTINGUISHABLE from an old live one, because relabelling deliberately
leaves no record of which generation wrote it (that is the property that stops a chain forming). So a
recovery that re-issued a blanket "delete live above `N`" would delete the entries it had just
promoted, and they no longer exist under `staging` to promote again. A crash after the renames but
before the marker is deleted would wipe the whole promoted stream above `N`, leaving live `0..N`
under a state store folded to `K`: state ahead of stream, which is the silent-history condition this
set refuses everywhere else.

The per-sequence form is genuinely idempotent, and the test is presence of `staging_s`. If it exists,
that sequence has not been promoted yet, so delete `live_s` (absent is a no-op) and rename. If it does
not, that sequence is already promoted, so skip it. Then delete live above `K`, which removes any old
live entries the retired generation had beyond the promoted range. Re-running the whole thing any
number of times reaches the same state.

**The marker has a LIFETIME, and a stale one is dangerous.** It is not a segment and does not match
the anchored segment pattern, so nothing sweeps it by accident:

- every path that clears the stream deletes the marker in the same operation — `ExistingStream.clear`
  and `reset` both — because a marker outliving the stream it describes would, on the next load,
  delete live entries above a graft point belonging to a stream that no longer exists;
- a load finding a marker whose `graftAt`/`throughSeq` do not correspond to anything present
  DISCARDS THE MARKER rather than acting on it, and says so through the logger. The marker is a
  journal of an operation, so a journal referring to nothing is spent, not a command.

**The marker exists because BOTH LABELS PRESENT is the ORDINARY state of a pending successor, not a
signal of anything.** A browser tab reloads mid-catch-up constantly — story 9 is a developer
iterating on a processor — so a rule that read both labels as an interrupted promotion would promote
a half-folded successor on every refresh, which is precisely the rewind this spec exists to prevent.
The marker is what distinguishes the two, and its ABSENCE is the common case.

On load: marker present means re-run the promotion from step 1 in the per-sequence form above, which
is idempotent for the reason given there — the presence of `staging_s` says whether that sequence has
been promoted yet. Marker absent with both labels present means a pending successor; resume it.

**This is a JOURNAL, not the head pointer `appending-to-the-stream-costs-the-batch` rejected**, and
the distinction is worth stating because the shapes rhyme. A head pointer is consulted on every READ
to determine the stream's structure, so it is a second source of truth that can disagree with the
segments. The marker is consulted only at LOAD, describes an OPERATION rather than a structure, is
absent in the steady state, and is never TRUSTED about what exists — recovery tests for each
`staging_s` and acts on what it finds, which is why a marker referring to nothing can simply be
discarded instead of believed. It is also written once per PROMOTION, not per save, so it does not
touch the one-write-per-save rule.

**Within each sequence, delete before rename.** Doing the rename first would leave the promoted entry
on top of the old live one at the same sequence, which on a keyed store is either a collision or a
silent overwrite of the entry the delete was supposed to remove deliberately. Deleting first also
means a crash between the two leaves a one-segment hole, which the prerequisite's contiguity rule
handles by clearing from the gap upward and KEEPING the prefix — and staging still holds that
sequence, so recovery promotes it.

**A successor RESUMES across a reload rather than being dropped.** It has to: the no-sharing case is
a full backfill, and discarding it on a refresh would make the feature useless in the browser it is
for. Two consequences to build deliberately: the generation-derived state store name must be stable
across sessions (which the state factory already requires), and the do-not-append-to-`N` seal is
re-derived on load from the presence of staging rather than held in memory.

**`N` is a segment SEQUENCE, not a block; it is FIXED when the successor is created; and it is always
a SEALED segment.** It is the highest SEALED live segment whose embedded `lastSync.lastToBlock` is
below the `invalidFromBlock` the STREAM verdict reported: the graft point rounded DOWN to a sealed
boundary. Nothing new has to be recorded to compute it, because every segment already carries the
`lastSync` current when it was written, which is an atomic snapshot of the scanned extent at that
boundary.

**Sealed is not a detail, it is what makes the shared prefix stable.** The OPEN tail is rewritten on
every save — that is exactly how the prerequisite makes an append cost the batch — so a graft point
landing on the tail would share a segment that keeps growing underneath the successor. Two things
would then break at promotion: the live tail would carry events appended AFTER the graft point that
promotion is supposed to drop, and the successor would have re-fetched that same range into its own
staging segments, so the promoted stream would hold both copies and a replay would double-fold them.
Sealed segments are immutable, so restricting `N` to one removes the whole class.

**Creating a successor SEALS the live tail, which costs no write.** A segment is sealed exactly when
it stops being the highest ordinal, so "seal the tail" means the live generation's next save opens a
new segment rather than appending to the old one. Nothing is written to seal it.

Sealing the tail is what makes the WHOLE-STREAM case's `N` available immediately: there, the stream
verdict is wholly valid, so the bound is "as high as possible" and `N` is the segment that was open
at creation, just sealed. In the PARTIAL-GRAFT case `N` is lower — the highest sealed segment beneath
`invalidFromBlock` — and it was already sealed, so the seal is merely harmless there. Do not read
"`N` is the segment that was open at creation" as the general rule: applied to a partial graft it
would share a prefix the GROWN filter invalidates, and drop events silently.

(A stream with no sealed segment at all yet has no `N`, so the successor backfills — the same path as
the no-sharing case, and correct, since there is nothing to reuse.)

**`N` comes from the STREAM verdict; the STATE verdict decides only that a successor is NEEDED.**
`sourceInvalidationOf` returns TWO verdicts, `{state, stream}`, each with its own
`invalidFromBlock`, and they answer different questions: `hash` covers the DECODING shape while
`streamHash` is what the FILTER is built from. Conflating them mis-files the most valuable case. A
decode-only change — a renamed non-indexed parameter — moves `hash` but not `streamHash`, so the
STATE is invalid from that block while the STREAM stays wholly valid. Read from the state half it
would force a backfill from that block; read from the stream half it is whole-stream sharing with no
re-fetch at all, which is what it actually is. The existing `streamMatches` helper already draws this
line in `indexer.ts`, and its comment states the rule: raw logs under a topic-and-address filter are
reusable whenever that filter did not GROW.

**Each generation writes only under its OWN label, so there are two writers over one keyspace and
their key sets are disjoint.** Neither can clobber the other, and no coordination rule is needed to
say so. The live generation keeps appending `live` segments the whole time; the successor appends
`staging` segments; and the live entries at or below `N`, which both read, are immutable because `N`
is a SEALED boundary and a sealed segment is never rewritten. (The OPEN tail IS rewritten on every
save — that is how the prerequisite makes an append cost the batch — which is exactly why `N` may
never be it. See the sealing rule above.)

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

- **whole-stream** — a processor-only or decode-only change. The STREAM verdict is wholly valid (the
  topic set is unchanged, so every log the successor needs is already stored), so `N` is the segment
  that was open at creation, just sealed. The successor re-fetches NO history; it re-folds the whole
  stream and then follows the head itself. This is the most common case by far, since an ABI is
  regenerated far more often than it is meaningfully changed, and it is the case a state-verdict
  reading would wrongly demote to a partial graft.
- **partial graft** — an event added or edited below the cursor, changing the FILTER. `N` is the last
  sealed boundary beneath the stream verdict's `invalidFromBlock`; the successor re-fetches from that
  boundary's cursor upward. Bounded by how far back the boundary sits, not by the length of the
  history.
- **no sharing** — a changed address or a new contract. These land in the block-0 skeleton entry,
  whose `hash` and `streamHash` are the SAME value, so both verdicts are invalid from block 0, `N`
  selects no live entries, and the successor backfills the whole history into staging. The rare case,
  and the only one that genuinely pays twice.
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

**Promotion is a step, not a blend, and the step can go BACKWARD.** The cursor jumps; interpolating
would serve a state neither generation ever had. Promotion transfers nothing but the label: the
newly-live generation continues appending to the same stream, at the sequence its staging entries
already occupy.

Backward is the case to build deliberately. The live generation keeps indexing throughout, so at the
promotion instant its cursor can sit AHEAD of the successor's, and after the rename the cursor is the
successor's. A consumer therefore sees the head go backwards by however far the successor was still
behind. Automatic-on-catch-up should promote on the successor having REACHED the live cursor rather
than on some looser notion of caught-up, which bounds the step to roughly one batch; a manual policy
has no such bound and an operator promoting a successor that is hours behind gets hours of rewind,
which is their decision to make but should not be silent.

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

**The verdict must become a PUBLISHED, ACTIONABLE answer, and today it is neither.** This is the
load-bearing plumbing the rest of the design assumes, so it is named rather than left to be
discovered:

- `sourceInvalidationOf` is INTERNAL. `packages/core/src/index.ts` re-exports only `ReorgCause` and
  `ReorgDetection` from that module, and core's `exports` map is `.` plus `./package.json`, so
  `packages/browser` cannot reach it. The container lives browser-side, so the verdict has to cross
  that boundary: a new published core surface, and a changeset.
- `invalidFromBlock` is COMPUTED AND THROWN AWAY. `updateIndexer` builds the verdict from private
  `sourceHashes`, `streamConfigHash` and `lastSync.context`, takes `resetNeeded = !state.valid`, and
  the code says outright that "the block each half names is carried no further than the log line".
  `N` is DERIVED from that block (`N` is a segment sequence, the block is a block), so the block has
  to be carried out instead of logged.
- The verb must be able to REPORT without DISCARDING. `updateIndexer` currently decides and then
  performs the discard itself. Under this design the container decides, so the core verb has to
  offer the verdict and let the caller act.

**`ReconfigureOutcome.stateDiscarded` is the published API this falsifies, and the two changes are
ONE landable because the replacement shape IS the verdict.** Under a successor neither
`updateIndexer` nor `updateProcessor` discards anything: the live generation keeps its state
throughout, so the flag collapses to a per-verb constant — `reset` always discards, the two update
verbs never do — and stops distinguishing the thing it was added to distinguish. The outcome must
grow a shape that says what actually happened (a successor was created and from which graft point,
the verdict was a no-op, or `reset` discarded).

That is a DELETION SWEEP and every reference must be migrated by the task that changes the shape.
There are **38**: `packages/core` (11), `packages/browser` (23), `examples/browser-reference` (2),
and — easily missed because it is not code — **`docs/guide/indexing-in-a-browser-app/index.md` (2)**,
where a whole subsection instructs readers to branch on `{stateDiscarded: boolean}` from all three
verbs. Left out of the fence, the guide keeps teaching an API this design falsifies.

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
  for, none of which may start below **`getFromBlock` applied to segment `N`'s own embedded
  `lastSync`** — that is, `max(min(N.lastToBlock + 1, N.latestBlock - finality), 0)`. State the floor
  as that expression and not as either simplification, because both are wrong somewhere. "Above
  `N`'s `lastToBlock`" is wrong at a HEAD graft, where `latestBlock - finality` wins and the first
  range starts a full `finality` (default 17) blocks lower; a builder held to it would satisfy it by
  restoring the clamp this design rejects. "`N`'s `latestBlock - finality`" is wrong at a MID-STREAM
  graft, where `lastToBlock + 1` wins and the range legitimately starts far below that. The formula
  is the assertion. This is the sharing test and it is the most common reconfigure.
- **A partial graft re-fetches only above its boundary**, under the same floor computed from ITS `N`,
  with `N` landing on the last SEALED boundary BENEATH the STREAM verdict's `invalidFromBlock` and
  never above it.
- **A reload mid-catch-up RESUMES the successor** rather than promoting it or dropping it: both
  labels present with no promotion marker is a pending successor. This is the guard against a browser
  refresh promoting a half-folded generation.
- **An interrupted promotion is completed, not guessed, from EVERY interruption point.** Assert
  recovery from a crash at each of: before step 1, part-way through step 1 (some sequences promoted,
  some not), after step 1 but before step 2, and after step 2 but before the marker is deleted. All
  five must reach the identical end state, and re-running recovery again must change nothing. The
  after-the-renames case is the one that a blanket "delete live above `N`" gets catastrophically
  wrong, so it is the test that earns its place.
- **A stale marker never truncates a stream**: clear the stream with a marker present, confirm the
  marker is gone; and separately, a marker whose sequences correspond to nothing present is discarded
  at load rather than acted on.
- **A decode-only change is whole-stream sharing, not a partial graft**: a renamed non-indexed
  parameter moves `hash` but not `streamHash`, and the successor must re-fetch no history at all.
  This is the guard against reading `N` off the state verdict.
- **`N` is never the open tail**: after a successor is created, the live generation's next save opens
  a new segment, and no write ever targets segment `N` again. This is what makes the shared prefix
  stable, and without it the promoted stream would carry the live tail's post-graft events beside the
  successor's own copy of the same range.
- **An interrupted promotion is detectable and re-runnable**: crashing between the delete and the
  rename leaves a GAP in the live ordinals that the contiguity refusal catches, with staging intact,
  and re-running promotion completes it. Asserted by interrupting at the seam, since the rename-first
  order this rules out would leave a contiguous, silently-wrong stream.
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

This cuts into FIVE separable landables. Cutting them together would produce one task nobody can
review.

1. **The labelled stream.** The key layout, the sealed graft bound `N`, the graft-bounded staging
   read, and journalled per-sequence promotion (marker carrying `N` and `K`, per-sequence
   delete-then-rename, trim above `K`, clear marker), plus marker cleanup on `clear`/`reset`, in the
   shared segmentation
   helper the prerequisite establishes plus both keepers. Buildable and testable on its own (write
   both labels, read with a bound, promote, assert one contiguous live generation; interrupt at each
   step and assert recovery reaches the same end state) and it is the piece the spike measured.
   Everything else depends on it.

   **It also OWNS the key migration, which is otherwise unowned and would silently lose history.**
   The prerequisite leaves users holding `stream_<name>_<chainId>_<ordinal>` AND, for anyone who came
   from a release before it, the adopted legacy key `stream_<name>_<chainId>` with no ordinal at all.
   This spec's anchored match is `stream_<name>_<chainId>_live_<seq>`, which matches NEITHER. Both
   shapes must be migrated, and they fail DIFFERENTLY if they are not, which is why both are named:

   - **Unlabelled ordinals**, unmigrated, make the whole stream unmatchable, so the first load reads
     it as absent and `indexer.ts` clears and re-indexes. Loud and total.
   - **The label-less legacy key**, unmigrated, is far worse because it is SILENT: the ordinals still
     match, so presence reads true and `indexer.ts` does NOT clear, and `fetchFrom` returns a defined
     result that is simply missing the EARLIEST segment. Partial history replayed as whole, which is
     the failure class this set refuses everywhere.

   Both are migrated by RENAME to `_live_<seq>`, the legacy key taking the lowest sequence, ahead of
   every existing ordinal. Renaming rather than adopting-in-place is a deliberate departure from the
   prerequisite, and it is affordable for exactly the reason the spike measured: a rename moves no
   payload. The prerequisite avoided a migration because COPYING would have meant two writes and a
   crash window between them; a rename has neither. Order the write before the delete so a crash
   leaves both keys and the migration re-runs harmlessly, and have the reader prefer the labelled one.
2. **The verdict becomes a published, actionable answer, and `ReconfigureOutcome` grows the shape
   that replaces `stateDiscarded`.** Core-side: publish what the container needs from
   `sourceInvalidationOf` (which half, and `invalidFromBlock`, from which `N` is DERIVED — `N` itself
   is a segment sequence and is the stream layer's business, not core's), and add the changeset.

   **This landable is ADDITIVE and KEEPS the discard.** It publishes the verdict and grows the
   outcome shape while the update verbs still discard exactly as they do today; landable 3 removes
   the discard at the same moment it introduces the container that replaces it. Cutting it the other
   way leaves `main` in a state where an `updateIndexer` with an invalid state verdict neither
   discards nor spawns a successor, so the browser serves a fold that is no longer valid over its
   source — a real regression sitting on `main` between two merges.

   Then the sweep: **38** `stateDiscarded` references —
   `packages/core` (11), `packages/browser` (23), `examples/browser-reference` (2),
   `docs/guide/indexing-in-a-browser-app/index.md` (2). One landable and not two, because the
   replacement shape IS the verdict, so splitting them would land a shape change with no consumer or
   a consumer with no shape.
3. **The generation container plus promotion** — the live/successor pair, the indirect handle, the
   promotion policy knob. The core of the spec. `blockedBy` (1) and (2).
4. **The `createIndexerState` factory migration** — `storeFactory`, `keepStateFactory`, and passing
   the processor factory instead of its result. BREAKING and mostly mechanical, and its footprint is
   larger than it looks. **37 call sites** outside `dist/`: **31 under `packages/browser/test/`**
   (`dispose` 3, `invalidation` 2, `liveReload` 8, `processorKinds` 10, `reconfigure` 2,
   `setupIndexing` 2, `txInclusion` 4), `packages/browser/browser/workload.ts` (1), and **FIVE**
   example apps at one each (`web-demo`, `event-processor-nfts`, `browser-reference`, `basic`,
   `mud` — `basic` and `mud` show the exact `fromJSProcessor(processor)()` trailing-`()` this
   deletes). Four more edit sites are NOT call sites and are unowned unless named here: the README
   usage block, the two JSDoc examples in `packages/browser/src/IndexerState.ts`, the JSDoc in
   `packages/browser/src/storage/state-store/BrowserStateStore.ts`, and the `createIndexerState`
   prose in `CONTEXT.md`. The examples, the README and the guide are the PUBLIC face of the change.
5. **`SyncingState` growing its `successor` block.**

(2) and (4) are migrations with a large file footprint and little judgement; (1), (3) and (5) carry
the design.

**Serialise (2), (3), (4) and (5) with `blockedBy`: they all edit
`packages/browser/src/IndexerState.ts`.** `SyncingState` is declared in it, `createIndexerState` is
declared in it, three of landable 2's `stateDiscarded` references live in it, and the container is
what it returns. Cut in parallel they conflict on one file, which the runner will not auto-resolve.
A workable order is (1) and (2) in parallel with each other, then (4) (the signature), then (3) (the
container inside it, which is also where the discard is removed), then (5).

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

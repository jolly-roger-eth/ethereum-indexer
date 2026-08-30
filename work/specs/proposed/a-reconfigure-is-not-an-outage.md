---
title: 'A reconfigure in the BROWSER is not a blank app: the live generation serves while its successor catches up'
slug: a-reconfigure-is-not-an-outage
taskedAfter: [appending-to-the-stream-costs-the-batch]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **Revised after review.** Naming this unit took three attempts, recorded because the next author
> will be tempted by the same two words. It was first a "version", which already means one entity
> row with a half-open block-validity range (`CONTEXT.md`) and separately a processor's `version`
> field. It was then a "deployment", which is WORSE: that word appears 53 times in this repo in two
> other senses, a "split deployment" (the fetcher/server topology) and a "browser deployment" (an
> installation), both a level ABOVE this concept. The unit is now a **generation**, which has no
> existing use in `CONTEXT.md` or `packages/*/src`. Where this spec still says "deployment" it means
> the repo's installation sense, deliberately.
>
> Two claims were also falsified and are corrected: identity is NOT digest-set equality, and the
> prerequisite must actually deliver something to point at.

> ANSWERED 2026-08-29. A **processor** change DOES make a generation (`updateProcessor` blanks the
> app just as badly, and it is the most routine reconfigure there is). **Doubled fetch traffic during
> catch-up is acceptable**, and is cheaper than it first looked: the doubling is only the
> head-following TAIL, never the history. And **reads do NOT carry generation identity**; the
> question dissolved rather than needing an answer.

> **SCOPE: the BROWSER runtime and the core engine. Nothing else.** Cut down after four review
> rounds, in which every remaining defect was a boundary claim about a runtime this spec had not
> opened. The history is worth keeping so it is not re-litigated:
>
> - **The browser** (`createIndexerState`) is the runtime. Its container, its indirect handle and its
>   `SyncingState` are what this spec details.
> - **The CLI is not a runtime for this.** It is a one-shot `indexToTip` batch with ZERO
>   `updateProcessor` or `updateIndexer` call sites: it never reconfigures, serves reads to nobody,
>   and exits. Its `serve` verb lazily imports the platform server. An earlier draft gave it a
>   `promote` verb; there is no long-running drive to hang one on, so that surface was invented and
>   is removed.
> - **The ingest server is a SEPARATE SPEC**, not an exclusion.
>   `work/specs/proposed/an-ingest-server-reconfigure-is-not-a-blackout.md` owns it. An earlier draft
>   excluded it on the false premise that it has no processor; it injects one via `getIngestion` and
>   `StreamBuilder` calls `processor.clear()` on a changed context. That is a real outage with a real
>   mechanism, and it deserves its own spec rather than a paragraph here.
>
> Because the server moved out, the operator-facing stories moved with it. What remains here is the
> browser story: a reconfigure should not blank the app.

## Problem Statement

An indexer has exactly one state, and reconfiguring mutates it in place. When ADR-0034 says a change
"discards the state and re-indexes from block 0", it means the running indexer has nothing to answer
with until it has caught up.

On a server that is an **outage** proportional to the history. In a browser it is a blank app: the
UI reading the store sees it emptied and refilled. The operator's only lever is to not reconfigure.

ADR-0033 and ADR-0034 shrank how OFTEN this happens. They did not change what happens when it does,
and the remaining cases are the ones that matter: a new event below the cursor, a changed address, a
new contract, and a processor upgrade.

The mechanism is not more invalidation cleverness. It is that **an indexer should hold more than one
generation at a time**, which is what The Graph does: a new generation syncs alongside the old one
and the canonical pointer moves when it is ready.

## Solution

An indexer holds up to **two** generations: the LIVE one, which answers every read, and at most one
PENDING one, which is catching up and answers nobody.

- Reconfiguring creates a pending generation instead of mutating the live one.
- The pending generation builds its own state, re-folding from the stream, re-fetching only what its
  source needs and the stream does not already hold.
- Reads are served by the live generation throughout.
- **Promotion** makes the successor live. It is a POLICY knob whose axis is the ENVIRONMENT:
  automatic on catch-up (the browser default, and what a DEV iterating on a processor wants, since
  hand-promoting after every edit would be absurd) or manual (for an app that wants to look before
  its readers move). One knob, with a default.
- Reconfiguring again while one is pending REPLACES the pending one. Two, never three.

## Identity, which is not digest equality

The first draft said a generation is identified by the ADR-0034 digest set. That is wrong twice, and
both are load-bearing:

- **Digest inequality does not mean a new generation.** `sourceInvalidationOf` deliberately ignores
  an added entry whose `startBlock` is above `lastToBlock`, so appending an event above the cursor is
  FREE today. Making digest-set equality the identity would spin up a pending generation and a full
  re-fold for precisely the case ADR-0034 made free, regressing its headline.
- **The digest set is not stable for a fixed state.** On the kept-state path the core REWRITES
  `lastSync.context.source` to the new hashes, so one unchanged state legitimately carries two
  digest sets over time.

So identity is **the invalidation VERDICT plus the `processor` hash**: a new generation is needed
exactly when `sourceInvalidationOf` says something already indexed became invalid, or when the
processor hash moved. An unchanged source is a no-op because the verdict says nothing changed, not
because two digests matched.

`config` is deliberately NOT in that list, though an earlier draft included it.
`sourceInvalidationOf` compares `context.config` against the stream config hash FIRST and returns
both halves invalid on a mismatch, so it is already INSIDE the verdict. Only `processor` is genuinely
outside, because `sourceInvalidationOf` never reads `context.processor`. Listing config again would
have a builder write a redundant second comparison.

The `processor` half is not a footnote: a changed processor version hash makes a generation, so all
three reconfigure entry points route through this. `updateProcessor` creates a pending generation
instead of clearing and reloading; `updateIndexer` does the same on a source verdict; `reset` stays
what it is, an explicit unconditional discard, because it is the one the caller means as a discard.

Note also that `simple_hash` is a 32-bit non-cryptographic hash. As a change DETECTOR a collision
costs one missed invalidation; as an IDENTITY it would silently adopt another generation's state.
Identity resting on the verdict rather than on hash equality keeps that exposure where it already is.

## User Stories

1. As a browser user, I want the app to keep rendering while a new generation builds, instead of
   going blank, and to switch when it is ready.
2. As a browser developer, I want to change the source OR the processor without blanking my app.
3. As a browser developer, I want to turn the auto-switch off and show catch-up progress instead.
4. As an app author, I want to know that a successor generation exists and how far it has caught up,
   so I decide whether to render, dim or hide the live state, since only I know whether my
   reconfigure made the old answers wrong or merely incomplete.
5. As a reader holding a state handle across a promotion ON THE ENTITIES PATH, I want it to keep
   answering from the generation that is now live, so holding a reference is never a way to be
   silently stale. (On the js-object path the published value is a plain object replaced wholesale,
   so a holder of the OLD reference is stale exactly as it is today; unchanged by this spec and not
   regressed by it.)
6. As a developer, I want a reconfigure the invalidation verdict calls a no-op to cost nothing.
7. As a developer reconfiguring twice, I want the second to replace the first pending generation.
8. As a developer, I want a generation whose stream is unavailable to fall back to a full re-index,
   which is today's behaviour, so the feature degrades rather than breaks.
9. As a DEV iterating on a processor, I want promotion to happen automatically, rather than
   hand-promoting after every edit.

## Implementation Decisions

**Two generations, not N.** Verified: `StateStore` offers `revertTo(keepUpTo)` and capability-gated
`asOf` and NO fork verb, and `revertTo` is destructive (versions opened above the point are gone,
versions the dead branch closed become live again), so it cannot produce a branch without destroying
the original. Each generation materialises its own state by re-folding from the shared stream, at one
full state each, linearly. Two covers the reconfigure case; N buys rollback and A/B at N times the
state storage and can be added later without redesign.

**The graft point is REAL, and it works by reference over FINAL segments.** A previous draft retired
it, on the grounds that segments are ordinal-keyed so no segment prefix corresponds to a block
prefix. That is true in general and FALSE for the region that matters, which is the whole point:

- Reorgs never reach below `latestBlock - finality`; the indexer re-fetches from exactly there every
  round.
- So once a segment's recorded `max` is under that horizon it is FINAL, and no later segment can
  ever contain a lower block. Since `latest` only grows, a final segment stays final.
- Below the horizon, therefore, ordinal order and block order DO agree, and the segments covering
  blocks `[0, N)` are selectable by the ranges `appending-to-the-stream-costs-the-batch` records.

So a successor grafting at N shares every segment whose `max < N` **by reference**: no copy, no
re-fetch. At most a couple of segments STRADDLE N, and only those are filtered or their range
re-fetched. That is a local metadata scan against a network backfill of the whole prefix, and
`eth_getLogs` is the most constrained call this system makes.

**Which is why the clamp exists, and it is NOT vestigial.** The graft point must sit below the
finality horizon, because that is exactly what makes the prefix segments final, hence stable, hence
addressable by block. The draft that retired the graft point also called the clamp purposeless; it
had the causality backwards. The clamp is the precondition, not a leftover.

**Two costs, named rather than glossed.** Final segments can still OVERLAP each other, because a
reorg that struck while they were unconfirmed leaves a later segment re-carrying those numbers, so
selection is by range intersection and not a binary search. And a shared segment now has TWO
referents, so retiring a generation must not delete segments the other still points at: a successor's
stream is "a reference to a prefix, plus its own segments", and that lifetime rule is the real
complexity this buys with the saved backfill.

**The graft point is clamped to the finality DEPTH, not to a finalized head.** There is no
chain-reported finalized block in the core; there is a configured `finality` and `getFromBlock`
computing `latest - finality`. A pending generation starts from the block its source first differs
at, clamped down to that head. Clamping DOWNWARD is the safe direction, costing redundant fetching
and losing nothing.

**Reorgs are handled per generation, independently.** ABOVE the graft point each generation follows
the head and processes reorgs itself; they may briefly disagree, each is internally consistent, and
both converge. BELOW it there is nothing to disagree about, because the clamp keeps the shared prefix
beneath the reorg window, so no reorg can invalidate bytes both generations depend on. That is the
same argument as the clamp's, seen from the reorg side.

**Prefix sharing is TOTAL for the common cases, and absent only in the rare one.** An earlier draft
said the opposite, having weighted the rarest case. Ranked by how often a real DEPLOYMENT (in this
repo's existing sense, an installation) actually reconfigures:

- **A processor change** (a handler bug fix, the most routine reconfigure of all) leaves the source
  untouched, so every source digest is unchanged and the ENTIRE stream is valid. The pending
  generation re-fetches NO history at all; it only re-folds. Maximal sharing.
- **A decode-only source change** (a renamed non-indexed parameter) leaves the topic set unchanged,
  so again the entire stream is valid and only the fold is redone.
- **An event added ABOVE the cursor** creates no generation at all: `sourceInvalidationOf` already
  calls it free.
- **An event added or edited BELOW the cursor** shares PARTIALLY, by grafting at that event's
  `firstBlock`. Every final segment beneath the graft point is shared by reference, the couple that
  straddle it are filtered, and only blocks above it are re-fetched. This case went through two wrong
  descriptions before landing here: first that it shared a prefix trivially (it does not, segments
  are ordinal-keyed), then that it shared nothing at all (it does, because final segments record
  their block ranges and cannot be reordered by a later reorg).
- **A changed `address` or a new contract** lands in the block-0 SKELETON entry, so the graft point
  is 0 and nothing is shared. This is the rare case, not the representative one, and it is the only
  one that re-fetches a whole history.

So the cases that create a generation mostly share the WHOLE stream, and the expensive work is
re-folding rather than re-fetching.

The fetch cost follows directly, and it is now THREE cases rather than the two an earlier draft
assumed:

- **Whole-stream sharing** (processor-only, decode-only): the successor fetches **nothing at all**,
  not even a doubled tail, because it reads the live stream the live generation is still appending
  to. There is no doubled `eth_getLogs` in the case that matters most.
- **Partial sharing at a graft point** (an event added or edited below the cursor): it re-fetches
  only from the graft point up, sharing every final segment beneath it by reference. Bounded by how
  far back the boundary sits, not by the length of the history.
- **No sharing** (a changed address, a new contract): a full doubled backfill, since the block-0
  skeleton entry moved and nothing beneath is valid. Accepted, because the alternative is the outage
  this spec exists to remove, but it is the one case that genuinely pays twice and it should be
  stated rather than implied.

**The no-outage value does not depend on sharing at all**: the live generation keeps answering
regardless. Sharing decides how expensive catching up is, not whether reads survive.

**Prerequisite: `appending-to-the-stream-costs-the-batch`, and the reason is the WRITE path, not a
prefix reference.** An earlier draft said that spec delivers segments that are immutable and
addressable so a prefix can be pointed at. That rationale is stale twice over: it delivers
independently READABLE segments (it says outright that "addressable" would not bite), and under the
one-writer rule below this spec never points at a prefix at all.

The real dependency is that a successor building its OWN stream must be able to write one without
paying the quadratic append, and that a live stream being read by a successor must not be rewritten
wholesale underneath it on every save. Both are properties of the append-only shape. A successor
against today's single blob would be reading a value that is replaced in full on every batch.

**No filter or lineage provenance is needed, and the graft point is WHY.** A stream is
decode-neutral but not filter-neutral: the absence of a log means something only against the filter
its range was fetched under. That looks like it should force per-segment filter provenance on any
shared segment, and two earlier drafts concluded so.

It does not, because of what a graft point IS. The graft point is the block at which the two sources
first differ, so BELOW it the two generations want identical filters, by construction. A shared
segment beneath the graft point was therefore fetched under exactly the filter its new reader would
have used. ABOVE the graft point nothing is shared at all: the successor fetches that range itself.

So provenance is unnecessary in both directions rather than merely deferred, and this spec re-shapes
no part of `ExistingStream`, which
`appending-to-the-stream-costs-the-batch` pins as unchanged. What it does consume is the per-segment
BLOCK RANGE that spec records, which is metadata rather than a seam change.

**Reads do NOT carry generation identity, and the handle FOLLOWS promotion.** An earlier draft had a
story for a reader knowing which generation answered it, and an open question about whether that
rode on the handle or on every read return. Both are dropped, because the question dissolves:

- Per-read provenance (changing what the four `StateStore` verbs return) is the only option that
  would have to be decided NOW, since it is a breaking change to the read seam, four backends and
  the conformance suite. It is REJECTED.
- The identity necessarily EXISTS internally, because promotion cannot work without the indexer
  knowing which generation is live. So exposing it later is purely additive, and a query layer is
  its natural home, as a meta field on the response envelope rather than stapled to every row.
  Nothing here forecloses that.
- What remains is not provenance but LIFETIME, and it is the real defect the review found: the
  entities path publishes a handle bound to a store, so a consumer holding one across a promotion
  would silently keep reading the retired generation. Fix it by making the handle INDIRECT, a
  reference to whichever generation is live rather than to a particular one. Promotion then becomes
  transparent to every holder, and the entire staleness class disappears instead of being made
  detectable.

**The live generation KEEPS INDEXING while a successor is pending, and the only signal a consumer
gets is that a successor EXISTS and how far along it is.**

Note the word, because an earlier draft got it wrong. The live generation is not "superseded" while
a successor catches up: supersession is precisely the decision promotion makes and has NOT yet made.
Marking the live state superseded would encode a verdict nobody has reached, and would be false
outright if the operator inspects the successor and rejects it. Until promotion the live generation
is simply LIVE and the pending one is its SUCCESSOR.

Two alternatives were considered and rejected, and the reasoning is the load-bearing part.

_Freezing it_ (retiring it from indexing the moment a pending generation starts) looks free and is
not. An indexer that stops carries an UNCONFIRMED window, blocks inside the finality depth that it
has processed but that are not yet final. If it stops, and one of those is reorged away, it never
finds out: its state permanently contains events from blocks that no longer exist, and it has
retired the only machinery that could have discovered that. Freezing safely would mean
`revertTo(finalisedHead)` first, which discards exactly the recent data a UI is showing. Since the
doubled tail fetch is already accepted, keeping it live costs something already paid for and buys
correctness for nothing.

_Discarding immediately_ (today's behaviour, kept as a mode, so the app never shows the older state)
was rejected because it makes the INDEXER decide something only the APP knows. Whether old data is
misleading depends entirely on WHY the reconfigure happened, and the indexer cannot see that: after
a processor bug fix the old state is WRONG, which is why it was fixed; after an added event it is
merely INCOMPLETE, and everything it says is still true; after a renamed parameter it is FINE.
`sourceInvalidationOf` can say what moved, never whether the old answers are now lies. So there is
no safe default, and a second indexer mode would only relocate the guess.

Instead the live state keeps being served, and the consumer is told **a successor exists and how far
it has caught up**. The app then renders, dims, banners or hides, because the app author is the only
party who knows which of the three cases above they are in. One mechanism, no discard mode, and the
presentation decision sits where the information is rather than as a branch inside the indexer.

**That signal is not a second thing to publish.** Catch-up progress and the existence of a successor
are the SAME fact: if progress is being reported, a successor exists. So it collapses into open
question 2 rather than adding surface, and there is no flag on the live generation at all.

Worth noting how little the app needs. It does not need the indexer to CHARACTERISE anything,
because the app is what called `updateProcessor` or `updateIndexer` and already knows whether it was
fixing a bug, adding an event or renaming a field. The one thing it cannot know by itself is whether
the replacement is ready. That is the whole signal.

**One mechanism, two runtimes.** The browser case is the stronger one: today a reconfigure blanks the
app. Only the promotion POLICY differs, and it is a knob whose axis is the ENVIRONMENT rather than
the runtime: production wants manual, development wants automatic, and that is as true of a dev
server as of a browser. Two concrete browser gaps remain, and the reactive shape is not one of them
(the root store replaces its value wholesale):

**`createIndexerState` stops EAGERLY INVOKING the processor factory that already exists, and gains a
per-generation factory for the state-holding resource.**

The processor factory is NOT a new concept and must not be re-invented. It is already the
convention, in both flavours, and the entities one already takes exactly the right argument:

- `fromJSProcessor(def)` returns `() => JSObjectEventProcessor`, exported by every example as
  `createProcessor`;
- `fromEntityProcessor(def, options)` returns `(store: StateStore) => EntityEventProcessor`.

What apps do today is invoke it at the CALL SITE and hand in the result:
`fromJSProcessor(processor)()`, or `fromEntityProcessor(tokenProcessor)(store)`. So
`createIndexerState` receives an already-bound instance and cannot build a second one.

The change is therefore to pass the factory rather than its result, and then to make the
STATE-HOLDING resource differ per generation:

- **entities**: `processor: (store) => Processor` is unchanged, plus `storeFactory: (generation) =>
  StateStore`.
- **js-object**: `processor: () => Processor` is unchanged, plus `keepStateFactory: (generation) =>
  KeepState`.

An earlier draft claimed the js-object path needed NO factory, because `KeepState`'s three methods
already receive a `ProcessorContext` and that context identifies a generation. **That was wrong on
both halves and is corrected here**, because the mistake is instructive:

- **A keeper cannot derive the generation.** Identity is the invalidation VERDICT, and
  `sourceInvalidationOf` needs the STORED `ContextIdentifier`, which a keeper is never handed; it
  sees only the CURRENT context. Falling back to hashing `context.source` is exactly the digest
  equality the Identity section rejects, so an event appended above the cursor would change the key
  and orphan the live state on the next reload, turning ADR-0034's free case into a full re-index and
  regressing story 6.
- **`ProcessorContext` is not that triple.** Its `config` is the PROCESSOR config, whereas
  `ContextIdentifier.config` is the `streamConfigHash`. So the stream config is absent entirely, and
  `updateIndexer` changing only `streamConfig` would produce a live and a successor with
  byte-identical `ProcessorContext` colliding on one key — the clobber
  `work/notes/observations/keepstate-storage-id-omits-the-processor-version.md` warns about.

So the two paths ARE symmetric after all: each takes a per-generation factory for its state-holding
resource, and the container supplies the generation because it is the only thing that knows it.

The generation argument belongs on the STATE factory and not on the processor factory. It is
load-bearing there: the store name must be both STABLE across sessions (or a reload finds no data)
and DISTINCT per generation (two IndexedDB stores sharing a `databaseName` are one store by that
store's own documentation, so a successor would fold into the live generation's rows). Deriving it
from the generation is what satisfies both at once.

The live generation is built through the same path at init, so there is one construction path rather
than two, and `updateProcessor` takes a factory for the same reason.

This is a breaking change to `createIndexerState`, accepted deliberately, but a much smaller one
than it first appeared: for most call sites it is deleting the trailing `()` and supplying a state
factory.

The migration is larger than an earlier draft's "roughly a dozen" estimate, and the difference
matters under the file-ownership rule: about 28 `createIndexerState` call sites under
`packages/browser/test` alone (`dispose`, `txInclusion`, `processorKinds`, `liveReload`,
`reconfigure`, `setupIndexing`, `invalidation`), plus `packages/browser/browser/workload.ts`, plus
FOUR example apps (`web-demo`, `event-processor-nfts`, `browser-reference`, `mud`) and the README
usage block. The examples and the README are the PUBLIC face of the change and a batch cut from the
old estimate would not have owned them.

**What is shared and what is not.** These are two different stores and conflating them is easy:

- the **stream** (`keepStream`) is shared IN THE SHARING CASES ONLY, and read-only: the successor
  reads the whole live stream instead of re-fetching it, and writes nothing to it until promotion.
  In the re-fetching cases nothing is shared and the successor gets its own generation-keyed stream.
  (An earlier draft said flatly that the stream IS shared, which is true of neither the re-fetching
  cases nor of the write direction.)
- the **state store** CANNOT be shared, ever. It is the materialised fold, two generations have
  different folds by definition, and `StateStore` has no fork verb. Each generation materialises its
  own, and that is what the factory mints.

**Every stream has exactly ONE WRITER AT A TIME, and that writer is the LIVE generation.** An earlier
draft said "one writer for its whole life", which is both stronger than needed and impossible: it
left promotion undefined, since in the sharing case the successor has written nothing and must take
over the stream it becomes responsible for. The invariant that actually holds is per-moment, and the
writer changes exactly at promotion.

What each case drives, fetches and writes, stated per case because an earlier draft left it to be
inferred:

- **The sharing cases** (a processor-only change, a decode-only change). Every topic the successor
  needs is already in the live stream, so it FETCHES NOTHING. It drives its own
  `EthereumIndexer` over the live stream as a READER, re-folding into its own state store, and it
  keeps reading as the live generation appends. At promotion it takes over writing that same stream
  and the retired generation stops. The stream is continuous and never had two writers.
- **The re-fetching cases** (an event added or edited below the cursor, a changed address, a new
  contract). The successor shares nothing, per the ranked list above, so it fetches a full backfill
  into its OWN stream, keyed by its generation, which nobody else reads or writes. At promotion that
  stream becomes the live one and the retired generation's stream is deleted whole.

**Two mechanisms this requires, neither of which exists today:**

1. **A read-only stream view.** `EthereumIndexer` calls `keepStream.saveNewEvents` UNCONDITIONALLY on
   every save, so "a pure reader" is not expressible by simply not writing. The sharing-case
   successor is given an `ExistingStream` whose `saveNewEvents` is a no-op over the live stream's
   keys. Without this the successor would write into the live tail and clobber its cursor, which is
   the exact hazard this rule exists to prevent.
2. **A `streamFactory: (generation) => ExistingStream`**, alongside `storeFactory` and
   `keepStateFactory`. `keepStream` is a single injected instance keyed `stream_<name>_<chainId>`
   with no generation in the key, so a re-fetching successor currently has nowhere to put its stream.
   The container chooses which shape a generation gets: the read-only view for a sharing case, a
   generation-keyed stream for a re-fetching one.

With those, a stream is either read by a successor that never writes it, or written by a successor
nobody else reads. Combined with the graft-point argument above (below the boundary the filters agree
by construction), that is why no per-segment lineage attribution and no filter provenance is required
anywhere in this design.

**`SyncingState` grows an optional `successor` block, and the live fields stay flat.** Nesting both
under `live` and `successor` was considered and rejected as a category error: the record mixes
provider-level facts (`waitingForProvider`), policy (`autoIndexing`) and per-generation facts
(`lastSync`, `catchingUp`, `fetchingLogs`, `processingFetchedLogs`, `loading`, `numRequests`), so a
uniform nesting would assert that the provider is per-generation, which is false. Leaving the live
fields flat also means no existing consumer changes, and the common case (no successor) is expressed
as absence. `syncPercentage` already rides on `lastSync`, so a successor's progress comes along
inside its own `lastSync` rather than needing a new field.

**An error is reported on every generation it actually breaks.** The successor carries its own
`error`. A successor-only failure (a processor that throws on replay, a decode error while
backfilling) sets `successor.error` alone, which is exactly the signal an operator needs before
promoting. A shared failure (the provider is down, and both generations use the same provider)
breaks both and is therefore reported on both; that is accurate rather than duplicated, and a
consumer wanting to say it once can compare the existing `id: ErrorCode`. No `scope` field is added,
because two ids already disambiguate what one would.

**Promotion is a step, not a blend.** The cursor jumps. Interpolating would serve a state neither
generation ever had.

**`ReconfigureOutcome.stateDiscarded` is a published API this design falsifies, and it is owned
here.** It shipped days ago on all three reconfigure verbs and is pinned by roughly 26 assertions
across the core tests and the browser harness. Under a pending generation neither `updateIndexer`
nor `updateProcessor` discards anything: the live generation keeps its state throughout, so the flag
collapses to permanently false and stops distinguishing the thing it was added to distinguish. That
is a DELETION SWEEP, not a detail: the reconfigure outcome must grow a shape that says what actually
happened (a generation was created, or the verdict was a no-op, or `reset` discarded), every
assertion pinning the old flag must be migrated by the task that changes it, and the browser
consumers of `stateDiscarded` in `IndexerState` must move with it. A spec that left this unnamed
would have the first task to trip over it rewrite the corpus by guess.

Retaining a discard-immediately MODE would have partly rescued the flag, by keeping a path on which
it still varies. That mode is rejected above, so the rescue is not available: with no discard mode
`reset` always discards and the two update verbs never do, which makes the flag a per-verb constant
and dead as a signal. Settled, not open.

**`reset` stays an unconditional discard, and it also drops the pending generation.** It is the one
verb whose caller MEANS discard, so it does not create a generation. Two consequences to build
deliberately: it discards the pending generation as well as the live one, and it is the only path
that clears the STREAM, which under sharing is the prefix a pending generation may be folding from,
so it must not run while a pending generation depends on it.

**A container owns the live-plus-successor pair.** `EthereumIndexer` holds exactly one processor,
one `lastSync` and one `keepStream` key, so it cannot hold both. With the factory above, a successor
is a full second stack (its own `EthereumIndexer`, processor and state store), and the container is
what `createIndexerState` returns: it holds the pair, publishes the indirect handle, owns promotion,
and is what `SyncingState` describes.

`promote` is therefore a method on that container, reached as a UI action. There is exactly ONE home
for it. There is no CLI verb (the CLI never reconfigures and has no long-running drive) and no server
surface here (that is the separate ingest-server spec).

## Testing Decisions

- **Not-an-outage is the claim, so assert on READS during catch-up**, not on the end state: reads
  succeed continuously across a reconfigure, and answer from the live generation's state until
  promotion. Assert on the ANSWERS, since reads do not report identity.
- **The no-op claim** asserts on ranges fetched AND on state discarded, the pair ADR-0034
  established, since neither alone separates a resume from a rebuild.
- **Replacement**: reconfiguring twice leaves exactly two generations, and the first successor's
  storage is reclaimed whole — its state store, and its own stream if it built one. Nothing is
  reclaimed from the LIVE generation's stream, which is the one-writer rule stated as a test.
- **A successor never writes the live stream**: after a sharing-case reconfigure, the live stream's
  keys are byte-identical to what they were, while the successor's state is built. This is the guard
  against the two-writer clobber.
- **A reorg during catch-up** is handled per generation: in the sharing case the successor sees the
  live generation's retractions through the stream it reads, and in the re-fetching case it derives
  its own. Both converge.
- **The clamp**: a graft point inside the unconfirmed window is clamped DOWN to the finality horizon
  rather than accepted, since a prefix that could still be reorged cannot be shared by reference.
- **Partial sharing at a graft point re-fetches only above it**: asserted on the ranges the node was
  asked for, with the final segments beneath the boundary shared by reference and the straddling ones
  filtered.
- **The sharing case fetches NOTHING**: asserted on the ranges the node was asked for while a
  successor catches up after a processor-only change. Zero, not merely fewer.
- **A successor never writes the live stream before promotion**: the live stream's keys are
  byte-identical across a sharing-case catch-up, which is the guard the read-only view exists to
  provide.
- **Promotion transfers the writer**: after promotion the newly-live generation appends to that same
  stream and the retired one stops, with no gap and no second writer at any moment.
- **Identity**: an event appended above the cursor does NOT create a pending generation, which is the
  regression guard for ADR-0034's headline.
- **A processor-only change re-fetches NOTHING**, asserted on the ranges the node was asked for. It
  is the most common reconfigure and the one with the most to share, so it is the sharing test.
- **A handle held across a promotion** keeps answering and answers from the newly-live generation,
  which is the regression guard for the silent-staleness the indirect handle exists to remove.
- **The reconfigure outcome** says what happened under a pending generation, and every existing
  assertion on `stateDiscarded` is migrated rather than left inverted.
- **The live generation keeps advancing** while a successor is pending: its cursor moves and it
  processes a reorg in its own unconfirmed window. This is the regression guard against freezing it
  and stranding a tail it could never correct.
- **A successor's progress is visible** for as long as one is pending, and stops being reported at
  promotion, because after promotion there is no successor.
- **A successor-only failure** sets `successor.error` while the top-level one stays clear; a shared
  provider failure sets BOTH, carrying the same `ErrorCode`.
- **The state factory is called per generation** on BOTH paths, and a successor's state is distinct
  from the live one's: a write to one is not visible in the other, which is the guard against the
  same-`databaseName` collision. The name is also STABLE across a reload for the same generation, so
  a restart finds its data rather than minting a third store.
- **A `streamConfig`-only change** produces a live and a successor that do NOT collide, which is the
  regression guard for the `ProcessorContext` hole: that context cannot distinguish them, so the
  generation must come from the container.

## Tasking note

This is the largest of the four specs in this family and it cuts into FOUR separable landables, which
a tasker should follow rather than treating it as one body of work:

1. **The generation container plus promotion** (the live/successor pair, the indirect handle, the
   promotion policy knob). The core of the spec.
2. **The `createIndexerState` factory migration**, covering `storeFactory`, `keepStateFactory` AND
   `streamFactory` plus the read-only stream view, which is BREAKING and mostly mechanical: about 28
   call sites under `packages/browser/test`, the browser harness, four example apps and the README.
3. **The `stateDiscarded` deletion sweep**, roughly 26 assertions plus the browser consumers.
4. **`SyncingState` growing its `successor` block.**

(2) and (3) are migrations with a large file footprint and little judgement; (1) and (4) carry the
design. Cutting them together would produce one task nobody can review.

Note also what is NOT in this list: per-segment filter and lineage provenance, which this design does
not need at all (below a graft point the two generations want identical filters by construction, and
above it nothing is shared). This spec therefore re-shapes NO part of `ExistingStream`, which leaves
`the-stream-stores-only-what-the-node-said` as the only sibling touching that seam, so the two
dependents of the storage spec do not contend and need no ordering between them. What this spec does
CONSUME from its prerequisite is the per-segment block range, which is metadata and not a seam.

## Out of Scope

- **N generations**, rollback, A/B. Reachable later at linear storage cost.
- **Sharing state between generations.** Not available; each re-folds.
- **Smoothing the promotion step.**
- **Pruning of SEALED SEGMENTS WITHIN one stream.** Genuinely unowned, and this spec does not need
  it: under the one-writer rule a successor either wrote its own stream (which it owns whole, and
  which is deleted outright when that generation is retired) or wrote none at all. So reclamation
  here is deleting a whole stream and a whole state store, which `ExistingStream.clear` and the state
  store already do. Pruning older segments of a stream that is still live is a separate want, and
  neither spec claims it.

## Further Notes

Came out of a design conversation about stream branching
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`), which framed the same mechanism
from the storage end. Branching is HOW; this is WHAT it buys.

The Graph is the closest prior art and was drawn on deliberately: grafting is a graft point, a
pending generation is a pending generation, promotion is the canonical pointer moving, and the stable
URL is the indirection hiding the switch. This differs in having to work in a browser with no URL and
no operator. The word **generation** is taken from it too, which also avoids the `version` collision.

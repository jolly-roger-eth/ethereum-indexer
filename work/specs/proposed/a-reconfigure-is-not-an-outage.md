---
title: 'A reconfigure is not an outage: the live deployment serves while the pending one catches up'
slug: a-reconfigure-is-not-an-outage
taskedAfter: [the-stream-is-what-the-node-said-appended-once]
needsAnswers: true
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **Revised after review.** The first draft called the unit a "version", which already means one
> entity row with a half-open block-validity range (`CONTEXT.md`) and separately a processor's
> `version` field. It is now **deployment** throughout. Two claims were also falsified and are
> corrected: identity is NOT digest-set equality, and the prerequisite must actually deliver
> something to point at.

> ANSWERED 2026-08-29. A **processor** change DOES make a deployment (`updateProcessor` blanks the
> app just as badly, and it is the most routine reconfigure there is). **Doubled fetch traffic during
> catch-up is acceptable**, and is cheaper than it first looked: the doubling is only the
> head-following TAIL, never the history. And **reads do NOT carry deployment identity**; the
> question dissolved rather than needing an answer.

<!-- open-questions -->

## Open questions

1. **Who allocates the pending deployment's store, and therefore where does the indirect handle
   live?** These are ONE question, not two, which is why `needsAnswers` is back. `createIndexerState`
   takes ONE pre-built processor with its store already bound, so the answer changes the PUBLIC
   surface of `createIndexerState` and decides the handle's shape: if the pending deployment is a
   second `EntityEventProcessor`, the indirection must sit in a layer ABOVE it; if it is a swappable
   store inside one processor, it is close to a getter in `view.ts`. At least three shapes exist (a
   store-factory option, a processor factory, or the browser package building it). Answer this before
   tasking, or the first task picks the public API by accident.
2. **What shape does `SyncingState` grow?** It is a single flat record with one `lastSync` and one
   `syncPercentage`, and stories 3 and 4 need pending catch-up progress. This is published surface
   too.

## Problem Statement

An indexer has exactly one state, and reconfiguring mutates it in place. When ADR-0034 says a change
"discards the state and re-indexes from block 0", it means the running indexer has nothing to answer
with until it has caught up.

On a server that is an **outage** proportional to the history. In a browser it is a blank app: the
UI reading the store sees it emptied and refilled. The operator's only lever is to not reconfigure.

ADR-0033 and ADR-0034 shrank how OFTEN this happens. They did not change what happens when it does,
and the remaining cases are the ones that matter: a new event below the cursor, a changed address, a
new contract, and (per open question 1) a processor upgrade.

The mechanism is not more invalidation cleverness. It is that **an indexer should hold more than one
deployment at a time**, which is what The Graph does: a new deployment syncs alongside the old one
and the canonical pointer moves when it is ready.

## Solution

An indexer holds up to **two** deployments: the LIVE one, which answers every read, and at most one
PENDING one, which is catching up and answers nobody.

- Reconfiguring creates a pending deployment instead of mutating the live one.
- The pending deployment builds its own state, re-folding from the stream, re-fetching only what its
  source needs and the stream does not already hold.
- Reads are served by the live deployment throughout.
- **Promotion** makes the pending deployment live: manual on a server, automatic in the browser,
  with an option to disable the auto-switch and surface catch-up progress instead.
- Reconfiguring again while one is pending REPLACES the pending one. Two, never three.

## Identity, which is not digest equality

The first draft said a deployment is identified by the ADR-0034 digest set. That is wrong twice, and
both are load-bearing:

- **Digest inequality does not mean a new deployment.** `sourceInvalidationOf` deliberately ignores
  an added entry whose `startBlock` is above `lastToBlock`, so appending an event above the cursor is
  FREE today. Making digest-set equality the identity would spin up a pending deployment and a full
  re-fold for precisely the case ADR-0034 made free, regressing its headline.
- **The digest set is not stable for a fixed state.** On the kept-state path the core REWRITES
  `lastSync.context.source` to the new hashes, so one unchanged state legitimately carries two
  digest sets over time.

So identity is **the invalidation VERDICT plus the `processor` and `config` hashes**: a new
deployment is needed exactly when `sourceInvalidationOf` says something already indexed became
invalid, or when a hash `ContextIdentifier` tracks separately moved. An unchanged source is a no-op
because the verdict says nothing changed, not because two digests matched.

The `processor` half is not a footnote: a changed processor version hash makes a deployment, so all
three reconfigure entry points route through this. `updateProcessor` creates a pending deployment
instead of clearing and reloading; `updateIndexer` does the same on a source verdict; `reset` stays
what it is, an explicit unconditional discard, because it is the one the caller means as a discard.

Note also that `simple_hash` is a 32-bit non-cryptographic hash. As a change DETECTOR a collision
costs one missed invalidation; as an IDENTITY it would silently adopt another deployment's state.
Identity resting on the verdict rather than on hash equality keeps that exposure where it already is.

## User Stories

1. As an operator, I want to change the source OR the processor without my server going dark.
2. As an operator, I want to promote deliberately, after seeing the pending deployment has caught up.
3. As a browser user, I want the app to keep rendering while the new deployment builds, and switch
   when it is ready.
4. As a browser developer, I want to turn the auto-switch off and show catch-up progress instead.
5. As a reader holding a state handle across a promotion ON THE ENTITIES PATH, I want it to keep
   answering from the deployment that is now live, so holding a reference is never a way to be
   silently stale. (On the js-object path the published value is a plain object replaced wholesale,
   so a holder of the OLD reference is stale exactly as it is today; that is unchanged by this spec
   and is not regressed by it.)
6. As an operator, I want a reconfigure the invalidation verdict calls a no-op to cost nothing.
7. As an operator reconfiguring twice, I want the second to replace the first pending deployment.
8. As an operator, I want a deployment whose stream is unavailable to fall back to a full re-index,
   which is today's behaviour, so the feature degrades rather than breaks.

## Implementation Decisions

**Two deployments, not N.** Verified: `StateStore` offers `revertTo(keepUpTo)` and capability-gated
`asOf` and NO fork verb, and `revertTo` is destructive (versions opened above the point are gone,
versions the dead branch closed become live again), so it cannot produce a branch without destroying
the original. Each deployment materialises its own state by re-folding from the shared stream, at one
full state each, linearly. Two covers the reconfigure case; N buys rollback and A/B at N times the
state storage and can be added later without redesign.

**The graft point is clamped to the finality DEPTH, not to a finalized head.** There is no
chain-reported finalized block in the core; there is a configured `finality` and `getFromBlock`
computing `latest - finality`. A pending deployment starts from the block its source first differs
at, clamped down to that head. Clamping DOWNWARD is the safe direction, costing redundant fetching
and losing nothing.

**Reorgs are handled per deployment, independently.** Above the graft point each follows the head and
processes reorgs itself. They may briefly disagree; each is internally consistent and both converge.
The clamp above is what keeps the shared prefix beneath the reorg window, so no reorg can invalidate
bytes both depend on.

**Prefix sharing is TOTAL for the common cases, and absent only in the rare one.** An earlier draft
said the opposite, having weighted the rarest case. Ranked by how often a real deployment actually
reconfigures:

- **A processor change** (a handler bug fix, the most routine reconfigure of all) leaves the source
  untouched, so every source digest is unchanged and the ENTIRE stream is valid. The pending
  deployment re-fetches NO history at all; it only re-folds. Maximal sharing.
- **A decode-only source change** (a renamed non-indexed parameter) leaves the topic set unchanged,
  so again the entire stream is valid and only the fold is redone.
- **An event added ABOVE the cursor** creates no deployment at all: `sourceInvalidationOf` already
  calls it free.
- **An event added or edited BELOW the cursor** grafts at that event's `firstBlock` and shares
  everything beneath it.
- **A changed `address` or a new contract** lands in the block-0 SKELETON entry, so the graft point
  is 0 and nothing is shared. This is the rare case, not the representative one.

So the cases that create a deployment mostly share the WHOLE stream, and the expensive work is
re-folding rather than re-fetching. That also bounds open question 3: the pending deployment does
not re-fetch history, so the doubled `eth_getLogs` is only the tail both deployments follow while
one is pending, never a doubled backfill.

**The no-outage value does not depend on sharing at all**: the live deployment keeps answering
regardless. Sharing decides how expensive catching up is, not whether reads survive.

**Prerequisite: `the-stream-is-what-the-node-said-appended-once`.** That spec now delivers segments
that are IMMUTABLE and ADDRESSABLE, which is what a prefix reference needs. It deliberately does not
build sharing; THIS spec owns that, and it is why the prerequisite is declared in `taskedAfter` and
not only in prose. Without it the stream is one blob rewritten per append, there is no prefix to
point at, and every pending deployment copies the whole history.

**Filter provenance is this spec's problem.** A raw-only stream is decode-neutral but not
filter-neutral: absence of a log means something only against the filter its range was fetched under,
and above the graft point the two deployments fetch under different filters. Shared segments
therefore need per-segment filter provenance, owned here.

**Reads do NOT carry deployment identity, and the handle FOLLOWS promotion.** An earlier draft had a
story for a reader knowing which deployment answered it, and an open question about whether that
rode on the handle or on every read return. Both are dropped, because the question dissolves:

- Per-read provenance (changing what the four `StateStore` verbs return) is the only option that
  would have to be decided NOW, since it is a breaking change to the read seam, four backends and
  the conformance suite. It is REJECTED.
- The identity necessarily EXISTS internally, because promotion cannot work without the indexer
  knowing which deployment is live. So exposing it later is purely additive, and a query layer is
  its natural home, as a meta field on the response envelope rather than stapled to every row.
  Nothing here forecloses that.
- What remains is not provenance but LIFETIME, and it is the real defect the review found: the
  entities path publishes a handle bound to a store, so a consumer holding one across a promotion
  would silently keep reading the retired deployment. Fix it by making the handle INDIRECT, a
  reference to whichever deployment is live rather than to a particular one. Promotion then becomes
  transparent to every holder, and the entire staleness class disappears instead of being made
  detectable.

**One mechanism, two runtimes.** The browser case is the stronger one: today a reconfigure blanks the
app. Only the promotion POLICY differs, which is a knob. Two concrete browser gaps remain, and the
reactive shape is not one of them (the root store replaces its value wholesale):

- `createIndexerState` receives ONE pre-built processor with its store already bound, so nothing
  currently owns allocating the pending deployment's store;
- `SyncingState` is a single flat record with one `lastSync` and one `syncPercentage`, which cannot
  express pending catch-up progress, which stories 3 and 4 require.

**Promotion is a step, not a blend.** The cursor jumps. Interpolating would serve a state neither
deployment ever had.

**`ReconfigureOutcome.stateDiscarded` is a published API this design falsifies, and it is owned
here.** It shipped days ago on all three reconfigure verbs and is pinned by roughly 26 assertions
across the core tests and the browser harness. Under a pending deployment neither `updateIndexer`
nor `updateProcessor` discards anything: the live deployment keeps its state throughout, so the flag
collapses to permanently false and stops distinguishing the thing it was added to distinguish. That
is a DELETION SWEEP, not a detail: the reconfigure outcome must grow a shape that says what actually
happened (a deployment was created, or the verdict was a no-op, or `reset` discarded), every
assertion pinning the old flag must be migrated by the task that changes it, and the browser
consumers of `stateDiscarded` in `IndexerState` must move with it. A spec that left this unnamed
would have the first task to trip over it rewrite the corpus by guess.

**`reset` stays an unconditional discard, and it also drops the pending deployment.** It is the one
verb whose caller MEANS discard, so it does not create a deployment. Two consequences to build
deliberately: it discards the pending deployment as well as the live one, and it is the only path
that clears the STREAM, which under sharing is the prefix a pending deployment may be folding from,
so it must not run while a pending deployment depends on it.

**No object owns the live-plus-pending pair today, and something must.** `EthereumIndexer` holds
exactly one processor, one `lastSync` and one `keepStream` key. The spec does not decide whether a
pending deployment is a second `EthereumIndexer` or a container above it, because open question 1
decides it. Server-side `promote` also needs a named surface (an indexer method, or an admin
endpoint on `@etherfold/server`), and it has none.

## Testing Decisions

- **Not-an-outage is the claim, so assert on READS during catch-up**, not on the end state: reads
  succeed continuously across a reconfigure, and answer from the live deployment's state until
  promotion. Assert on the ANSWERS, since reads do not report identity.
- **The no-op claim** asserts on ranges fetched AND on state discarded, the pair ADR-0034
  established, since neither alone separates a resume from a rebuild.
- **Replacement**: reconfiguring twice leaves exactly two deployments and reclaims the first pending
  one's storage.
- **The clamp**: a graft point inside the unconfirmed window is clamped rather than accepted, and a
  reorg above the graft point is handled per deployment.
- **Identity**: an event appended above the cursor does NOT create a pending deployment, which is the
  regression guard for ADR-0034's headline.
- **A processor-only change re-fetches NOTHING**, asserted on the ranges the node was asked for. It
  is the most common reconfigure and the one with the most to share, so it is the sharing test.
- **A handle held across a promotion** keeps answering and answers from the newly-live deployment,
  which is the regression guard for the silent-staleness the indirect handle exists to remove.
- **The reconfigure outcome** says what happened under a pending deployment, and every existing
  assertion on `stateDiscarded` is migrated rather than left inverted.

## Out of Scope

- **N deployments**, rollback, A/B. Reachable later at linear storage cost.
- **Sharing state between deployments.** Not available; each re-folds.
- **Smoothing the promotion step.**
- **Segment pruning**, which belongs with the storage spec.

## Further Notes

Came out of a design conversation about stream branching
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`), which framed the same mechanism
from the storage end. Branching is HOW; this is WHAT it buys.

The Graph is the closest prior art and was drawn on deliberately: grafting is a graft point, a
pending deployment is a pending deployment, promotion is the canonical pointer moving, and the stable
URL is the indirection hiding the switch. This differs in having to work in a browser with no URL and
no operator. The word **deployment** is taken from it too, which also avoids the `version` collision.

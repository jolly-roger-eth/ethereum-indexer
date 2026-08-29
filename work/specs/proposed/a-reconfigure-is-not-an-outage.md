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

<!-- open-questions -->

## Open questions

1. **Does a deployment cover a PROCESSOR change, or only a SOURCE change?** `updateProcessor` on a
   changed version hash clears and reloads today, blanking a browser app exactly as badly as a
   source change, and `ContextIdentifier` keeps `processor` and `config` as identities separate from
   `source`. Covering it is more valuable and strictly larger. (Recommendation: cover it. A
   processor upgrade is the most routine reconfigure there is, and excluding it leaves the headline
   promise false for the common case.)
2. **Does deployment identity ride on the read HANDLE or on every read RETURN?** The handle is cheap
   and covers the js-object path, where there is no read call at all. Per-return touches four
   `StateStore` verbs, `createReadSurface`, `EntityStateView`, `VersionedStateView`, four backends
   and the conformance suite. (Recommendation: the handle.)
3. **Is doubled fetch traffic during catch-up acceptable**, or does the pending deployment need
   throttling or a shared fetch? Two deployments each following the head means roughly two times the
   `eth_getLogs`, which matters in a browser tab and on a rate-limited RPC.

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
- Reads are served by the live deployment throughout, and can ask which deployment answered.
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

Note also that `simple_hash` is a 32-bit non-cryptographic hash. As a change DETECTOR a collision
costs one missed invalidation; as an IDENTITY it would silently adopt another deployment's state.
Identity resting on the verdict rather than on hash equality keeps that exposure where it already is.

## User Stories

1. As an operator, I want to change the source without my server going dark.
2. As an operator, I want to promote deliberately, after seeing the pending deployment has caught up.
3. As a browser user, I want the app to keep rendering while the new deployment builds, and switch
   when it is ready.
4. As a browser developer, I want to turn the auto-switch off and show catch-up progress instead.
5. As a reader, I want to know WHICH deployment answered me.
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
processes reorgs itself. They may briefly disagree; each is internally consistent, both converge, and
reads carry which one answered. The clamp above is what keeps the shared prefix beneath the reorg
window, so no reorg can invalidate bytes both depend on.

**Prefix sharing buys less than the first draft implied, and the feature survives that.** A changed
`address` or a new contract lands in the block-0 SKELETON entry, so the graft point is 0 and nothing
is shared. Two of the three motivating cases therefore re-fetch from the start. **The no-outage
value does not depend on sharing**: the live deployment keeps answering regardless. Sharing is an
optimisation for the cases that have a graft point above 0, chiefly an appended event.

**Prerequisite: `the-stream-is-what-the-node-said-appended-once`.** That spec now delivers segments
that are IMMUTABLE and ADDRESSABLE, which is what a prefix reference needs. It deliberately does not
build sharing; THIS spec owns that, and it is why the prerequisite is declared in `taskedAfter` and
not only in prose. Without it the stream is one blob rewritten per append, there is no prefix to
point at, and every pending deployment copies the whole history.

**Filter provenance is this spec's problem.** A raw-only stream is decode-neutral but not
filter-neutral: absence of a log means something only against the filter its range was fetched under,
and above the graft point the two deployments fetch under different filters. Shared segments
therefore need per-segment filter provenance, owned here.

**One mechanism, two runtimes.** The browser case is the stronger one: today a reconfigure blanks the
app. Only the promotion POLICY differs, which is a knob. Three concrete browser gaps, none of which
is the reactive shape (the root store replaces its value wholesale):

- the entities path publishes a HANDLE with stable identity, so a consumer that cached it would
  silently keep reading the old deployment after promotion;
- `createIndexerState` receives ONE pre-built processor with its store already bound, so nothing
  currently owns allocating the pending deployment's store;
- `SyncingState` is a single flat record with one `lastSync` and one `syncPercentage`, which cannot
  express pending catch-up progress, which stories 3 and 4 require.

**Promotion is a step, not a blend.** The cursor jumps. Interpolating would serve a state neither
deployment ever had.

## Testing Decisions

- **Not-an-outage is the claim, so assert on READS during catch-up**, not on the end state: reads
  succeed continuously across a reconfigure and report the live deployment until promotion.
- **The no-op claim** asserts on ranges fetched AND on state discarded, the pair ADR-0034
  established, since neither alone separates a resume from a rebuild.
- **Replacement**: reconfiguring twice leaves exactly two deployments and reclaims the first pending
  one's storage.
- **The clamp**: a graft point inside the unconfirmed window is clamped rather than accepted, and a
  reorg above the graft point is handled per deployment.
- **Identity**: an event appended above the cursor does NOT create a pending deployment, which is the
  regression guard for ADR-0034's headline.

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

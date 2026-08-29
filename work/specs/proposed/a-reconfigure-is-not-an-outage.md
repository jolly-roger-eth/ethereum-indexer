---
title: 'A reconfigure is not an outage: the old version serves while the new one catches up'
slug: a-reconfigure-is-not-an-outage
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

An indexer has exactly one state, and changing the source mutates it in place. When ADR-0034 says a
change "discards the state and re-indexes from block 0", it means the running indexer has nothing
to answer with until it has caught up again.

On a server that is an **outage**, proportional to the history. On a browser it is a blank app: the
UI reading the state store sees it emptied and refilled. In both cases the operator's only lever is
to not reconfigure.

ADR-0033 and ADR-0034 shrank how OFTEN this happens (a regenerated ABI, an appended event above the
cursor, and a renamed parameter now cost nothing or cost only a re-fold). They did not change what
happens when it does happen, and the remaining cases are the ones that matter most: a new event
below the cursor, a changed address, a new contract.

The mechanism to fix it is not more invalidation cleverness. It is that **an indexer should be able
to hold more than one version at a time**, which is what The Graph does: a new deployment syncs
alongside the old one, and the canonical pointer moves when it is ready.

## Solution

An indexer holds up to **two** versions: the CURRENT one, which answers every read, and at most one
PENDING one, which is catching up and answers nobody.

- Reconfiguring creates a pending version instead of mutating the current one.
- The pending version builds its own state, re-folding from the stream, re-fetching only what its
  source needs that the stream does not already hold.
- Reads are served by the current version throughout, and can ask which version answered them.
- **Promotion** makes the pending version current. It is manual on a server and automatic in the
  browser, with an option to disable the auto-switch and surface "catching up" instead.
- Reconfiguring again while a version is pending REPLACES the pending one. Two versions, never three.

A version is identified by the digest set ADR-0034 already computes. Two sources with identical
digests are the same version, so redeploying an unchanged source is a no-op rather than a rebuild.

Where the new version's `streamHash` set is unchanged, it re-fetches NOTHING and only re-folds. That
is fast in network terms and still O(events) in CPU, so it is not instantaneous and still wants the
pending-version machinery rather than an in-place swap.

## User Stories

1. As an operator, I want to change the source without my server going dark, so that a reconfigure
   is a routine operation rather than a maintenance window.
2. As an operator, I want to promote deliberately, after seeing the new version has caught up, so
   that I choose when readers move.
3. As a browser user, I want the app to keep rendering the old state while the new one builds, and
   switch when it is ready.
4. As a browser developer, I want to turn the auto-switch off and show "catching up" instead, so
   the UI can say what is happening rather than silently stepping.
5. As a reader, I want to know WHICH version answered me, so that a value and its provenance travel
   together.
6. As an operator, I want redeploying an unchanged source to cost nothing at all.
7. As an operator reconfiguring twice in a row, I want the second to replace the first pending
   version rather than accumulating versions.
8. As an operator, I want a version whose stream is unavailable to fall back to a full re-index,
   which is exactly today's behaviour, so the feature degrades rather than breaks.

## Implementation Decisions

**Two versions, not N.** N is not architecturally harder, it is a storage decision: a version's
state cannot be shared. `StateStore` offers `revertTo(keepUpTo)` and capability-gated `asOf` reads
but NO fork, and `revertTo` is destructive, so it cannot produce a branch without destroying the
original. Each version therefore materialises its own state by re-folding from the shared stream,
which costs one full state per version, linearly. Two covers the upgrade case; N buys rollback and
A/B at N times the state storage, and can be added later without redesign.

**The graft point must be FINAL.** A pending version starts from the block its source first differs
at, sharing everything below. If a reorg went below that point it would invalidate bytes both
versions depend on, and a shared immutable prefix has no owner to repair. So the graft point is
clamped to the finalised head. Clamping DOWNWARD is the safe direction, costing redundant fetching
and losing nothing, consistent with the asymmetry the ranged design already documents. In practice
graft points come from historical upgrade blocks and are already final.

**Reorgs are handled per version, independently.** Above the graft point each version follows the
head and processes reorgs itself. They may briefly disagree, and that is acceptable: each is
internally consistent, both converge, and reads carry the version that answered. Independent
handling is much simpler than a shared reorg authority, and the finality rule above is what makes it
safe.

**Promotion is a step, not a blend.** The cursor jumps at the switch. Reads can see values move
discontinuously and the browser UI may need to handle it; that is accepted rather than smoothed,
because interpolating between two versions would mean serving a state neither version ever had.

**This is one mechanism for both runtimes.** It is tempting to treat this as a server feature that
browsers tolerate. The browser case is arguably stronger: today a reconfigure blanks the app, and
the same machinery keeps it rendering. Only the promotion POLICY differs, which is a knob, not a
fork.

**Prerequisite: `the-stream-is-what-the-node-said-appended-once`.** Two versions sharing history is
only cheap if a stream prefix can be shared rather than copied, and today the stream is one blob
rewritten in full on every append, so there is no prefix to point at
(`work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`). That spec
also makes the stream raw-only and therefore version-neutral, which removes the need for per-segment
decode digests here. Without it, every pending version copies the whole history and this design
collapses into "re-index with extra steps".

## Testing Decisions

- **"Not an outage" is the claim, so assert on READS during catch-up**, not on the end state. Reads
  must succeed continuously across a reconfigure, and must report the old version until promotion.
- **The no-op claim** (identical digests cost nothing) asserts on ranges fetched AND on state
  discarded, the pair ADR-0034 established, since neither alone distinguishes a resume from a
  rebuild.
- **Promotion** is observable through `{stateDiscarded}`-style reporting; `reconfigure.test.ts` is
  the prior art for asserting on what a reconfigure reported rather than on what it left behind.
- **Replacement** wants a test that reconfiguring twice leaves exactly two versions and that the
  first pending one's storage is reclaimed.
- **The reorg rule** wants a test that a reorg above the graft point is handled per version, and
  that a graft point inside the unconfirmed window is clamped rather than accepted.

## Out of Scope

- **N versions**, rollback, and A/B. Reachable later at linear storage cost.
- **Sharing state between versions.** Not available; each re-folds.
- **Smoothing the promotion step.**
- **Stream segment pruning**, which belongs with the storage spec.

## Further Notes

Came out of a design conversation about stream branching
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`), which framed the same
mechanism from the storage end. Branching is HOW; this is WHAT it buys, and speccing only the
former would have built the hard half and exposed none of it.

The Graph's model is the closest prior art and was drawn on deliberately: grafting is a graft point,
a pending version is a pending version, promotion is the canonical pointer moving, and the stable
URL is the indirection that hides the switch. Where this differs is that it must also work in a
browser with no URL and no operator.

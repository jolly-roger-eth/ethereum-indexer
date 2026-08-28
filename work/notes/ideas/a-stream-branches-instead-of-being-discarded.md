---
title: 'A stream should BRANCH at the boundary rather than be discarded, which makes "is the cursor past b?" stop mattering'
slug: a-stream-branches-instead-of-being-discarded
---

## The observation

Under the block-ranged model (`work/tasks/ready/abi-versions-are-block-ranged.md`), appending an
event entry at `b` keeps the cached stream when `b` is ABOVE the cursor, and discards everything
when it is at or below. That cliff is an artefact of all-or-nothing invalidation, not a fact
about the data.

Look at what is actually true of the stream when the cursor sits at 900 and you append `B@780`:

- blocks `0..779` were fetched under `{A}`, and `{A}` is the CORRECT and COMPLETE filter for that
  span, because B cannot occur below its own `firstBlock`;
- blocks `780..900` were fetched under `{A}` and are INCOMPLETE, because B's logs were never
  requested.

So the stream is not stale. Only its tail is. The sound operation is to **branch at `b`**: keep
`0..779` verbatim, re-fetch `780..900` under `{A, B}`, and carry on. A full re-index from block 0
re-fetches 779 blocks that were already correct.

That reframes the rule. "Keep the stream if `b` is above the cursor" is the degenerate case of
"branch at `b`", the one where the re-fetch span happens to be empty. With branching there is no
cliff, and the awkward question of whether a developer could have known `b` in advance stops
being load-bearing: it only ever determined how much of the tail is refetched.

## Why it matters most on a live indexer-server

The motivating case is a server that must keep answering while it reconciles. Branching gives you
that directly, if the new stream can share the old one's prefix by REFERENCE rather than by copy:

- the old stream stays intact and keeps serving reads;
- the new stream is built in parallel from the branch point;
- when it catches up, reads cut over;
- the old stream then becomes invalid, or entirely **inert** when the new ABI shares no topics with
  it and nothing of it is reusable.

The cheap-copy requirement is the crux. If a stream is an immutable append-only structure keyed by
block, a branch is a pointer to a common ancestor plus a new tail, and costs nothing. If it is a
monolithic blob, branching degrades into copying and the idea loses its point. So this is really a
question about the stream's STORAGE SHAPE, and that is what would need settling first.

## The state half, which is the harder half

The stream is only half of it. State is a fold over events in order, so inserting B's logs at 780
invalidates state from 780 onward while leaving state at 779 correct. Branching the stream is
therefore only useful if state can be REWOUND to the branch point rather than rebuilt from zero.

This repo may already be most of the way there: the versioned/revertable state store exists, and
`prune-versions-outside-retention-window` plus `retention-capability-and-refusal` define how far
back versions survive. That gives a natural bound: **you can branch cheaply only while `b` is
inside the retention window.** Outside it, you fall back to replaying from the newest snapshot at
or below `b`, and only from block 0 when there is none. Worth noting that the bound is a policy
knob, not a law: retention is the thing that decides how cheap a historical upgrade is.

## Open questions before this could be a spec

- **Stream storage shape.** Is the stream append-only and block-keyed today, and can two streams
  share a prefix without copying it? This decides whether the whole idea is cheap or pointless.
- **What is the branch point exactly?** `b` itself, or `b - 1`? Given the inclusive-overlap rule
  (an upgrade at `b` has the old event live THROUGH `b`), the last wholly-correct block is `b - 1`,
  so the re-fetch span should start at `b`. Worth stating carefully, since this is the same
  off-by-one that loses pre-upgrade logs elsewhere.
- **Reorg window.** Branching assumes the blocks below the branch point are final. If `b` falls
  inside the unconfirmed window this needs care, though in practice `b` is historical.
- **Interaction with retention**, per above: a branch below the window is not cheap and the
  refusal/fallback should be explicit rather than a silent full rebuild.
- **Cutover semantics.** While the new stream builds, reads are served from the old one, which is
  by then known to be missing events. Is that acceptable staleness, or must reads refuse for the
  affected range? This is the same absence-versus-contradiction distinction the reorg model and
  `SuspectedTruncationError` already make, and it should be answered the same way.

## Relationship to what is being built now

Deliberately NOT in `abi-versions-are-block-ranged`, which keeps the simple all-or-nothing rule.
But that task should not build the invalidation in a way that forecloses this, so it carries a
forward-pointer: keep the DECISION (what is no longer valid, and from which block) separable from
the ACTION (discarding everything). If the decision can already name a block, branching is a later
refinement rather than a rewrite.

Also related to the topic-set-versus-hash invalidation follow-up: both are about invalidating with
the granularity the data actually has, instead of hashing the whole source and throwing away
everything on any difference.

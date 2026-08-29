---
title: 'Invalidation is computed on what each thing actually depends on, not on one hash of the whole source'
slug: invalidation-is-computed-on-what-each-thing-depends-on
blockedBy: []
---

## What to build

`abi-versions-are-block-ranged` made invalidation per-event AND per-range, but only for a source
that DECLARES ranges. `sourceHashesOf` still has this at the top:

```ts
if (!sourceDeclaresEventRanges(source)) {
	return [{startBlock: 0, hash: simple_hash(source)}];
}
```

So every source that declares no range — which is every existing deployment, and the common case
the ranged work promised would pay nothing — still hashes the WHOLE source into one entry at block
0. Any difference anywhere in it discards the state and the cached stream and re-fetches all
history.

That is wrong in a way developers meet constantly, because an ABI is usually REGENERATED rather
than hand-edited:

- **adding a view function, an error, or a constructor argument** changes no event and no topic,
  and today costs a complete re-fetch;
- **reordering or reformatting** the ABI array, which regeneration does routinely, likewise;
- **renaming a non-indexed parameter** does not move `topic0`, because the canonical signature
  hashes types and not names, so the FETCH is unaffected even though decoding reads a different
  key.

Two things to build, and the second is the more valuable.

**1. Hash per event whether or not ranges are declared.**

Extend what the ranged path already does to the un-ranged one, so an entry is per (address,
signature, decoding shape) with `startBlock` taken from the contract rather than from a range.
`liveEventsOf` already yields exactly this for both shapes, and `decodingShapeOf` is already the
right unit: it deliberately excludes `internalType`, so a recompilation does not discard a user's
history.

Non-event ABI members must then contribute to NOTHING. A function is not indexed, does not enter
the filter, and cannot change what a log decodes to.

The rest of the source is NOT free, and must keep invalidating: `chainId`, a contract's `address`,
a contract's `startBlock`, and anything else the fetch depends on. Only the ABI's non-event members
become inert.

**2. Split the STREAM verdict from the STATE verdict.**

`sourceInvalidationOf` returns ONE verdict, and `indexerMatches` uses it to gate both the state and
the cached stream (`promiseToLoad`'s `keepStream` branch). Those depend on different things:

- **the stream** is raw logs fetched under a topic-and-address filter. It stays valid when the
  topic set and address set did not GROW. A topic set that shrank leaves a stream that is a strict
  superset, which is reusable: decode less.
- **the state** is a fold over decoded events. It must be recomputed when the decoding shape
  changed, even if not one log needs re-fetching.

So a renamed non-indexed parameter should KEEP the stream and DISCARD the state, which today is not
expressible. Keep `invalidFromBlock` on both halves: `abi-versions-are-block-ranged` established
that the decision can name the block it starts at, and
`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md` needs it to stay that way. Do
not collapse either half into a boolean.

**Traps.**

- **`ContextIdentifier` is PERSISTED.** This changes what is stored, so it needs a migration or a
  tolerant read. A context written by the current code must not be misread as invalid, which would
  silently re-index every existing deployment on upgrade — the exact cost this task exists to
  remove.
- **A source whose events did not change must produce a byte-identical set of entries**, so that
  upgrading the library is not itself an invalidation event.
- **Do not weaken removal.** An event dropped from the ABI must still discard state derived from
  it. The existing `entry-removed` handling covers entries the stored context carries beyond the
  current list; keep it correct under per-event hashing.

## Acceptance criteria

- [ ] Adding a non-event member (function, error, constructor) to an ABI invalidates NOTHING: no state discarded, no range re-fetched.
- [ ] Reordering the events in an ABI invalidates nothing.
- [ ] Reformatting the ABI (whitespace, `internalType` differences) invalidates nothing.
- [ ] Renaming a NON-INDEXED parameter keeps the stream and discards the state, asserted as both: no range is re-fetched, and `{stateDiscarded: true}`.
- [ ] Adding an event discards nothing below its contract `startBlock`, and re-fetches because the topic set grew.
- [ ] Removing an event still discards state derived from it.
- [ ] Changing `chainId`, a contract `address`, or a contract `startBlock` still invalidates as it does today.
- [ ] The verdict carries a STREAM half and a STATE half, each able to name the block it is invalid from.
- [ ] A context persisted by the CURRENT code is still read correctly, or migrated; upgrading the library does not by itself re-index.
- [ ] A source whose events did not change hashes byte-identically across the change.
- [ ] Sources that DECLARE ranges keep every behaviour `abi-versions-are-block-ranged` established, including the redundant-append no-op.
- [ ] Tests cover the new behaviour in the repo's vitest style, asserting re-fetch on the ranges the node was asked for.
- [ ] A changeset covers the behaviour change.

## Blocked by

- None. `abi-versions-are-block-ranged` and `a-range-requests-only-the-events-it-can-contain` have
  both landed, and this generalises the first.

## Prompt

> Make invalidation depend on what each thing actually depends on, in the `etherfold` monorepo,
> instead of one hash over the whole source.
>
> FIRST, check this against current reality. The claim is that `sourceHashesOf` in
> `packages/core/src/internal/engine/eventRanges.ts` still short-circuits to
> `[{startBlock: 0, hash: simple_hash(source)}]` when `sourceDeclaresEventRanges(source)` is false,
> so every source without declared ranges hashes wholesale; and that `sourceInvalidationOf` in
> `internal/engine/utils.ts` returns one verdict that `indexerMatches` uses to gate BOTH the state
> and the kept stream. Verify both before building. If either has changed, route to
> needs-attention.
>
> The user-visible point is that an ABI is REGENERATED, not hand-edited. Adding a view function
> today costs a complete re-fetch of all history, and nothing about that function can affect a log.
> Hash per event on both paths, using the `liveEventsOf` and `decodingShapeOf` units that already
> exist, and let non-event ABI members contribute to nothing. Do NOT make the rest of the source
> free: `chainId`, contract `address` and contract `startBlock` must still invalidate.
>
> The more valuable half is splitting the STREAM verdict from the STATE verdict. The stream is raw
> logs fetched under a topic-and-address filter, so it survives when the topic set did not grow; a
> shrunken topic set leaves a superset, which is reusable. The state is a fold over decoded events,
> so it must be recomputed whenever the decoding shape changed even if nothing needs re-fetching. A
> renamed non-indexed parameter is the case that proves it: `topic0` hashes types and not names, so
> the fetch is untouched and the decode is not.
>
> Keep `invalidFromBlock` on BOTH halves. `abi-versions-are-block-ranged` deliberately made the
> decision able to name the block it starts at, and
> `work/notes/ideas/a-stream-branches-instead-of-being-discarded.md` depends on that staying true.
> Do not collapse either half into a boolean.
>
> `ContextIdentifier` is PERSISTED, so this is a stored-format change. It needs a migration or a
> tolerant read, and a context written by today's code must not read as invalid — that would
> silently re-index every existing deployment on upgrade, which is precisely the cost this task
> removes. Assert it: write a context with the current shape, read it with the new code, expect no
> invalidation.
>
> Add a changeset. Record any non-obvious in-scope decision in a `## Decisions` block in your final
> report, and do not commit without confirmation.

## Decisions

**The kept stream is RE-DECODED on replay, unconditionally.** The task frames the stream as "raw logs", but in this codebase a cached `LogEvent` is the raw log (`topics`, `data`, `address`) *plus* `args`/`eventName`, which is what some earlier ABI made of it. Keeping the stream across a renamed non-indexed parameter and replaying the stored `args` would rebuild the state out of keys the current ABI does not have: correct-looking and silently derived from a contract description no longer in force. So `LogEventFetcher.reparse` (new; `decodeOnto` extracted so the fetch path and the replay decode through one rule) re-decodes the stream against the source running now, before anything reaches the processor. Unconditional rather than "only when the shape moved", because a stream file carries ONE context for events appended across several sources, so it cannot answer that per event. Alternatives considered: conditional re-decode (defeated by that shared context) and not keeping the stream when the decode moved (fails the acceptance criterion, and gives up the case that motivates the split). Where a `logValues` projection dropped the raw log there is nothing to re-read, so the stream is CLEARED rather than replayed on trust. Touches `keepStream` for every deployment, and `ExistingStream` implementors, whose stored bytes are unchanged.

**Entries are compared as a SET DIFF, not element-wise by index.** By-index was workable while entries were per-range and ordered by `startBlock`; it is not now that an un-ranged source puts every event at the same block, since an insertion shifts whatever sorts after it and every shifted entry would read as a change to something already indexed. Consequence worth naming: an entry EDITED *above* the cursor now costs nothing where by-index it invalidated. That is correct (nothing above the cursor was indexed, so nothing derived from it is stale) but it is a behaviour change beyond the stated criteria. Touches every `abi-versions-are-block-ranged` behaviour, all of which still pass unchanged.

**`legacyHash` is persisted on the block-0 entry, forever.** It is the only way a stored whole-source digest can be compared at all, and a caller cannot forget to supply it. It is deliberately NOT part of the identity invalidation reads, and it is the one field that moves when a regenerated ABI gains a view function, so the "byte-identical entries" claim is about `{startBlock, hash, streamHash}`. Alternative considered: a fifth parameter to `sourceInvalidationOf`, rejected as a footgun whose failure mode is a silent re-index of every deployment.

**The stream half is entry-level, not coverage-level.** "The topic set did not grow" is decided by whether any current `streamHash` is absent from the stored set, so a NARROWED range reads as a new entry and invalidates the stream even though it is a subset. Reasoning about coverage is unreachable, not undesirable: a stored entry is an opaque digest, so a subset relation cannot be recognised. Conservative, therefore safe, and strictly better than the previous behaviour.

**`wireContextOf` is left on the whole-source hash.** It is an identity check between the two halves of a split deployment computing the same thing from the same declarations (ADR-0004), not a question about what a stored context covers. The server-side `StreamBuilder` therefore still gets the all-or-nothing answer, through the same code path via the both-sides-legacy branch. Touches `agnostic-log-fetcher` / `ingest-wire-receiving-side`: bringing the server split onto per-event invalidation is a separate, wire-format-visible change.

---
title: 'An ABI event is live over block ranges, so an upgrade appends an entry instead of re-fetching history'
slug: abi-versions-are-block-ranged
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: [an-event-is-never-silently-dropped-from-the-fetch-filter]
covers: [1, 2, 3, 4, 5, 6, 7, 10]
---

> **RE-SCOPED 2026-08-28, and the spec is STALE on this point.** The first version of this
> task built per-range ABI BUCKETS and gave `parse()` a block axis, so that a log decoded
> with "the ABI live at its block". That model is now REJECTED, and
> `work/specs/tasked/an-upgraded-contract-is-indexable-from-its-first-block.md` still
> argues for it. Where the spec and this task disagree, THIS TASK WINS; read the spec for
> background only.
>
> Why it was rejected, in one line each. The boundary block is **unknowable in advance**,
> so a live indexer can never fill it in. And it is **not block-granular anyway**: the
> upgrade transaction sits mid-block, so logs before and after it share a block and no
> block boundary can separate them. Meanwhile the boundary was never needed for DECODING:
> two versions with different signatures have different topic0s and are told apart on the
> wire, and two versions sharing a topic0 cannot be told apart by a boundary either, so
> that case stays refused. **There is no block axis in `parse()`. Decoding is by topic0,
> exactly as it is today.**
>
> What the block ranges are ACTUALLY for is the FETCH FILTER, and the incremental
> invalidation that follows from it.

## What to build

An event is a fact about a contract **over block ranges**. A source carries event entries,
each declaring the range it is live over, and the indexer uses those ranges for two things
and no others: which topics to request for a given block range, and whether a source change
can be absorbed without re-fetching.

**1. The range fields, which are NOT `startBlock`.**

Each event entry carries `firstBlock` (inclusive, the earliest block it can appear in) and
an OPTIONAL `lastBlock` (inclusive, the latest). Omitting `lastBlock` means open-ended.

`firstBlock`/`lastBlock` are inclusive **on purpose**, and the naming is load-bearing. For
an upgrade at block `b`, the correct declaration is `A.lastBlock = b` together with
`B.firstBlock = b`: the SAME number on both, because a transaction earlier in block `b` can
still fire A while the upgrade transaction later in that block starts B. **A one-block
overlap at an upgrade is CORRECT and expected, not a conflict to normalise away.** An
exclusive end would make the correct declaration read `b + 1`, and the obvious thing to
type would silently drop every pre-upgrade log in block `b`. Do not "fix" the overlap.

Do NOT reuse `startBlock`, and do not let these fields reach `defaultFromBlockOf`. Per-contract
`startBlock` already means "do not look before here" and is MINIMISED across entries
(measured: entries at 0 and 500 yield 0), so a per-event range sharing that name or shape
would silently drag `defaultFromBlock` down.

**2. Normalisation, which is what makes a naive generator cheap.**

Whatever generates the source usually cannot tell an upgrade from a cancellation: it sees a
proxy upgrade, appends an entry, and on a rollback appends another. So a source can legitimately
read `[A@a, B@b, A@c]`. Normalise before doing anything else, grouping by event identity
(topic0 plus identical definition):

- if ANY occurrence of that event is open-ended, it is live from the MINIMUM `firstBlock`
  onward, and every later occurrence is absorbed;
- if EVERY occurrence has a `lastBlock`, the event is live over the union of those ranges.

So `[A@a, B@b, A@c]` with no `lastBlock` anywhere normalises to A live from `a` and B live
from `b`. The rollback entry vanishes. That is the SAFE reading as well as the simple one:
if A really was dead between `b` and `c`, keeping it in the filter over that gap costs a
little fetching and loses nothing.

**Refuse a GAP.** If consecutive live ranges for one event leave a hole (`A.lastBlock <
B.firstBlock - 1`), that hole is a span where the event is requested by nobody, which is
silent loss. Refuse it at construction, naming the event and the hole. Overlap is fine;
a gap never is.

**3. Invalidation computed on the NORMALISED form.**

The decision rule already exists in `indexerMatches`: an entry the stored context lacks
forces a reset only when it starts at or below the cursor. Verified against it, cursor at 500:

|                                              |            |
| -------------------------------------------- | ---------- |
| append an entry at block 900                 | keep state |
| append at block 400                          | re-index   |
| edit the entry below the cursor              | re-index   |
| today: any ABI change, whole source rehashed | re-index   |

What is missing is the PRODUCER: `reinit` collapses the list to
`[{startBlock: 0, hash: simple_hash(source)}]`, marked `// TODO handle history (in reverse
order)` at both call sites.

Feed that rule from the NORMALISED ranges, not the raw list. This is load-bearing: `indexerMatches`
compares element-wise BY INDEX, so appending the redundant `A@c` above would shift the list and
force a full re-index even though the normalised coverage is byte-identical. Normalised, that
append is a genuine no-op: same topics, same ranges, nothing re-fetched, nothing re-derived.
A generator that cannot recognise a rollback must not cost the user their whole history.

Note `indexerMatches` gates the STREAM cache too (`promiseToLoad`'s `keepStream` branch), so
getting this right means an append above the cursor re-fetches nothing, not merely that it
re-derives nothing. That is the headline benefit and it should be the headline test.

**4. Fetch narrowing.**

A range requests only the events live over it. Below `B.firstBlock`, B's topic0 is absent;
above `A.lastBlock`, A's is. An event with NO `lastBlock` is never dropped at any height above
its `firstBlock`.

This saves twice. **Request count**, measured here: `generateLogRequestForTopicsAndFiltersCombinations`
puts every topic in ONE request when no argument filters are configured, but emits one request
per (event topic × filter), run sequentially, when they are. The browser shape uses filters.
**And the node's own work**, which applies even in the single-request case: a topic that cannot
match still costs the node, because block screening is done against the header `logsBloom` and
topics are OR'd at position 0, so each extra topic widens the set of blocks that pass the screen
and so the set whose receipts are loaded and scanned, plus its own bloom false positives. That
second mechanism is how nodes implement the method and is **not measured in this repository**.
Do not cite it as one of ours; if you want a number, measure it against a real node and record
a finding.

A fetch range crossing a boundary may simply use the union for that range; splitting is cheap
because boundaries are rare.

**Two traps beyond the `startBlock` one.**

- **A source with no ranges must behave exactly as it does today.** No existing deployment
  changes behaviour merely by upgrading.
- **`ContextIdentifier` is PERSISTED.** Changing the shape of `sourceHashes` is a stored-format
  change, so it needs a migration or a tolerant read, not just a type edit.

## Acceptance criteria

- [ ] An event entry carries an inclusive `firstBlock` and an optional inclusive `lastBlock`, in fields that are NOT `startBlock`.
- [ ] For an upgrade at `b`, `A.lastBlock = b` and `B.firstBlock = b` is accepted, and block `b` requests BOTH topics. The one-block overlap is preserved, not collapsed.
- [ ] `[A@a, B@b, A@c]` with no `lastBlock` normalises to A live from `a` and B live from `b`.
- [ ] Appending that redundant third entry re-fetches nothing and discards nothing: asserted on the ranges the node was asked for, and on `{stateDiscarded: false}`.
- [ ] Appending an entry ABOVE the cursor keeps the state: `updateIndexer` reports `{stateDiscarded: false}`.
- [ ] Appending above the cursor re-fetches NOTHING, asserted on the ranges the node was asked for, since state alone cannot distinguish a resume from a re-index.
- [ ] Appending AT or BELOW the cursor discards and re-indexes from the start block.
- [ ] Editing an entry already below the cursor discards, even though the list length did not change.
- [ ] A range below `B.firstBlock` does not carry B's topic: with argument filters configured it issues no request for it, and without filters it is absent from the single request's topic set.
- [ ] An event with no `lastBlock` is present in the requested topics at every height above its `firstBlock`.
- [ ] A GAP between consecutive ranges for one event is refused at construction, naming the event and the uncovered span.
- [ ] A source declaring no ranges behaves exactly as today.
- [ ] `defaultFromBlock` is unaffected by any range and still derives from contract `startBlock` alone.
- [ ] Decoding is unchanged and has NO block axis: a pre-upgrade log decodes as A and a post-upgrade log as B, by topic0 alone.
- [ ] A true topic0 collision is still refused, on every path, identically with and without `parseAllEventsIrrespectiveOfAddresses`.
- [ ] The two asymmetries are documented where a developer picks the numbers: `firstBlock` too EARLY is safe and too LATE loses logs undetectably; `lastBlock` too LATE is safe and too EARLY loses logs undetectably; and a `lastBlock` is an assertion the indexer cannot verify.
- [ ] Existing persisted `ContextIdentifier` values are still readable, or migrated.
- [ ] Tests cover the new behaviour in the repo's vitest style.
- [ ] A changeset covers the public API change to the source type.

## Blocked by

- `an-event-is-never-silently-dropped-from-the-fetch-filter`. **Hard dependency, and it is the
  reverse of what this task said before the re-scope.** With no per-range buckets, two versions
  of one event land in the SAME ABI list, where `deleteDuplicateEvents` keys on NAME and either
  throws `two events with same name but different inputs` or silently splices one out. Until
  that is one loud rule keyed on topic0, no source carrying two versions can be constructed at
  all, and this task cannot be built.

## Prompt

> Make an event's ABI live over BLOCK RANGES in the `etherfold` monorepo, so that an upgrade
> appends an entry instead of re-fetching all history, and so that a range requests only the
> events that can occur in it.
>
> READ THE RE-SCOPE NOTE AT THE TOP OF THE TASK FIRST. The spec
> `work/specs/tasked/an-upgraded-contract-is-indexable-from-its-first-block.md` still argues for
> per-range ABI buckets and a block axis in `parse()`. That model was rejected: the boundary is
> unknowable in advance for a live indexer, and is not block-granular anyway because the upgrade
> transaction sits mid-block. Decoding stays exactly as it is, by topic0, with NO block axis.
> Where the spec and the task disagree, the task wins.
>
> FIRST, check the task against current reality. It rests on readings taken during a design
> conversation: that `ContextIdentifier.source` is already `{startBlock, hash}[]`; that
> `indexerMatches` already returns keep/re-index correctly for append-above, append-below and
> edit-below; that `reinit` collapses the list behind a `// TODO handle history (in reverse
> order)`; that `defaultFromBlockOf` takes the minimum across entries; and that
> `generateLogRequestForTopicsAndFiltersCombinations` emits one request per (topic × filter) only
> when argument filters are configured. Re-run these rather than trusting them. If one has
> changed, route to needs-attention rather than building on a stale premise.
>
> The headline is NOT that state survives; it is that NOTHING IS RE-FETCHED. `indexerMatches`
> gates the kept event stream as well as the state. Assert it on the RANGES the node was asked
> for: a re-index and a resume land on identical rows, so state cannot tell you which happened.
> The recording fake chain in `packages/browser/browser/workload.ts` is the prior art, and
> `packages/browser/test/reconfigure.test.ts` established `{stateDiscarded}` as the observable.
>
> Get the INCLUSIVE boundary right, because the off-by-one silently loses logs. An upgrade at
> block `b` is declared `A.lastBlock = b` AND `B.firstBlock = b`, the same number twice, because a
> transaction earlier in block `b` can still fire A. That one-block overlap is correct; do not
> collapse it, and do not switch to an exclusive end, which would make the correct declaration
> read `b + 1` and the obvious thing to type lose the pre-upgrade logs in block `b`.
>
> Normalise before anything else, because the system generating the source usually cannot tell an
> upgrade from a cancellation and will just append. Group by event identity: if any occurrence is
> open-ended the event is live from the minimum `firstBlock` onward and later occurrences are
> absorbed; otherwise take the union of the ranges. Then compute invalidation on the NORMALISED
> form, not the raw list. `indexerMatches` compares element-wise BY INDEX, so a redundant append
> would otherwise shift the list and re-index the world. Refuse a GAP between consecutive ranges
> for one event, naming the event and the uncovered span, since a hole is a span nobody requests.
>
> Do NOT reuse `startBlock` for these fields, and keep them out of `defaultFromBlockOf`, which
> minimises across entries. Remember `ContextIdentifier` is persisted, so a shape change needs a
> migration or a tolerant read. And a source declaring no ranges must behave exactly as it does
> today.
>
> Do the fetch narrowing LAST, because it needs the ranges to exist first. It saves in request
> COUNT where argument filters are configured, and in the NODE's own work in every case, since a
> topic that cannot match still widens the `logsBloom` screen. That second mechanism is NOT
> measured in this repository; do not present it as one of our measurements, and if you want a
> number, measure it against a real node and record a finding.
>
> Add a changeset for the source type change. Record any non-obvious in-scope decision in a
> `## Decisions` block in your final report, and do not commit without confirmation.

---
title: 'An ABI event is live over block ranges, so an upgrade appends an entry instead of re-fetching history'
slug: abi-versions-are-block-ranged
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: [an-event-is-never-silently-dropped-from-the-fetch-filter]
covers: [1, 2, 3, 4, 5, 6, 7]
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

> **SPLIT 2026-08-28.** The fetch narrowing that used to be part four of this task is now its own
> task, `a-range-requests-only-the-events-it-can-contain`, BLOCKED BY this one. It was always
> "last, because it needs the ranges to exist first", and separating it keeps this diff reviewable.
> This task therefore declares the ranges and uses them for INVALIDATION only. It does NOT change
> what the fetcher requests: until the follow-up lands every range still carries every topic, which
> is wasteful but correct, and no existing behaviour regresses.

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

> **FORWARD-POINTER: keep the DECISION separable from the ACTION.** This task keeps the simple
> all-or-nothing rule (append at or below the cursor discards everything and re-indexes from the
> start block), and that is deliberate. But a later refinement wants to BRANCH the stream at the
> boundary instead: when the cursor is at 900 and you append `B@780`, blocks `0..779` were fetched
> under the correct and complete filter, so only `780..900` actually needs re-fetching. See
> `work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`.
>
> Do not build that here. DO shape the invalidation so it stays reachable: the code that DECIDES
> should be able to say "invalid from block N", even if the only thing acting on it today is
> "therefore discard everything". Do not collapse the decision into a bare boolean, and do not
> bury "re-index from the start block" inside the comparison itself. If the decision can name a
> block, branching is a later refinement; if it cannot, branching is a rewrite.

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
- [ ] A GAP between consecutive ranges for one event is refused at construction, naming the event and the uncovered span.
- [ ] A source declaring no ranges behaves exactly as today.
- [ ] `defaultFromBlock` is unaffected by any range and still derives from contract `startBlock` alone.
- [ ] Decoding is unchanged and has NO block axis: a pre-upgrade log decodes as A and a post-upgrade log as B, by topic0 alone.
- [ ] A true topic0 collision is still refused, on every path, identically with and without `parseAllEventsIrrespectiveOfAddresses`.
- [ ] The two asymmetries are documented where a developer picks the numbers: `firstBlock` too EARLY is safe and too LATE loses logs undetectably; `lastBlock` too LATE is safe and too EARLY loses logs undetectably; and a `lastBlock` is an assertion the indexer cannot verify.
- [ ] Existing persisted `ContextIdentifier` values are still readable, or migrated.
- [ ] Tests cover the new behaviour in the repo's vitest style.
- [ ] A changeset covers the public API change to the source type.
- [ ] The invalidation decision can name the block from which the stored data stopped being valid, even though the only action taken on it here is a full discard. This is what keeps stream branching a later refinement rather than a rewrite; see the forward-pointer above.

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
> Do NOT narrow the fetch filter here. That is `a-range-requests-only-the-events-it-can-contain`,
> a separate task blocked by this one. Declaring the ranges and using them for invalidation is the
> whole of this task; every range still carrying every topic is wasteful but correct, and the
> follow-up is what makes it cheap.
>
> Add a changeset for the source type change. Record any non-obvious in-scope decision in a
> `## Decisions` block in your final report, and do not commit without confirmation.

## Decisions

**The ranges live on the ABI EVENT ENTRIES, not on a per-contract ABI-version list.** `[A@a, B@b, A@c]` is then literally the ABI list, which is what the task's normalisation rule and its per-event gap refusal are phrased against. Alternative considered: generalising the (unused) `ContractData.history` into `{abi, firstBlock, lastBlock}[]`, which keeps the generated ABI untouched but groups by version and risks re-meaning the per-range ABI *buckets* the re-scope rejected. Cost of my choice: an author must write `satisfies RangedAbi` instead of `satisfies Abi`, and a generator post-processes the compiler's ABI. Touches: the public source type, and `a-range-requests-only-the-events-it-can-contain`, which reads the same normalised output.

**`ContractData.history` is REMOVED.** It was the never-implemented `{abi, startBlock}[]` placeholder for exactly this feature, keyed on the one field name the task forbids, consumed by nothing. Alternative: leave it, which means two overlapping concepts and a field a user can declare to no effect. Touches: the public source type (in the changeset).

**A stored entry the source no longer declares now invalidates**, if it sits at or below the cursor. The element-wise loop never looks past the current list, so a ranged source that dropped its last event would have kept state derived from an event it stopped indexing — a regression against today, where any removal moves the whole-source hash. Unreachable for a source with no ranges (one entry, caught at index 0). Alternative: leave the asymmetry, which is silently wrong in the unsafe direction.

**Two new refusals at construction**, beyond the gap: `lastBlock < firstBlock`, and a block number that is not a whole non-negative integer. Both are empty or nonsensical ranges, the same "a span nobody requests" family as the gap. Alternative: coerce or ignore, which converts a typo into silent loss.

**`wireContextOf` is deliberately NOT ranged**, so the server split (`LogFetcher`/`StreamBuilder`) keeps the single whole-source wire identity and does not yet get incremental invalidation. Ranged entries there would change the ADR-0004 `{source, config}` digest and its `409`/context-mismatch surface, which is a wire-contract decision this task should not make. `captureStream` DOES use the ranged producer, because that one is compared against the indexer's own list and a captured fixture for a ranged source would otherwise be silently rejected.

**Ordering ties are broken by hash.** Two entries with the same `firstBlock` sort deterministically but arbitrarily, so appending one at a block that already has an entry can shift and force a conservative re-index even above the cursor. Alternative: a set-keyed comparison, which the task explicitly steers away from ("`indexerMatches` compares element-wise BY INDEX ... normalise so it does not shift"). The failure mode is a needless re-index, never a missed one.

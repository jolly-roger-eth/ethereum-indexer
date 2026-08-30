---
title: 'Appending to the stream costs the batch, not the history'
slug: appending-to-the-stream-costs-the-batch
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **SPLIT out of `the-stream-is-what-the-node-said-appended-once` after four review rounds.** That
> spec bundled two changes. This half (segments, ordering, `clear`, the `lastSync` key) was stable
> and correct from its second draft and never re-broke. The other half (making the stream raw-only)
> produced a new blocker every round, because it is a breaking public API change entangled with a
> third seam implementation. It is now `the-stream-stores-only-what-the-node-said`, which is
> `taskedAfter` this one. **This spec changes no published type.**

## Problem Statement

Both stream keepers persist the WHOLE stream under one key and rewrite it on every append.
`packages/fs/src/storage/stream/OnFile.ts` and `packages/browser/src/storage/stream/OnIndexedDB.ts`
are the same shape:

```ts
const existingStream = await get<StreamData<ABI>>(storageID);
const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
```

Every save reads the entire accumulated stream into memory, concatenates, and serialises all of it
back, so ingesting a batch at height N costs proportional to everything already stored and a
backfill degrades **quadratically**. `save` runs once per `indexMore`, so this is per batch, not per
session. On IndexedDB it is a full structured-clone each time.

Each `saveNewEvents` is a three-branch function, and one branch matters beyond the headline: when
the incoming batch is EMPTY it still rewrites the whole existing stream, purely to update
`lastSync`. So the cost is paid even by a save that has no events to add.

None of this involves upgrades, versioning or decoding. It is true on a first sync today.

## Solution

**The stream is append-only.** Events are written in segments that are never rewritten. Appending
costs the size of the batch.

**Segments are keyed by an ORDINAL index, not by a block range.** Forced, not stylistic: the stored
stream is an EMISSION stream, so on a reorg the indexer re-appends the superseded events carrying
their ORIGINAL `blockNumber` and flagged `removed` (`internal/engine/utils.ts:188`), then continues
at LOWER block numbers. Block ranges therefore overlap, can collide on a key, and a block-ordered
read would replay retractions out of append order.

ADR-0006 is cited for its ORDERING argument only: `(blockNumber, logIndex)` is neither unique nor
monotonic over an emission stream, so it cannot key one. Its `seq` is a SERVER concept that exists
so a query consumer has a cursor; this is a client cache with no consumer, read in bulk, and nothing
client-side assigns a per-event sequence. Do not invent one, and do not import the rest of ADR-0006
(its two views, its cursor validation, its compaction) into a cache that has none of those problems.

**Segments are a WRITE-path optimisation; the read stays a full ordered scan.** Since a LATER
segment can hold LOWER block numbers, no segment can be skipped on a block bound. So
`fetchFrom(source, fromBlock)` KEEPS its signature and semantics: read every segment in ordinal
order, concatenate, apply the existing `blockNumber >= fromBlock` filter. A spec implying segments
make READS cheaper would promise what the reorg model forbids.

**A save writes exactly ONE key, and `lastSync` rides in the OPEN TAIL segment.** An earlier draft
gave `lastSync` its own key, which quietly turned one write into two and destroyed an atomicity the
current code has by construction. Both orders are wrong: writing the segment first leaves the cursor
BEHIND its events, so a rebuild replays them and then re-fetches from the stale `lastToBlock` and
appends duplicates; writing `lastSync` first leaves the cursor AHEAD, so a lost segment is never
replayed. Today one `set` makes the two agree and a crash cannot separate them.

So the shape is an append-only log with an OPEN TAIL:

- the newest segment is OPEN and carries both its events and the `lastSync` current after them;
- a save appends to the open tail, which is ONE write, bounded by the tail's size and never by the
  history;
- the tail is SEALED when it exceeds a size threshold, and the next save starts a new one;
- **a sealed segment is immutable forever.**

This is what makes the empty-batch case cheap without needing a rule against empty segments: a save
with no events rewrites only the open tail to move its cursor, which is bounded, rather than
rewriting the whole history as it does today.

**Sealing is not a write, and the cursor is read from the TAIL alone.** A segment is SEALED exactly
when it is no longer the highest ordinal, so sealing happens implicitly the moment the next save
opens a new one, and a reader tells by enumeration. Nothing is ever written INTO a segment to mark
it sealed, which is what keeps both the one-write claim and immutability true. Every sealed segment
still carries the `lastSync` that was current when it was written, and those are STALE: the cursor is
read from the tail only, or a reader picking a lower one silently rewinds.

**The TAIL is the highest ordinal segment, OR the adopted legacy key when no ordinal exists.** This
sentence is load-bearing and its absence would have failed this spec's own migration test. Between
adopting a legacy blob (below) and the first new save there are NO ordinal segments at all, so a
tail defined purely as "the highest ordinal" would not exist: presence would read false, the cursor
would be unread, and `indexer.ts` would clear a perfectly good cached history, which is exactly what
story 5 forbids. The adopted legacy key is therefore the tail until `_0` is opened, at which point
it becomes sealed like any other.

The seal threshold is counted in **EVENTS**, not bytes. Bytes are natural on the filesystem (the JSON
string is already built) and not cheaply available on IndexedDB (structured-clone size is not
exposed), so naming the unit is what stops the two keepers choosing differently and makes the seal
test deterministic.

**Presence is the TAIL, never a segment count.** `fetchFrom` must keep returning a DEFINED result
for a stream that has been saved to but holds no events, because today an empty first save writes
`{lastSync, eventStream: []}` and a defined result is what stops `indexer.ts` taking its clear
branch. A tail exists as soon as anything has been saved, so presence is the tail's existence.

**Sealed segments are immutable and independently readable**, and both halves are stated so a test
can FAIL them. Immutability is observable at the write seam: no write ever targets a sealed
segment's key. Independent readability means any sealed segment is readable BY ITS OWN KEY without
reading the others, which is the criterion that bites where "addressable" would not, since any keyed
store satisfies being nameable. These are REQUIREMENTS here, not aspirations: a later design that
wants to share a prefix by reference has nothing to point at without them.

## User Stories

1. As a developer doing a long backfill, I want the cost of a save to be bounded by a FIXED CEILING
   that does not grow with my history, so a large history does not slow its own ingestion. (Not
   "every append costs the same": a save rewrites the open tail, so it costs at most one tail plus
   its batch. That is constant in history, which is the whole claim, and it is what the title means
   by costing the batch rather than the history.)
2. As a browser user, I do not want a full structured-clone of my entire history on every save.
3. As a developer, I want a save with no new events to cost nothing proportional to my history.
4. As a developer replaying a reorged history, I want retractions to come back in the order they were
   appended, so a rebuild sees what the live run saw.
5. As a developer, I want an existing persisted stream to keep working, or be rebuilt deliberately
   and visibly, so upgrading costs nothing I can notice and nothing I cannot explain.
6. As a developer clearing a stream, I want ALL of it gone, so no fragment survives to be replayed
   into a later rebuild.
7. As a maintainer, I want a sealed segment never rewritten and readable on its own, so a later
   design can refer to a prefix instead of copying it, without this spec having to build that.

## Implementation Decisions

**`clear` is a first-class part of this change.** `ExistingStream` has THREE members and `clear` is
the one segmentation breaks: today it deletes a single storage id, and with N segment keys a naive
port would orphan every segment but one, after which the next `saveNewEvents` appends beside a dead
prefix and the next `fetchFrom` concatenates it into the replay, producing wrong state SILENTLY. It
is called from five paths in `indexer.ts`, and both the migration below and ADR-0034's mandated
clearing rest on it.

**Enumerate the segments; do not reach for a head pointer.** An earlier draft asserted that neither
keeper can list keys and therefore needed a head key naming the highest ordinal. That premise was
FALSE, and it was inferred from an import line rather than from the substrate:

- `idb-keyval` ships `keys`, `getMany`, `setMany`, `delMany` and `clear`. `OnIndexedDB` imports only
  `get`/`set`/`del`. `delMany` is ONE transaction, so a segmented `clear` is atomic.
- `packages/fs/src/utils/fs.ts` is OUR file and exposes `get`/`set`/`del` because that is all it has
  needed; a `readdir` is three lines away.

Enumeration is also STRICTLY BETTER than a head pointer, which is why this is a decision and not
just a correction. A head is a second thing that can disagree with the segments, and it cannot detect
a partial clear: a head saying N over segments that are gone reads as holes. Enumerating the ordinals
and checking they are CONTIGUOUS detects exactly that, and turns a silent truncation into a refusal.

If a head pointer is used anyway for some reason, the delete order is head FIRST, segments after,
because the head is the root pointer and orphans left unreachable are harmless while a head over
missing segments is not. An earlier draft had this backwards.

**A partial or interrupted clear is REFUSED, not tolerated.** A gap in the ordinals means a fragment
was lost, and "some of the stream" replayed as if it were "the stream" is the same silent-absence
failure class the reorg model and `SuspectedTruncationError` already refuse. Detect the gap and
clear the remainder rather than replaying it.

**The migration ADOPTS the legacy key as a sealed segment rather than rewriting it.** The stream blob
carries no format field (unlike the fixture's `format: 2`), so the old single-blob shape is
recognised structurally. But a migration that COPIED it into segments would need two writes, and the
crash window between them is exactly the cursor-ahead/cursor-behind hazard the open tail exists to
close — and a reader finding BOTH shapes would have no defined behaviour, double-counting the prefix
or dropping it.

So the legacy key `stream_<name>_<chainId>` (no ordinal) is ADOPTED IN PLACE as the earliest sealed
segment: never rewritten, read first, and followed by `_0.._N`. Nothing is copied, the first save
after an upgrade writes only the new tail, and the one-write rule holds through the migration rather
than being suspended for it. `clear` removes it along with the ordinals. Its `lastSync` is stale like
any sealed segment's, so the cursor still comes from the tail.

The rebuild story 5 asks to be VISIBLE needs an owner too: a clear or a migration should say so
through the existing logger rather than happening in silence. Where ADR-0034 already MANDATES clearing (a legacy blob whose
raw half a `logValues` projection dropped, so it cannot be re-read), that mandate WINS: clearing a
stream that cannot be re-read is correct and is not a silent clear. What is forbidden is clearing a
READABLE stream merely because its shape is old.

**The segmentation rules live in ONE place, not in each keeper.** Ordinal naming, the anchored match,
the contiguity refusal, the seal decision, legacy adoption and cursor selection are identical for
both keepers and are the whole substance of this change. `OnFile` and `OnIndexedDB` are independent
implementations of `ExistingStream` in different packages, so a task cut per keeper would
re-implement the same prose twice and drift. Put the rules in an internal core helper parameterised
over a `get`/`set`/`del`/`keys` port, and let each keeper supply the port. That also gives the
module-mocking seam below one place to bite.

One consequence to accept deliberately: core's `exports` map is only `.` and `./package.json`, so a
helper under `src/internal/` is unreachable from `packages/fs` and `packages/browser` unless
`index.ts` re-exports it. So "internal" here means convention rather than unreachability, and the
export line is published surface that needs a changeset. That is a real cost against this spec's
no-published-type promise, accepted because the alternative is two keepers drifting on the rules that
ARE this change. Dependency direction is otherwise clean: both keepers already import
`@etherfold/core`, and core imports neither.

**Segment size follows the batch, with one caveat.** The `streamNotYetSaved` accumulator buffers
across failed saves, so what lands in the tail at a given save is whatever was buffered then, not
necessarily one batch. Sealing is by size threshold, so this affects when a seal happens and nothing
else.

**Enumeration must match an ANCHORED pattern, not a prefix, because a bare prefix collides across
CHAINS.** Stream keys are `stream_<name>_<chainId>`, so with segments appended as `_<ordinal>` the
prefix for chain `1` (`stream_tag_1`) is ALSO a prefix of every key of chain `10`
(`stream_tag_10_0`). Same name, different chain is the designed-for case, since `chainId` is in the
key precisely so one tag can serve many chains. A `startsWith` filter would therefore have a chain-1
`clear` delete chain-10 segments, and a chain-1 `fetchFrom` concatenate chain-10 events into the
replay: silent wrong state, which is the failure class this spec refuses everywhere else.

So enumeration matches `^stream_<name>_<chainId>_(\d+)$` — the full prefix, the ordinal separator,
and a remainder that parses as an ordinal. Never a bare `startsWith` on the storage id.

**The two keepers also share their namespace with other keepers.** The fs keeper's `storage(folder)`
is the SAME folder `keepStateOnFile` writes into. The state key is `<name>_<chainId>`, which the
anchored pattern above already excludes, but the anchoring is what makes that true rather than luck.
On the browser side, `idb-keyval`'s `clear()` wipes the WHOLE store rather than one stream's keys, so
it is listed among the available exports as a capability and NOT as the implementation of
`ExistingStream.clear`. Use `keys` plus `delMany` over the anchored match.

**One existing test reaches into the stream key directly** and segmentation breaks it:
`packages/browser/test/invalidation.test.ts` does `get(stream_<tag>_<chainId>)`, asserts it is
defined, and rewrites `lastSync` in place. It is also the closest prior art for the migration test.
Name it in the task so it is updated deliberately rather than patched blind on a red gate.

## Testing Decisions

- **The append-cost claim is the headline and must be measured as WORK, not wall-clock.** Assert on
  bytes or events serialised per save: the tenth append costs about what the first did. Wall-clock
  would be flaky on a loaded machine (ADR-0032) and `fake-indexeddb` is itself quadratic, so it
  cannot be the yardstick.

  The seam does not exist and this spec CHOOSES it rather than leaving a builder to invent one: use
  MODULE-LEVEL mocking of `node:fs` behind `packages/fs/src/utils/fs.ts` and of `idb-keyval`'s `set`
  behind `OnIndexedDB`. The alternative, an injected optional writer, was rejected because it widens
  `keepStreamOnFile`/`keepStreamOnIndexedDB`, which is published surface, and would contradict this
  spec's no-published-type promise and pull in a changeset.

  Assert the CEILING, not equality: no save writes more than one tail plus its batch, and the 100th
  append costs no more than the 10th at the same tail phase. Asserting the tenth equals the first is
  false by design, since a tail absorbs several batches before sealing.

- **A save writes exactly ONE key** in the steady state, asserted at the same instrumented seam, and
  that INCLUDES the first save after a legacy adoption, which is the case a copying migration would
  have broken. This is the atomicity guard: it stops a crash separating the cursor from its events.
- **Enumeration does not cross chains**: two streams sharing a name on chains `1` and `10`, where a
  `clear` on one leaves the other intact and its replay unpolluted. This is the anchored-match guard
  and it fails loudly under a bare prefix filter.
- **The cursor comes from the tail**: a stream with several sealed segments resumes from the highest
  ordinal's `lastSync`, never a sealed one's stale copy.
- **A sealed segment is never rewritten** (no write targets its key again) and is **readable by its
  own key** without reading the others.
- **`fetchFrom` returns a DEFINED result for a stream saved with no events**, which is the guard
  against `indexer.ts` taking its clear branch on an empty-but-present stream.
- **A save with no events costs nothing proportional to history**, which is the empty-batch branch.
- **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events, same
  order. This spec changes no event shape, so this is a strict equality test.
- **`clear` removes everything**: clear a multi-segment stream, confirm the next `fetchFrom` returns
  nothing and no orphan survives.
- **A gap in the ordinals is refused** rather than replayed as a shorter stream.
- **Replay across a reorg** is the ordering test: retractions come back in append order.
- **Round-trip through BOTH keepers**, since they are independent implementations of one contract.
- **The migration** wants ADR-0034's shape: write a stream in the shipped blob format, read it with
  the new code, assert no re-fetch; and separately, a legacy blob with a dropped raw half is cleared.

## Out of Scope

- **Making the stream raw-only.** That is `the-stream-stores-only-what-the-node-said`, which is
  `taskedAfter` this. This spec deliberately changes NO published type, which is what makes it
  small.
- **Sharing segments between two streams.** Immutability and independent readability are delivered
  here, so a later design has something to point at. Note what that does NOT give it: segments are
  ordinal-keyed and a later segment can hold lower blocks, so there is no segment prefix
  corresponding to a BLOCK prefix.
- **Per-segment filter or lineage provenance**, which any sharing design needs and which changes the
  read seam this spec pins as unchanged.
- **Pruning or retention of segments within a live stream.** A NAMED follow-up rather than a silent
  omission, and genuinely unowned. Note it is NOT required by `a-reconfigure-is-not-an-outage`, which
  an earlier draft claimed: under that spec's one-writer rule, reclaiming a retired generation means
  deleting a WHOLE stream through `ExistingStream.clear`, not pruning segments out of a live one.

## Further Notes

Found while investigating whether stream branching is cheap enough to spec
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`). It is not, and this is why.
The quadratic append was incidental to that search and is the more urgent half: a live cost on every
sync today, with or without any versioning work.

Recorded in `work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`.

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

**`lastSync` moves to its own small mutable key**, so an append does not rewrite it, and so the
empty-batch branch above stops rewriting the history to record a cursor.

## User Stories

1. As a developer doing a long backfill, I want appending batch N to cost the same as appending
   batch 1, so a large history does not slow its own ingestion.
2. As a browser user, I do not want a full structured-clone of my entire history on every save.
3. As a developer, I want a save with no new events to cost nothing proportional to my history.
4. As a developer replaying a reorged history, I want retractions to come back in the order they were
   appended, so a rebuild sees what the live run saw.
5. As a developer, I want an existing persisted stream to keep working, or be rebuilt deliberately
   and visibly, so upgrading costs nothing I can notice and nothing I cannot explain.
6. As a developer clearing a stream, I want ALL of it gone, so no fragment survives to be replayed
   into a later rebuild.

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

**The migration is structural, because there is no marker.** The stream blob carries no format field
(unlike the fixture's `format: 2`), so the new code must recognise the old single-blob shape by
structure and migrate on first write. Where ADR-0034 already MANDATES clearing (a legacy blob whose
raw half a `logValues` projection dropped, so it cannot be re-read), that mandate WINS: clearing a
stream that cannot be re-read is correct and is not a silent clear. What is forbidden is clearing a
READABLE stream merely because its shape is old.

**Segment size follows the batch, with one caveat.** The `streamNotYetSaved` accumulator buffers
across failed saves, so a segment is whatever was buffered at that save, not necessarily one batch.
A save with zero events must not mint an empty segment.

## Testing Decisions

- **The append-cost claim is the headline and must be measured as WORK, not wall-clock.** Assert on
  bytes or events serialised per save: the tenth append costs about what the first did. Wall-clock
  would be flaky on a loaded machine (ADR-0032) and `fake-indexeddb` is itself quadratic, so it
  cannot be the yardstick. The seam does not exist yet: instrument the write util behind `OnFile`
  and the `set` behind `OnIndexedDB`, and NAME that seam in the task rather than leaving a builder
  to invent one.
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
- **Pruning or retention of segments.**

## Further Notes

Found while investigating whether stream branching is cheap enough to spec
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`). It is not, and this is why.
The quadratic append was incidental to that search and is the more urgent half: a live cost on every
sync today, with or without any versioning work.

Recorded in `work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`.

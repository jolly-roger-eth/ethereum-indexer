---
title: 'The stream is what the node said, appended once'
slug: the-stream-is-what-the-node-said-appended-once
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

The cached event stream is the thing that makes a rebuild free: `indexerMatches` keeps it, and
ADR-0034 made it survivable across a source change. But its STORAGE shape contradicts both the way
it is used and the way it is about to be used.

**Appending costs the whole stream, every time.** `packages/fs/src/storage/stream/OnFile.ts` and
`packages/browser/src/storage/stream/OnIndexedDB.ts` are the same three lines:

```ts
const existingStream = await get<StreamData<ABI>>(storageID);
const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
```

One value under one key. Every save reads the entire accumulated stream into memory, concatenates,
and serialises all of it back, so ingesting a batch at height N costs proportional to everything
already stored and a backfill degrades **quadratically**. On IndexedDB that is a full
structured-clone per save; on a filesystem a full re-serialise and rewrite. Nothing about this is
about upgrades or versioning; it is true on a first sync today.

**Half of what is rewritten is redundant.** A stored `LogEvent` carries the raw log (`topics`,
`data`, `address`) AND a decode of it (`args`, `eventName`). `WireBatch`'s own documentation
concedes that `args` "restates what `data` and `topics` already encode", accepted THERE because the
receiving primitive takes decoded events. That reason is about the wire and does not transfer to
storage. Under the rewrite above, the redundancy is not extra bytes at rest, it is extra bytes
rewritten on every append.

**And the redundant half is the only part that can be WRONG.** The raw log is what the node said
and is true forever. `args` is what SOME ABI made of it, so it goes stale whenever decoding moves
without the fetch moving, which is exactly what a renamed non-indexed parameter does. ADR-0034 had
to add an unconditional `reparse` to work around this: the stream cannot say per event which ABI
decoded it, so every replay re-decodes regardless. That is a workaround for storing a derivation
next to its source.

## Solution

Two changes, and they are the same change seen twice.

**The stream is append-only.** Events are stored in block-keyed segments that are written once and
never rewritten. Appending costs the size of the batch, not the size of history. Reading is a range
read over segments.

**The stream stores only what the node said.** Raw logs, no `args` and no `eventName`. Decoding
happens on read, on the way to the processor, which is what `reparse` already does transiently and
what the fetch path pays anyway.

Together they give a stream that is roughly half the bytes, costs O(batch) to extend instead of
O(history), and carries nothing that can be stale. `reparse` stops being a workaround and becomes
simply how a stream is read.

## User Stories

1. As a developer doing a long backfill, I want appending block N to cost the same as appending
   block 1, so that a large history does not slow its own ingestion.
2. As a developer, I want the stream to hold what the node said and nothing derived from it, so
   that nothing in it can disagree with my current ABI.
3. As a developer whose ABI changed only in how it decodes, I want the cached stream reused without
   re-fetching a single block, which ADR-0034 already promises and this makes structural.
4. As a browser user, I do not want a full structured-clone of my entire history on every save.
5. As a developer, I want an existing persisted stream to keep working across this change, or be
   rebuilt without data loss, so that upgrading costs nothing I can notice.
6. As a maintainer, I want the stream shape to permit two indexers sharing a prefix later, without
   committing to that design now.

## Implementation Decisions

**Segments, not one row per event.** A row per event makes append O(batch) but multiplies key
overhead and makes a range read a scan. Block-keyed segments (a batch's worth of events under a key
naming its range) keep appends cheap AND range reads cheap. Segment size should follow the batch
the indexer already fetches, so it needs no new tuning knob.

**Raw-only is what makes a stream version-neutral.** This is the property that matters beyond the
byte saving. A stream carrying decodings is flavoured by the ABI that produced them, so sharing one
between two sources needs per-segment decode digests to know what to trust. A stream carrying only
raw logs is the same for every reader, so sharing is simply true. Any future work on two indexers
over one history gets much cheaper, and this spec deliberately does not build that.

**`logValues` becomes a read-time projection.** It currently drops fields at STORAGE time, which is
why the indexer must detect a stream it cannot re-read and clear it rather than replay on trust.
Under raw-only, dropping `topics` or `data` would make the stream useless rather than merely
lossy, so the projection belongs on the read path. The storage saving it offered is largely
subsumed by dropping `args`.

**The persisted format changes, so it needs a bridge.** ADR-0034 set the precedent and the standard:
a stored value written by the shipped code must not be misread, because the cost of getting it
wrong is silently re-indexing every existing deployment once. Either read the old blob shape and
migrate it on first write, or detect it and rebuild deliberately. Do not silently clear.

**What is NOT decided here** is whether segments are immutable enough to be shared by reference.
Making them append-only is the precondition; whether two streams may point at the same segments is
the next spec's problem.

## Testing Decisions

- **The quadratic claim is the headline and must be measured, not asserted.** Assert on the WORK
  each append does (bytes written, or events serialised), not on wall-clock: appending the tenth
  batch must cost about what appending the first did. Wall-clock would make this a flaky test on a
  loaded machine, which this repo has already been bitten by (ADR-0032).
- **Round-trip through a real keeper**, both `OnFile` and `OnIndexedDB`, since they are separate
  implementations of the same contract and both are wrong in the same way today.
- **Reuse across a decode change** is already pinned by `packages/browser/test/invalidation.test.ts`
  from ADR-0034; those tests must keep passing unchanged, which is the strongest evidence that
  raw-only loses nothing.
- **The migration** wants the same shape of test ADR-0034 used: write a stream in the shipped blob
  format, read it with the new code, assert no re-fetch.

## Out of Scope

- **Sharing segments between two streams.** The precondition, not the feature.
- **Pruning or retention of stream segments.** Worth having and separable.
- **The wire format.** `WireBatch` keeps shipping decoded events; the receiver's primitive takes
  them and the sender holds the ABI. Storage and wire are allowed to differ, and this spec changes
  only storage.

## Further Notes

Found while investigating whether stream branching is cheap enough to spec
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`). The branching answer is that
it is not, yet, and this is why. The quadratic append was incidental to that search and is the more
urgent half: it is a live cost on every sync today, with or without any versioning work.

Recorded in `work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`.

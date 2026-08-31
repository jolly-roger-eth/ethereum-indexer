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

**The stream is append-only.** Events are written in SEGMENTS that are never rewritten, so appending
costs the size of the batch rather than the size of the history.

**Segments are keyed by an ORDINAL index, not by a block range.** Forced, not stylistic: the stored
stream is an EMISSION stream, so on a reorg the indexer re-appends the superseded events carrying
their ORIGINAL `blockNumber` flagged `removed`, then continues at LOWER block numbers. Block ranges
therefore overlap, can collide on a key, and a block-ordered read would replay retractions out of
append order. ADR-0006 is cited for that ORDERING argument only; its `seq`, its two views, its cursor
validation and its compaction are SERVER concepts and belong to a feed with consumers, which this
client cache does not have.

**Segments are a WRITE-path optimisation; the read stays a full ordered scan.** Since a LATER segment
can hold LOWER block numbers, no segment can be skipped on a block bound, so `fetchFrom` keeps its
signature and its semantics. A spec implying segments make READS cheaper would promise what the reorg
model forbids.

**What this spec fixes is the CURSOR CONTRACT; WHERE a keeper puts the cursor is ITS OWN business.**
Four properties every keeper must satisfy and a conformance test can check: exactly ONE authoritative
cursor per stream; a save is atomic in the CURSOR-AHEAD direction; no unconfirmed WINDOW accumulates
per sealed segment; an empty save costs nothing proportional to the history. The two shipped keepers
satisfy them DIFFERENTLY on purpose — the filesystem keeps the cursor in its open tail because it has
no multi-file transaction, IndexedDB keeps a separate cursor record because it has an atomic
multi-key write — and that separation of contract from placement is the decision, recorded in
ADR-0035 with the reasoning and the consequences.

**Sealed segments are immutable and independently readable**, both stated so a test can FAIL them:
no write ever targets a sealed segment's key, and any sealed segment is readable BY ITS OWN KEY
without reading the others. These are REQUIREMENTS rather than aspirations, because a later design
that wants a second reader over a prefix of this stream has nothing to stand on without them.

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

## Where the detail went

TRIMMED at tasking time, per `TASKING-PROTOCOL` section 6. The Implementation and Testing detail this
spec carried now lives in its two tasks (`segment-the-stream-behind-one-core-helper`,
`the-browser-stream-keeper-appends-in-segments`), and the durable rationale — the four-property
CURSOR CONTRACT, why placement is left to each keeper, the shared segment record, the five keeper
operations and the truncation recovery's order — is `docs/adr/0035-the-stream-cursor-contract-is-four-properties-and-placement-is-the-keepers.md`.

## Out of Scope

- **Making the stream raw-only.** That is `the-stream-stores-only-what-the-node-said`, which is
  `taskedAfter` this. This spec deliberately changes NO published type, which is what makes it
  small.
- **Sharing segments between two streams.** Immutability and independent readability are delivered
  here, so a later design has something to build on. State the limit PRECISELY, because the loose
  form of it is false: segments are ordinal-keyed and a later segment can hold lower blocks, so an
  arbitrary segment prefix does not correspond to a BLOCK prefix. That holds only WITHIN the
  unconfirmed window. Below `latestBlock - finality` no reorg can reach, so no later segment can
  ever carry a lower block and ordinal order and block order agree there. A design reading this as
  the flat claim "segments are never block-ordered" would be generalising past the region the
  premise holds in.
- **Per-segment filter or lineage provenance**, which any sharing design needs and which changes the
  read seam this spec pins as unchanged.
- **Pruning or retention of segments within a live stream.** A NAMED follow-up rather than a silent
  omission, and genuinely unowned. It is NOT required by `a-reconfigure-is-not-an-outage`: under that
  spec each generation's stream is its OWN keyspace keyed by its fetch filter, so reclaiming a
  retired generation is dropping a whole keyspace — a delete by key, not a retention policy over a
  stream that is still being read. (An earlier draft justified this by a `live`/`staging` LABEL on
  every entry. That two-label design was superseded outright by separate streams; the conclusion is
  unchanged and the ground for it is stronger.)

## Further Notes

Found while investigating whether stream branching is cheap enough to spec. It is not, and this is
why. That investigation settled in `work/notes/ideas/stream-grafting-what-we-established.md` and then
in `a-reconfigure-is-not-an-outage`, which does not branch a stream at all: each generation gets its
own, keyed by its fetch filter.
The quadratic append was incidental to that search and is the more urgent half: a live cost on every
sync today, with or without any versioning work.

Recorded in `work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`.

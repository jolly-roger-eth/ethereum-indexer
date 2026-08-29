---
title: 'The stream is what the node said, appended once'
slug: the-stream-is-what-the-node-said-appended-once
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **Revised twice after review.** The first draft proposed BLOCK-KEYED segments and claimed the
> change roughly halves the stream; both were wrong. The second draft fixed the ordering but broke
> the READ seam it had matched for free, and left the stored-event TYPE unnamed. This draft owns
> both. The append-cost and staleness arguments are unchanged throughout and are the real case.
>
> On size: the repo's own numbers DISAGREE (the capture script says 32.5 MB against 8.6 MB, while
> the fixture README, the sqlite finding and two changelogs say 32.5 MB against 20.5 MB), so `args`
> is somewhere between 9 and 37 percent of a stream. Size is not the case for this change, and no
> task should quote a figure without re-measuring.

## Problem Statement

The cached event stream is what makes a rebuild free: `indexerMatches` keeps it, and ADR-0034 made
it survive a source change. Its STORAGE shape works against both.

**Appending costs the whole stream, every time.** `packages/fs/src/storage/stream/OnFile.ts` and
`packages/browser/src/storage/stream/OnIndexedDB.ts` are the same three lines:

```ts
const existingStream = await get<StreamData<ABI>>(storageID);
const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
```

One value under one key. Every save reads the entire accumulated stream into memory, concatenates,
and serialises all of it back, so ingesting a batch at height N costs proportional to everything
already stored and a backfill degrades **quadratically**. `save` runs once per `indexMore`
(`indexer.ts:741`), so this is per batch and not per session. On IndexedDB it is a full
structured-clone each time. None of this involves upgrades or versioning; it is true on a first
sync today.

**The stream stores a derivation next to its source, and only the derivation can be wrong.** A
stored `LogEvent` carries the raw log (`topics`, `data`, `address`), which is what the node said
and is true forever, AND `args`/`eventName`, which is what SOME ABI made of it. The second goes
stale whenever decoding moves without the fetch moving, which is exactly a renamed non-indexed
parameter. ADR-0034 had to add an unconditional `reparse` to cope: the stream cannot say per event
which ABI decoded it, so every replay re-decodes regardless.

**This is a correctness-shaped cost, not a size one.** Measured in this repo, stripping `topics`
and `data` took a capture from 32.5 MB to 8.6 MB, so the RAW half is the bulk and `args` is roughly
9 percent of a full stream. Dropping it is a modest saving that happens to be rewritten on every
append; the reason to drop it is that it is the only part that can disagree with the current ABI.

## Solution

**The stream is append-only, ordered by APPEND and not by block.** Events are written in segments
that are never rewritten. Appending costs the size of the batch. Reading is a range read in append
order.

**Segments are keyed by an ORDINAL index, not by block range.** This is forced, not stylistic. The
stored stream is an EMISSION stream: on a reorg the indexer re-appends the superseded events
carrying their ORIGINAL `blockNumber` and flagged `removed` (`internal/engine/utils.ts:188`), then
continues indexing at LOWER block numbers. So block ranges overlap, can collide on a key, and a
block-ordered read would replay retractions out of append order.

ADR-0006 is cited for its ORDERING argument ONLY: that `(blockNumber, logIndex)` is neither unique
nor monotonic over an emission stream, so it cannot key one. Its `seq` is a SERVER concept, existing
so a query CONSUMER has a cursor; this is a client cache with no consumer, read in bulk, and nothing
client-side assigns a per-event sequence today. Do not invent one: a monotonic ordinal per SEGMENT
is all the ordering needs. Equally, do not import the rest of ADR-0006 (its two views, its cursor
validation, its compaction) into a cache that has none of those problems.

**Segments are a WRITE-path optimisation; the read stays a full ordered scan.** This falls out of
the same reorg fact and must be said plainly, because it is what the previous draft got wrong by
omission. Since a LATER segment can hold LOWER block numbers, no segment can be skipped on a block
bound. So `fetchFrom(source, fromBlock)` KEEPS its signature and its semantics: read every segment
in ordinal order, concatenate, apply the existing `blockNumber >= fromBlock` filter. The seam does
not change and callers do not change; the win is entirely on append. A spec implying segments make
READS cheaper would be promising what the reorg model forbids.

**The stream stores only what the node said.** Raw logs plus the reorg flag the indexer derived; no
`args`, no `eventName`. Decoding happens on read, which is what `reparse` already does transiently
and what the fetch path pays anyway.

**This needs a NEW stored-event type, and it is a BREAKING change to a published interface.** A
raw-only event is not a `LogEvent` at all: `LogEvent` is a union of `ParsedLogEvent` (carrying `args`
and `eventName`) and `LogEventWithParsingFailure` (carrying `decodeError`), so an event with neither
is a member of neither. `StreamFetcher` and `StreamSaver` are typed `LogEvent[]`, and
`ExistingStream` is implemented by third parties. So this spec introduces a stored-event type
(`BaseLogEvent` without the decoded half) and moves the `ExistingStream` seam onto it. That is a
breaking `@etherfold/core` API change, it needs a changeset, and it is OWNED here rather than
discovered by whichever task hits it first.

**Segments are immutable and independently readable.** Once written a segment is never edited, and
any segment can be read BY ITS OWN KEY without reading the others. This spec does not build sharing,
but it must not preclude it: a later deployment-versioning design needs a prefix that can be
referred to rather than copied.

Both halves are stated so they can FAIL a test. Immutability is observable at the write seam (no
write ever targets an existing segment key). Independent readability is the criterion that bites,
where merely addressable would not: any keyed store satisfies can be named, so nothing could fail
it.

## User Stories

1. As a developer doing a long backfill, I want appending batch N to cost the same as appending
   batch 1, so a large history does not slow its own ingestion.
2. As a developer, I want the stream to hold what the node said and nothing derived from it, so
   nothing in it can disagree with my current ABI.
3. As a developer whose ABI changed only in how it decodes, I want the cached stream reused without
   re-fetching a block, which ADR-0034 promises and this makes structural.
4. As a browser user, I do not want a full structured-clone of my entire history on every save.
5. As a developer, I want an existing persisted stream to keep working, or be rebuilt deliberately
   and visibly, so upgrading costs nothing I can notice and nothing I cannot explain.
6. As a developer replaying a reorged history, I want retractions to come back in the order they
   were appended, so a rebuild sees what the live run saw.
7. As an implementor of `ExistingStream`, I want the stored-event type to SAY it carries no decoded
   half, so a keeper cannot accidentally persist one and I find out at compile time.

## Implementation Decisions

**Segments over one row per event.** ADR-0006 chose a row per emitted log with a `seq`; that is
right for a queryable server table. This is a client-side cache read only in bulk, so a segment (a
batch's worth of events under one key, carrying its `seq` range) keeps appends cheap AND avoids
per-event key overhead in IndexedDB. The ORDERING is ADR-0006's; only the granularity differs, and
that difference is because the access pattern is a full replay rather than a query. Segment size
follows the batch the indexer already fetches, so it adds no tuning knob.

**Raw-only is what makes a stream decode-neutral.** Beyond the byte saving, a stream carrying
decodings is flavoured by the ABI that produced them; a raw stream reads the same for everyone.
Note this is decode-neutrality only: a stream is still relative to the FILTER its ranges were
fetched under, since absence of a log only means something against a filter. That is not solved
here and any later sharing design must carry filter provenance per segment.

**Core strips the decoded half, not each keeper.** `ExistingStream` is a third-party-implementable
interface with three implementations already; putting the rule in each one would let them drift.
Strip on the way into `saveNewEvents`, producing NEW OBJECTS: a new array holding the same
references strips nothing, and those references are the very objects just handed to
`processor.process`. With the stored-event type above, a keeper that persisted a decoded event no
longer typechecks, so the rule is enforced rather than merely documented.

Two consequences of the `streamNotYetSaved` accumulator, which buffers across failed saves: a
segment is whatever was buffered at that save, NOT necessarily one batch, so segment size follows
the batch only on the happy path; and a save with zero events must not mint an empty segment.

**`lastSync` is stored separately, and story 2 is scoped to the event stream.** `lastSync` rides in
the same stored value today, is rewritten on every save, and `LastSync.unconfirmedBlocks` holds full
DECODED events. It STAYS decoded: it is the live reorg window the indexer is actively reasoning
about rather than a cache of history, and it is bounded by the finality depth. But it must not sit
inside the append-only segments, or every append would rewrite it and the append-cost claim would be
false. One small mutable key for `lastSync`; immutable segments for the stream.

**`logValues` is a PARSE-time projection today**, applied in `LogEventFetcher.parse`, so it trims
what the live processor receives as well as what is stored. That is why the indexer must detect a
stream it cannot re-read and clear it. Moving projection off the stored form must state explicitly
whether the fetch path still projects for the processor; changing that silently would change what
handlers see.

**The fixture form keeps its own format and is NOT reached through this seam.** `replayStream` over
`StreamFixture` is a third `ExistingStream`, and the committed fixtures are deliberately
DECODED-ONLY with `omittedFields` provenance, which raw-only cannot represent. They are a test
input, not a cache, and recapturing them at roughly 4x size buys nothing.

Be precise about WHY that is safe, because the obvious phrasing is unbuildable: a fixture reaching
`promiseToLoad` would be `reparse`d unconditionally, `reparse` returns `undefined` when `topics` or
`data` is missing, and the indexer would then CLEAR the stream. Nothing wires `replayStream` as
`keepStream` today, so the two never meet. The rule is therefore that the raw-only stored-event type
governs the CACHE keepers, and the fixture path is a separate reader not flowing through
`fetchFrom`. If anything ever wires them together, `ExistingStream` needs an explicit
already-decoded discriminator; that is not built here and must not be faked by leaving two shapes
behind one interface.

**The migration is structural, because there is no marker.** The stream blob carries no format
field (unlike the fixture's `format: 2`), so the new code must recognise the old shape by structure
and migrate on first write. Where ADR-0034 already MANDATES clearing (a legacy blob whose raw half
a `logValues` projection dropped, so it cannot be re-read), that mandate WINS: clearing a stream
that cannot be re-read is correct and is not the silent-clear this spec forbids. What is forbidden
is clearing a readable stream merely because its shape is old.

## Testing Decisions

- **The append-cost claim is the headline and must be measured as WORK, not wall-clock.** Assert on
  bytes or events serialised per save: the tenth append costs about what the first did. Wall-clock
  would be flaky on a loaded machine, which this repo has already been bitten by (ADR-0032), and
  `fake-indexeddb` is itself quadratic so it cannot be the yardstick. The seam does not exist yet:
  instrument the write util behind `OnFile` and the `set` behind `OnIndexedDB`, and name that seam
  in the task rather than leaving a builder to invent one.
- **Round-trip through both cache keepers**, since they are independent implementations of one
  contract and both are wrong in the same way today.
- **`fetchFrom` still answers exactly what it answers today** for the same `fromBlock`, event for
  event and in the same order, since the seam is deliberately unchanged.
- **Independent readability**: a segment is readable by its own key without reading the others, and
  no write ever targets an existing segment key.
- **Replay across a reorg** is the ordering test: retractions must come back in append order, and a
  rebuild must see what the live run saw.
- **Reuse across a decode change** is already pinned by `packages/browser/test/invalidation.test.ts`;
  those tests passing unchanged is the strongest evidence raw-only loses nothing.
- **The migration** wants ADR-0034's shape: write a stream in the shipped blob format, read it with
  the new code, assert no re-fetch; and separately, a legacy blob with a dropped raw half is
  cleared.

## Out of Scope

- **Sharing segments between two streams.** Not built here. But immutability and independent
  readability ARE delivered here, so the later design has something to point at.
- **Filter provenance per segment.** Needed by any sharing design; named, not built.
- **Pruning or retention of segments.**
- **The wire format.** `WireBatch` keeps shipping decoded events, since the receiving primitive
  takes them and the sender holds the ABI. Storage and wire are allowed to differ.

## Further Notes

Found while investigating whether stream branching is cheap enough to spec
(`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`). It is not, and this is why.
The quadratic append was incidental to that search and is the more urgent half: a live cost on
every sync today, with or without any versioning work.

Recorded in `work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`.

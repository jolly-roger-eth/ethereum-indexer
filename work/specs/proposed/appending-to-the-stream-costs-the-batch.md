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

**What the spec fixes is the CURSOR CONTRACT. WHERE a keeper puts the cursor is ITS OWN business.**
This distinction is the one that took longest to see, and getting it wrong is what made this section
oscillate: a single storage layout was being chosen for every substrate at once, so the filesystem's
inability to commit two keys kept being imposed on stores that CAN, and their capability kept being
imposed back on the filesystem.

Four properties, which every keeper must satisfy and a conformance test can check:

1. **Exactly ONE authoritative cursor per stream.** A reader never has to choose between competing
   copies.
2. **A save is atomic in the CURSOR-AHEAD direction.** A reader must never see a cursor claiming
   coverage the stored events do not have; that is silent data loss. Cursor-BEHIND is tolerable, but
   only if the keeper can DETECT the uncommitted excess and discard it — keeping it and re-fetching
   is what appends duplicates.
3. **No unconfirmed WINDOW accumulates per sealed segment.** This is narrower than "no cursor data"
   ON PURPOSE. What is expensive is `LastSync.unconfirmedBlocks`: it is `EventBlock[]` and
   `EventBlock` carries the FULL decoded events of each block, so a per-segment copy is up to
   `finality` blocks of event data, duplicated forever, read by nothing. The rest of `LastSync` —
   three block numbers and the context hashes — is a few dozen bytes and is REQUIRED per segment,
   because a truncation must leave a stream that can still say where it got to. A rule stripping the
   whole `LastSync` would leave the surviving prefix with NO cursor at all, and `StreamFetcher` must
   return one whenever it returns anything.
4. **An empty save costs nothing proportional to the history.**

**Both shipped keepers satisfy these by putting the cursor IN THE OPEN TAIL and STRIPPING it when the
segment seals.** One key is one write, so property 2 holds by construction with no transaction, no
ordering rule and no recovery; sealing is an explicit act — when a save opens segment `N+1` it
rewrites segment `N` with its `unconfirmedBlocks` EMPTIED, keeping the rest of its `lastSync` — which
gives property 3 while leaving every segment self-describing.

That strip is one extra write per SEAL, not per save, and it is OFF THE CRITICAL PATH: if it never
happens, segment `N` keeps a stale WINDOW nothing reads (the live cursor is the TAIL's, and the tail
is the highest ordinal), and the next pass empties it. Idempotent and safe to fail.

**A keeper whose substrate offers atomic multi-row updates MAY place the cursor elsewhere**, and
should not be read as violating this spec for doing so. A SQL-backed stream can hold its cursor in
its own row and update it in the SAME transaction as the segment insert, which satisfies properties 1
and 2 directly and makes property 3 vacuous — no strip, and no tail rewrite on an empty save either.
That is a BETTER fit for that substrate, and the server's ADR-0006 emission-stream table is the
concrete case. The tail strategy is chosen here because it is the simplest thing that satisfies all
four on the two substrates this spec actually ships, NOT because it is the only correct layout.

**The empty save is the cost of this shape, and it is bounded and tunable.** A save with no new
events still rewrites the tail to move the cursor, and a head-following indexer saves on EVERY poll
(`indexer.ts` calls `save` unconditionally; the `eventStream.length > 0` guard beside it covers only
state updates). So the steady-state cost is one tail rewrite per poll. That is bounded by the SEAL
THRESHOLD, never by the history — which is what story 1 actually claims — and it is tunable: at 1000
events a tail is a few hundred KB and a handful of milliseconds; at 250 it is under a millisecond.

A separate cursor record makes an empty save one small write instead, and on a substrate with
transactions that is strictly better — which is exactly why the contract above leaves it open. What
was withdrawn is MANDATING it everywhere: on a substrate that cannot commit two keys, the cursor and
the segment become two things that must agree, and paying for that means orphan discard, truncation
to a committed event count, and integers whose only job is to compensate for the missing capability.
Four review rounds found defects in that machinery and nowhere else. So the filesystem takes the
milliseconds and a transactional keeper takes the separate record; neither is imposed on the other.

**Segments are written through temp-file-plus-rename on the filesystem.** A bare `writeFileSync` can
leave a TORN file, and `storage().get` wraps only `readFileSync` in its `try`/`catch` — `JSON.parse`
sits OUTSIDE it — so a torn segment THROWS out of `fetchFrom`, which `indexer.ts` does not wrap, and
the indexer is then permanently unloadable. A rename is atomic for a single file, so this costs
nothing. Belt and braces: a segment that still fails to parse is treated as a GAP at its ordinal and
goes through the contiguity refusal, so corruption from any other cause degrades instead of throwing.

**`clear` deletes from the HIGHEST ordinal DOWNWARD.** The fs `clear` is N `unlinkSync` calls and is
not atomic, so an interrupted clear is reachable in normal operation. Deleting downward leaves a
contiguous prefix `0..k` with its own tail carrying its own cursor — a shorter but VALID stream,
which the next load either continues or clears again. Deleting upward would leave a hole, which is
strictly worse for no benefit.

**The live cursor is the TAIL's, and the TAIL is the highest ordinal.** A reader tells by
enumeration. Every sealed segment has had its cursor stripped, so there is no stale copy to pick by
mistake; a sealed segment holds EVENTS and nothing else.

**PRESENCE is the TAIL.** `fetchFrom` must keep
returning a DEFINED result for a stream that has been saved to but holds no events, because today an
empty first save writes `{lastSync, eventStream: []}` and a defined result is what stops `indexer.ts`
taking its clear branch. A tail exists as soon as anything has been saved, including a save with
no events at all, so presence is the tail's existence.

The migration rides on the same rule: the adopted legacy blob already CONTAINS a `lastSync`, so it IS
a valid tail from the moment it is adopted, with no ordinal segments in existence yet. Nothing is
written to adopt it. It is stripped and sealed like any other tail when `_0` is opened.

The seal threshold is counted in **EVENTS**, not bytes. Bytes are natural on the filesystem (the JSON
string is already built) and not cheaply available on IndexedDB (structured-clone size is not
exposed), so naming the unit is what stops the two keepers choosing differently and makes the seal
test deterministic.

**No per-segment block RANGE is recorded, because nothing consumes one.** A draft added a `{min, max}` per segment so a later design could select the
segments covering blocks `[0, N)`. It is unnecessary, and the reason is not that segments are
unorderable by block (below the finality horizon they are): it is that no consumer exists.

The argument for adding it was forward compatibility: a range cannot be added retroactively without
reading every segment, so a later design wanting to select the segments covering blocks `[0, N)`
would face a migration. That later design does not exist. `a-reconfigure-is-not-an-outage` gives each
version its own stream keyed by its FETCH FILTER, so nothing ever selects a block-prefix of somebody
else's segments, and there is no graft point to select for.

If a future design does want it — the deliberately-deferred optimisation where a new stream reuses an
old one it is a superset of — note what it would actually need: the SCANNED extent, not a range over
the events a segment happens to CONTAIN. Those differ whenever a range yielded no events, which is
most ranges. A `{min, max}` over events would not answer the question anyway, so adding one now would
pre-pay a debt in the wrong currency.

**Sealed segments are immutable and independently readable**, and both halves are stated so a test
can FAIL them. Immutability is observable at the write seam: no write ever targets a sealed
segment's key. Independent readability means any sealed segment is readable BY ITS OWN KEY without
reading the others, which is the criterion that bites where "addressable" would not, since any keyed
store satisfies being nameable. These are REQUIREMENTS here, not aspirations: a later design that
wants a second reader over a prefix of this stream, while this stream keeps being appended to, has
nothing to stand on without them. `a-reconfigure-is-not-an-outage` is that design.

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
failure class the reorg model and `SuspectedTruncationError` already refuse.

**"The remainder" is the segments AT AND ABOVE the gap, and the contiguous PREFIX BENEATH IT
SURVIVES.** Say which, because the two readings differ by an entire cached history and the
destructive one is the intuitive one. On finding a hole at ordinal `k`, delete `k` and everything
above it and KEEP `0..k-1`.

The prefix is safe to keep because EVERY segment carries its own `lastSync` (sealed ones with an
emptied window, which is exactly why the strip is narrow): the surviving top segment becomes the TAIL
and can say where the stream got to, so a truncated stream is self-describing with nothing to
rewrite. Its window is empty, which is correct — a recovered cursor never drives a scan with an empty
window, because the prefix is REPLAYED first and `generateStreamToAppend` rebuilds the window from
the replayed events. The
recovery is simply "delete from the gap upward"; what remains is a shorter, valid stream that resumes
from its own cursor. Nothing is replayed as if it were complete, because the cursor came from the
surviving tail rather than from a stale higher one.

> A draft rewrote the cursor from a separate record and, to avoid a duplication hazard, TRUNCATED the
> prefix to a segment boundary below `latestBlock - finality`. Both are gone with the cursor record.
> The hazard did not exist (a recovered cursor never drives a scan with an empty window: the prefix is
> REPLAYED first, and `generateStreamToAppend` rebuilds `unconfirmedBlocks` from the replayed events),
> and the truncation was worse than the problem, since the indexer scans to head so a head-era segment
> has `lastToBlock == latestBlock` and NO segment satisfies the horizon test — it would have deleted
> every segment. Recorded so neither is re-derived.

**The recovery must not leave the stream open for append above a hole it cannot fill.** Keeping the
prefix is safe for READING: it is complete from block 0 to its own cursor. What is NOT safe is the
next save appending at head on top of it, which would leave the stream claiming `0..head` while
missing everything between — undetectable by any reader, and replayed as whole by a later state
discard. So a save whose `fromBlock` sits above the surviving tail's `lastToBlock + 1` would CREATE a
hole, and the keeper CLEARS the stream rather than writing it.

**If nothing survives** — a gap at ordinal 0 with no adopted legacy segment — there is no tail, so
presence reads FALSE and the next load takes the clear branch, which is correct: an empty stream is
honest where a stream claiming coverage it lacks is not.

**Contiguity means NO HOLES, not "starts at ordinal 0."** After a legacy adoption the earliest
segment is the legacy key rather than `_0`, and a later design may number a segment run from
somewhere other than zero, so a start-at-zero rule would refuse healthy streams.

**The migration ADOPTS the legacy key as a sealed segment rather than rewriting it.** The stream blob
carries no format field (unlike the fixture's `format: 2`), so the old single-blob shape is
recognised structurally. But a migration that COPIED it into segments would need two writes, and the
crash window between them is exactly the cursor-ahead/cursor-behind hazard the open tail exists to
close — and a reader finding BOTH shapes would have no defined behaviour, double-counting the prefix
or dropping it.

So the legacy key `stream_<name>_<chainId>` (no ordinal) is ADOPTED IN PLACE as the earliest sealed
segment: never rewritten, read first, and followed by `_0.._N`. Nothing is copied, and the adoption
writes NOTHING AT ALL: the legacy blob already contains a `lastSync`, so it IS a valid tail the
moment it is adopted, and the one-write rule holds through the migration rather than being suspended
for it. It is stripped and sealed like any other tail when `_0` is opened. `clear` removes it along
with the ordinals.

The rebuild story 5 asks to be VISIBLE needs an owner too: a clear or a migration should say so
through the existing logger rather than happening in silence. Where ADR-0034 already MANDATES clearing (a legacy blob whose
raw half a `logValues` projection dropped, so it cannot be re-read), that mandate WINS: clearing a
stream that cannot be re-read is correct and is not a silent clear. What is forbidden is clearing a
READABLE stream merely because its shape is old.

**The segmentation rules live in ONE place, not in each keeper — and the CURSOR PLACEMENT is
deliberately NOT one of them.** The helper owns the rules that must not drift; each keeper owns how
it commits a segment and its cursor, which is where substrates genuinely differ. Ordinal naming, the anchored match,
the contiguity refusal, the seal decision, legacy adoption and cursor selection are identical for
both keepers and are the whole substance of this change. `OnFile` and `OnIndexedDB` are independent
implementations of `ExistingStream` in different packages, so a task cut per keeper would
re-implement the same prose twice and drift. Put the rules in an internal core helper parameterised
over a `get`/`set`/`setMany`/`del`/`delMany`/`keys` port plus a capabilities record, and let each keeper supply both. That also gives the
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

- **A crash never leaves the cursor AHEAD of its events**, asserted by interrupting a save at the
  instrumented write seam on BOTH keepers, and INCLUDING the first save after a legacy adoption. On
  IndexedDB assert the segment and cursor commit in one transaction; on the filesystem assert the
  cursor is written last and that a segment above it is DISCARDED as an orphan on the next load
  rather than replayed. This is the atomicity guard and it is the reason the cursor is one record.
- **The four CURSOR CONTRACT properties are asserted against the KEEPER, not against a layout**, so a
  keeper that places its cursor differently is tested on the same terms: exactly one authoritative
  cursor; no cursor claiming coverage the stored events lack; no cursor data per SEALED segment; and
  an empty save costing nothing proportional to history. These belong in the shared conformance
  material, following ADR-0020's precedent of testing each backend against its own claim.
- **For the two keepers that use the TAIL strategy**, assert its mechanics too: seal a tail and
  confirm its `unconfirmedBlocks` is EMPTY while the rest of its `lastSync` survives and the new tail
  carries a full one. Assert the paired negative explicitly — a sealed segment must still be able to
  say where the stream got to, or a truncation leaves a prefix that cannot be resumed. Do not strip `unconfirmedBlocks`
  out of the tail — that is `the-stream-stores-only-what-the-node-said`'s job.
- **A save is atomic in the cursor-ahead direction**, asserted by interrupting at the instrumented
  seam, INCLUDING an empty save and the first save after a legacy adoption. For the tail keepers that
  reduces to "a save writes exactly ONE key", which is the strongest form of it: one key cannot be
  torn between a cursor and its events. A transactional keeper would assert the same property through
  its transaction instead.
- **A SEAL writes one extra key and is safe to fail**: interrupt between opening the new tail and
  stripping the old one, and assert the stream still reads correctly (the stale cursor in the sealed
  segment is ignored, because the live cursor is the tail's) and that a later pass strips it.
- **The cursor comes from the TAIL**: a stream with several sealed segments resumes from the highest
  ordinal's `lastSync`, and no sealed segment offers a competing copy because sealing stripped them.
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
  spec every entry carries a generation label, so reclaiming a retired generation is deleting the
  entries under one label, which is a delete by key and not a retention policy over a generation that
  is still being read.

## Further Notes

Found while investigating whether stream branching is cheap enough to spec. It is not, and this is
why. That investigation settled in `work/notes/ideas/stream-grafting-what-we-established.md` and then
in `a-reconfigure-is-not-an-outage`, which does not branch a stream at all: each generation gets its
own, keyed by its fetch filter.
The quadratic append was incidental to that search and is the more urgent half: a live cost on every
sync today, with or without any versioning work.

Recorded in `work/notes/observations/the-stream-is-a-monolithic-blob-rewritten-on-every-append.md`.

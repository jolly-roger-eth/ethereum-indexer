---
title: 'Segment the stream behind one core helper, and put the fs keeper on it'
slug: segment-the-stream-behind-one-core-helper
spec: appending-to-the-stream-costs-the-batch
blockedBy: []
covers: [1, 3, 4, 5, 6, 7]
---

## What to build

The stream stops being one blob rewritten in full on every append, and becomes an **append-only log
of segments** whose rules live in ONE core helper that both keepers consume. This task builds the
helper and puts the **filesystem** keeper on it end-to-end; the browser keeper follows in
`the-browser-stream-keeper-appends-in-segments`.

Today `keepStreamOnFile` reads the entire accumulated stream, concatenates, and serialises all of it
back on every `saveNewEvents`. `save` runs once per index cycle, so a backfill is QUADRATIC, and the
empty-batch branch pays the same cost purely to move `lastSync`.

The shape to build:

- **An append-only log with an OPEN TAIL.** The newest segment is OPEN and holds its events plus its
  SCANNED EXTENT. A save appends to the open tail: ONE write, bounded by the
  tail plus its batch, never by the history. The tail is SEALED when it exceeds a size threshold and
  the next save opens a new one. A sealed segment is immutable forever.
- **The segment and the CURSOR commit together, and the cursor is ONE record per stream.** Not one
  per segment: `LastSync.unconfirmedBlocks` is `EventBlock[]` and `EventBlock` carries the FULL
  decoded events of each block, so a per-segment copy duplicates up to `finality` blocks of real
  event data into every sealed segment, permanently, where nothing reads it again.

  The two failure directions are NOT equal, and that asymmetry is the design. **Cursor AHEAD** of its
  events is unacceptable: a lost segment is never replayed and the stream silently claims coverage it
  lacks. **Cursor BEHIND** is recoverable, PROVIDED the extra segment is DISCARDED as an orphan
  rather than kept — keeping it and re-fetching from the stale `lastToBlock` is what appends
  duplicates. So the cursor is written LAST, as the commit point:

  - **IndexedDB** has a real multi-key transaction: `idb-keyval`'s `setMany` opens one `readwrite`
    transaction, puts every entry and awaits `store.transaction`. Both commit together.
  - **The filesystem** has no multi-file transaction, so it relies on the ordering plus the orphan
    rule: write the segment, then the cursor via a temp file and `rename`, which IS atomic for one
    file.

  Orphan discard is the same shape as the contiguity rule below — drop from the break upward, keep
  the prefix — but they are TWO recoveries and only one is conditional. CRASH RECOVERY (orphan
  discard + tail truncation) compensates for a non-atomic port and must never fire on an atomic one.
  The CONTIGUITY REFUSAL is UNCONDITIONAL on every port, because a gap comes from an interrupted
  `clear` rather than from a torn commit.
- **Sealing is not a write.** A segment is sealed exactly when it is no longer the highest ordinal,
  so it happens implicitly when the next save opens a new one, and a reader tells by enumeration.
  Nothing is ever written INTO a segment to mark it sealed, which is what keeps immutability true.
  A segment holds its EVENTS plus its SCANNED EXTENT (`{lastFromBlock, lastToBlock, latestBlock}`)
  and nothing else — no `context`, no `unconfirmedBlocks`.
- **The live cursor is the CURSOR RECORD, `{lastSync, committedThrough, committedEvents}`.** `committedThrough` is the
  ORDINAL of the segment it was committed with, and it is REQUIRED rather than convenient: `LastSync`
  names only blocks, and block order is NOT monotonic across segments (a reorg re-appends lower
  blocks into a later segment), so nothing can identify the segments ABOVE the cursor from block
  numbers — which is exactly what orphan discard needs. The per-segment scalars are NOT the
  per-segment cursor being reinstated: what made that expensive was `unconfirmedBlocks` (whole blocks
  WITH their events); three numbers are free, and they are what makes any PREFIX self-describing.
- **Keys are ORDINAL, and the read stays a full ordered scan.** The stored stream is an EMISSION
  stream: on a reorg the indexer re-appends superseded events at their ORIGINAL `blockNumber` flagged
  `removed`, then continues at LOWER block numbers. So block ranges overlap and cannot key or order
  anything, and no segment can be skipped on a block bound. `fetchFrom(source, fromBlock)` KEEPS its
  signature and semantics: read every segment in ordinal order, concatenate, apply the existing
  `blockNumber >= fromBlock` filter.
- **Enumeration is ANCHORED, never a bare prefix.** Stream keys are `stream_<name>_<chainId>`, so
  with an ordinal appended the chain-`1` prefix `stream_tag_1` is ALSO a prefix of every chain-`10`
  key (`stream_tag_10_0`). Match `^stream_<name>_<chainId>_(\d+)$` — full prefix, separator, and a
  remainder that parses as an ordinal.
- **A gap in the ordinals is REFUSED, the refusal CLEARS FROM THE GAP UPWARD, and the PREFIX BENEATH
  SURVIVES. It does not throw and it does not clear the whole stream.** Both halves are load-bearing
  and both are easy to get wrong:

  - **Not a throw.** `indexer.ts` calls `keepStream.fetchFrom` with no `try`/`catch` anywhere in that
    method, so a throw escapes `load()`, and the browser wrapper only records `FAILED_TO_LOAD` and
    rethrows without clearing. Every subsequent load would throw again and the indexer would be
    permanently unloadable, with no recovery a user could reach — for a LOCAL CACHE whose correct
    recovery is simply to re-fetch. This is why the `SuspectedTruncationError` analogy does NOT
    extend to the ACTION: that is a live NODE fetch, where retrying or narrowing is the recovery.

    There is a PRE-EXISTING hazard on the neighbouring path that this task does not create and does
    not have to fix, but must not make worse: on the state-kept branch, `indexer.ts` clears the
    stream when `streamMatches` fails while the state survives, and a stream cleared with the state
    intact is later replayed by the fresh-sync path as if it were the whole history. Keeping the
    prefix (below) means this task never enlarges that window. If you find yourself widening it,
    surface it rather than absorbing it.
  - **Not the whole stream.** On a hole at ordinal `k`, delete `k` and above and KEEP `0..k-1`.
    Segment `k-1` carries its own SCANNED EXTENT, so the surviving prefix is self-describing: rewrite
    the cursor record from it, window EMPTY (correct — a recovered cursor never drives a scan with an
    empty window, because the prefix is REPLAYED first and `generateStreamToAppend` rebuilds the
    window from the replayed events). Open a FRESH ordinal above the prefix rather than appending
    into the segment that was sealed beneath it. If nothing survives, DELETE the cursor so the stream
    reads as absent. And if a later save's `fromBlock` would sit ABOVE the recovered cursor, that
    save would create a HOLE — clear the stream instead of writing it. Clearing everything would throw away a good prefix (story 5
    says an upgrade must cost nothing the user notices) and, on the state-kept path, would be
    SILENT: `indexer.ts` only clears there when `streamMatches` fails, so an undefined `fetchFrom`
    leaves the state cursor untouched and the next save writes a stream covering only from now on,
    which a later state discard replays as if it were the whole history.

  Nothing is replayed as if it were complete either way — the truncated tail is DISCARDED and the
  cursor comes from the surviving tail, never a stale higher one. Log it. Contiguity means NO HOLES,
  not "starts at ordinal 0": after a legacy adoption the earliest segment is the legacy key.
- **The legacy blob is ADOPTED IN PLACE as the earliest sealed segment**, never copied. The stream
  blob carries no format field, so the old shape is recognised structurally. It is read first,
  followed by `_0.._N`, and the adoption writes ONE thing — the cursor record, seeded from the
  `lastSync` inside the legacy blob — so the atomic-commit rule holds THROUGH the migration rather
  than being suspended for it.
- **Presence is the CURSOR RECORD, never a segment count and never a tail.** `fetchFrom` must keep
  returning a DEFINED result for a stream saved to but holding no events, because a defined result is
  what stops `indexer.ts` taking its clear branch. The cursor record exists as soon as anything has
  been saved — including an empty save, and including the moment a legacy blob is adopted, when no
  ordinal segment exists yet.
- **`clear` removes ALL of it.** It deletes a single storage id today; with N segment keys a naive
  port orphans every segment but one, after which the next save appends beside a dead prefix and the
  next `fetchFrom` concatenates it into the replay — wrong state, SILENTLY. It is called from five
  paths in `indexer.ts`.

**Put the rules in ONE internal core helper parameterised over a
`get`/`set`/`setMany`/`del`/`delMany`/`keys` port plus a CAPABILITIES record**, and
let the keeper supply the port. Ordinal naming, the anchored match, the contiguity refusal, the seal
decision, legacy adoption and cursor selection are identical for both keepers and are the whole
substance of this change; a helper per keeper would re-implement the same prose twice and drift.

**Enumerate; do not add a head pointer.** A head is a second thing that can disagree with the
segments and cannot detect a partial clear — a head saying N over segments that are gone reads as
holes, whereas enumerating the ordinals and checking CONTIGUITY turns a silent truncation into a
refusal. `packages/fs/src/utils/fs.ts` is our file and is a `readdir` away from `keys`.

**The seal threshold is counted in EVENTS, not bytes.** Bytes are natural on the filesystem but not
cheaply available on IndexedDB (structured-clone size is not exposed), so naming the unit is what
stops the two keepers choosing differently and makes the seal test deterministic.

## Acceptance criteria

- [ ] The port carries an explicit ATOMIC-MULTI-KEY capability, and the helper branches on it: with
      the capability, one commit and no recovery path executed; without it, cursor-last plus orphan
      discard and tail truncation. Assert BOTH branches, and assert the recovery never fires on the
      atomic one.
- [ ] A core helper implements segmentation over an injected `get`/`set`/`setMany`/`del`/`delMany`/`keys` port plus a CAPABILITIES record, and is
      reachable from `@etherfold/fs` (core's `exports` map is only `.` and `./package.json`, so
      `index.ts` must re-export it). That export line is published surface: **ship a changeset**, and
      scope it to `@etherfold/core` and `@etherfold/fs` only. The sibling task ships its own for
      `@etherfold/browser`, whose persisted layout it changes; do not try to describe that here,
      since it lands after this one. (`packages/fs/src/utils/fs.ts` is NOT re-exported from
      `packages/fs/src/index.ts`, so adding `keys` to it is not published surface.)
- [ ] `keepStreamOnFile` is implemented on the helper and `packages/fs/src/utils/fs.ts` gains `keys`.
- [ ] **Append cost is asserted as WORK, not wall-clock**, at a module-level mock of `node:fs` behind
      `packages/fs/src/utils/fs.ts`. Assert the CEILING: no save writes more than one tail plus its
      batch PLUS the cursor record, and the 100th append costs no more than the 10th at the same tail
      phase. Count the cursor record explicitly: it is bounded by `finality` blocks WITH their events,
      not by the tail, so a ceiling stated as "one tail plus its batch" is violable by a correct
      implementation. (Asserting the
      tenth equals the first is false by design — a tail absorbs several batches before sealing.)
      Wall-clock would be flaky on a loaded machine, per ADR-0032.
- [ ] **A crash between a TAIL APPEND and the cursor write is recovered**, which is the MAJORITY
      case and the one an ordinal-only rule misses: the tail grows at the SAME ordinal, so nothing
      exceeds `committedThrough`. Assert the tail is TRUNCATED to `committedEvents` on load, and that
      the resumed cursor then covers exactly the events present. Without this the overshooting tail
      is kept and the next fetch appends duplicates.
- [ ] **A save with NO events writes ONLY the cursor record** — not the tail — asserted at the
      instrumented seam. This is story 3 on the filesystem, and it is the behaviour the whole
      cursor-record design was bought for, so it must be asserted here and not only in the browser.
- [ ] **A TORN segment file degrades instead of throwing**: segments are written through
      temp-file-plus-rename like the cursor, and a segment that still fails to parse is treated as a
      GAP at its ordinal. Assert nothing raises out of `fetchFrom` — `indexer.ts` does not wrap it and
      `JSON.parse` sits outside `storage().get`'s `try`, so a throw makes the indexer permanently
      unloadable.
- [ ] **Segments with NO cursor record finish the clear**, asserted by the keeper rather than left to
      the indexer: the state-kept branch has no `else` on an undefined `fetchFrom`, so nothing else
      would.
- [ ] **A save that would create a HOLE clears instead**: after a contiguity refusal, a save whose
      `fromBlock` sits above the recovered cursor must clear the stream rather than append over a gap
      no reader could detect.
- [ ] **A crash never leaves the cursor AHEAD of its events**, asserted by interrupting a save at the
      instrumented seam, INCLUDING the first save after a legacy adoption. Assert the cursor is
      written LAST, and that a segment above it is DISCARDED as an orphan on the next load rather
      than replayed. This is the atomicity guard.
- [ ] **No stored SEGMENT contains a `lastSync`**, while the **CURSOR RECORD carries the whole of
      it**, unchanged from what the single blob stores today. Assert BOTH halves: the per-segment copy
      is the duplication this change removes, and the cursor's copy is existing behaviour you are NOT
      changing (this task changes no published type). Do not "optimise" `unconfirmedBlocks` out of the
      cursor — stripping it is the sibling spec `the-stream-stores-only-what-the-node-said`'s job and
      it has its own reasoning and its own tests.
- [ ] **The cursor comes from the cursor record**, and an ORPHAN is identified by ORDINAL: a segment
      whose ordinal exceeds `committedThrough` is discarded on load. Assert this with a segment whose
      BLOCK numbers are LOWER than the cursor's `lastToBlock` (the reorg case), which a
      block-number-based orphan test would wrongly keep.
- [ ] **`clear` deletes the CURSOR FIRST, then the segments**, asserted by interrupting between the
      two: the remains must read as ABSENT (so the next load re-clears and finishes) rather than as a
      present stream claiming coverage it does not have.
- [ ] **A sealed segment is never rewritten** (no write ever targets its key again) and is **readable
      by its own key** without reading the others.
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order. Strict equality — this task changes no event shape.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events.
- [ ] **Replay across a reorg** returns retractions in APPEND order, so a rebuild sees what the live
      run saw.
- [ ] **Enumeration does not cross chains**: two streams sharing a name on chains `1` and `10`, where
      `clear` on one leaves the other intact and its replay unpolluted. This fails loudly under a
      bare prefix filter.
- [ ] **The fs keeper shares its folder with `keepStateOnFile`** (state keys are `<name>_<chainId>`);
      a test asserts a `clear` on the stream leaves state keys untouched. The anchored pattern is
      what makes that true rather than luck.
- [ ] **`clear` removes everything**: clear a multi-segment stream, confirm the next `fetchFrom`
      returns nothing and no orphan survives.
- [ ] **A gap in the ordinals CLEARS FROM THE GAP UPWARD AND KEEPS THE PREFIX**, rather than being
      replayed as a shorter stream, thrown, or resolved by wiping the stream. Assert all three: after
      punching a hole at ordinal `k`, (a) nothing raises, (b) `fetchFrom` returns a DEFINED result
      whose events are exactly those of segments `0..k-1`, and (c) the prefix is TRUNCATED to a
      segment boundary at or below `latestBlock - finality` and the cursor rewritten from THAT
      segment with an empty window. Assert (c) explicitly: without the truncation the next scan
      starts below `lastToBlock` and, with an empty window, `generateStreamToAppend` re-emits the
      whole overlap as NEW, permanently duplicating up to `finality` blocks. If nothing survives,
      DELETE the cursor so the stream reads as absent. An interrupted `clear` is the designed-for case: the
      fs `clear` is N `unlinkSync` calls and is not atomic, so a half-cleared stream is reachable in
      normal operation, not only under fault injection.
- [ ] **A gap does NOT wipe a healthy prefix**, asserted as the paired negative: a stream with a hole
      near its tail still answers from everything beneath the hole after the refusal has run.
      Contiguity means no holes, NOT "starts at ordinal 0" — assert that an adopted legacy stream
      followed by `_0.._N` is accepted rather than refused for not starting at `_0`.
- [ ] **The migration**: write a stream in the shipped blob format, read it with the new code, assert
      NO re-fetch. Separately, a legacy blob whose raw half a `logValues` projection dropped is
      CLEARED, per ADR-0034's mandate — clearing a stream that cannot be re-read is correct, and what
      is forbidden is clearing a READABLE stream merely because its shape is old.
- [ ] A clear or a migration says so through the existing logger rather than happening in silence.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None — can start immediately.

## Prompt

Read `work/specs/proposed/appending-to-the-stream-costs-the-batch.md` in full first: it is the source
spec and carries the reasoning behind every rule above, including why several tempting alternatives
are wrong.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
it still match the code in `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a
dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT
build on the stale premise — route the task to needs-attention with the discrepancy as the reason
(WORK-CONTRACT.md, "Drift is a needs-attention signal"). Building on a stale task produces
wrong-but-compiling work.

**Where to look.** The two keepers are `packages/fs/src/storage/stream/OnFile.ts` and
`packages/browser/src/storage/stream/OnIndexedDB.ts` — read both even though you only change the
first, because the helper you write has to serve both and the browser one lands in the sibling task
`the-browser-stream-keeper-appends-in-segments`. The port they sit on is
`packages/fs/src/utils/fs.ts`. The consumer is `packages/core/src/indexer.ts` (five `clear` call
sites, and the branch that clears when `fetchFrom` returns undefined). The reorg re-append is in
`packages/core/src/internal/engine/utils.ts`. Prior art for a keeper test is
`packages/fs/test/keepStateOnFile.test.ts`.

**Domain vocabulary.** A *segment* is one stored batch of EVENTS, and nothing else. The *tail* is the
open, highest-ordinal segment; everything below it is *sealed* and immutable. The *cursor* is ONE
record per stream, written last as the commit point. The stored stream is an *emission
stream*: it records what the indexer emitted, including retractions, not a block-ordered history.

**The constraints that are easy to get wrong**, each of which has a criterion above:

- Segments are keyed by ORDINAL, and the READ is still a full ordered scan. Segmentation is a
  WRITE-path optimisation only. A later segment can hold LOWER block numbers, so no segment may be
  skipped on a block bound. Do not make reads cheaper; the reorg model forbids it.
- ADR-0006 is relevant for its ORDERING argument ONLY: `(blockNumber, logIndex)` is neither unique
  nor monotonic over an emission stream, so it cannot key one. Its `seq` is a SERVER concept for
  query cursors. Do NOT invent a per-event sequence client-side, and do not import ADR-0006's two
  views, cursor validation or compaction into a cache that has none of those problems.
- Every save writes TWO things, a segment and the cursor record, and they must COMMIT TOGETHER: one
  `setMany` transaction on IndexedDB, cursor-written-last plus discard-what-it-does-not-cover on the
  filesystem. Do NOT collapse them back into one key.
- Enumerate with an ANCHORED regex. A `startsWith` on the storage id is a silent cross-chain data
  corruption, not a style preference.

**Tests must not touch the real environment.** Point every keeper at a temp/scratch folder and assert
no real home/config path is written. The module-level `node:fs` mock behind `packages/fs/src/utils/fs.ts`
is the instrumented seam the cost assertions use, and it is CHOSEN by the spec deliberately: the
alternative (an injected optional writer) would widen `keepStreamOnFile`, which is published surface,
and contradict this spec's no-published-type promise.

**Scope fence.** Do NOT make the stream raw-only — that is `the-stream-stores-only-what-the-node-said`
and it is a breaking public API change. Do NOT add per-segment block-range metadata: nothing
consumes one, since each segment already carries its scanned extent and no design selects a block
prefix of another stream's segments. Do NOT
touch `packages/browser` — the browser keeper is the sibling task's file.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (the
seal threshold you pick and why; how the legacy shape is recognised structurally; exactly what a
contiguity refusal does and how it is logged). That block is the ONE sanctioned channel for
build-time rationale and the
runner transcribes it into the done record. Do NOT write the done record, the commit message or the
PR body yourself, and do NOT open an observation note for decisions. If a choice meets the ADR gate
(hard to reverse + surprising without context + a real trade-off), also write it as an ADR in
`docs/adr/` and name it in the block.

---

### Claiming this task

```sh
dorfl claim segment-the-stream-behind-one-core-helper --arbiter origin
git fetch origin && git switch -c work/segment-the-stream-behind-one-core-helper origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/segment-the-stream-behind-one-core-helper.md work/tasks/done/segment-the-stream-behind-one-core-helper.md
```

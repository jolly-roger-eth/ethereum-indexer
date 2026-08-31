---
title: 'Segment the stream behind one core helper, and put the fs keeper on it'
slug: segment-the-stream-behind-one-core-helper
spec: appending-to-the-stream-costs-the-batch
blockedBy: []
covers: [1, 3, 4, 5, 6, 7]
---

## What to build

The stream stops being one blob rewritten in full on every append and becomes an **append-only log of
segments**, with the rules in ONE core helper that both keepers consume. This task builds the helper
and puts the **filesystem** keeper on it end to end. The browser keeper is
`the-browser-stream-keeper-appends-in-segments`.

Today `keepStreamOnFile` reads the entire accumulated stream, concatenates and serialises all of it
back on every `saveNewEvents`. `save` runs once per index cycle, so a backfill is QUADRATIC, and the
empty-batch branch pays the same cost purely to move `lastSync`.

### The shape

- **An append-only log with an OPEN TAIL.** The newest segment is OPEN; a save appends to it, which
  is bounded by the tail plus its batch and never by the history. The tail is SEALED when it exceeds
  a size threshold and the next save opens a new one.
- **The seal threshold is counted in EVENTS**, not bytes. Bytes are natural on the filesystem and not
  cheaply available on IndexedDB (structured-clone size is not exposed), so naming the unit is what
  stops the two keepers choosing differently and makes the seal test deterministic.
- **Keys are ORDINAL and the read stays a full ordered scan.** The stored stream is an EMISSION
  stream: on a reorg the indexer re-appends superseded events at their ORIGINAL `blockNumber` flagged
  `removed`, then continues at LOWER block numbers. So block ranges overlap, cannot key anything, and
  no segment can be skipped on a block bound. `fetchFrom(source, fromBlock)` KEEPS its signature and
  semantics: read every segment in ordinal order, concatenate, apply the existing
  `blockNumber >= fromBlock` filter. Segmentation is a WRITE-path optimisation only.
- **Enumeration is ANCHORED, never a bare prefix.** Stream keys are `stream_<name>_<chainId>`, so
  with an ordinal appended the chain-`1` prefix is ALSO a prefix of every chain-`10` key
  (`stream_tag_10_0`). Match `^stream_<name>_<chainId>_(\d+)$`.
- **Presence is "the read-cursor operation returns something".** State it that way and NOT as "the
  tail", because the other keeper has no tail on two paths that must still read as present: an empty
  first save writes only a cursor record and no segment, and a legacy adoption writes nothing at all.
  A tail-shaped presence check reports absent there and `indexer.ts` clears a perfectly good stream.
  On THIS keeper the read-cursor operation happens to read the tail, which is an implementation of
  the rule and not the rule. `fetchFrom` must keep returning a DEFINED result for a stream saved to
  but holding no events, because that is what stops `indexer.ts` taking its clear branch.

### The SEGMENT RECORD, which the helper owns and neither keeper may re-shape

The helper reads segments (it concatenates them for `fetchFrom`, and the recovery reads the surviving
top one), so their encoding cannot be a keeper's private choice even though the CURSOR's placement
is. Pin it here, because the two keepers describe it differently and only one of them can be right:

- **A segment is `{events, extent}`**, where the extent is the SCANNED extent
  `{lastFromBlock, lastToBlock, latestBlock}` current after those events. Both keepers write this
  shape and the helper reads it on both.
- **The extent is NOT the cursor.** A cursor is a whole `LastSync` (the three block numbers PLUS the
  `context` PLUS `unconfirmedBlocks`); the extent is the three block numbers only, and it exists so a
  truncated prefix can say where it got to.
- **A keeper MAY additionally carry its cursor inside the tail segment record** — that is exactly
  what the tail strategy is, and it is why this keeper's tail is `{events, extent, lastSync}` while
  the cursor-record keeper's segments are `{events, extent}` and nothing else. The helper never
  reads a segment's `lastSync`; it goes through the read-cursor operation for that. So a keeper that
  stores no cursor in its segments is conforming, not deficient.

That last line is what makes ONE helper serve both keepers. Do not let the tail's extra field leak
into the helper's read path.

### The CURSOR CONTRACT — four properties, and they are what the helper enforces

WHERE a keeper puts its cursor is the KEEPER's business. The helper enforces the properties:

1. **Exactly ONE authoritative cursor per stream.** A reader never chooses between competing copies.
2. **A save is atomic in the CURSOR-AHEAD direction.** A cursor claiming coverage the stored events
   do not have is silent data loss. Cursor-BEHIND is tolerable only if the excess is detectable and
   discardable.
3. **No unconfirmed WINDOW accumulates per sealed segment.** Narrow ON PURPOSE: `unconfirmedBlocks`
   is `EventBlock[]` and `EventBlock` carries the FULL decoded events of each block, so a per-segment
   copy is up to `finality` blocks of event data, forever, read by nothing.
4. **An empty save costs nothing proportional to the history.**

### How the fs keeper satisfies them: the TAIL strategy

The two shipped keepers satisfy the contract DIFFERENTLY, and the helper must not assume either.
IndexedDB has an atomic multi-key write, so the browser keeper commits a segment and a SEPARATE
CURSOR RECORD in one `setMany` transaction — property 3 is vacuous there and there is no seal-strip.
The filesystem has no multi-file transaction, so it uses the tail. Build the helper so both are
expressible through the keeper-supplied cursor operations, and test the fs one here.

- **A save writes exactly ONE key — the open tail — holding its events AND the `lastSync` current
  after them.** One key is one write, so property 2 holds by CONSTRUCTION: there is nothing to order,
  no transaction to need, and no orphan rule.
- **Sealing EMPTIES the window.** When a save opens segment `N+1` it rewrites segment `N` with
  `unconfirmedBlocks` emptied, KEEPING the three block numbers and the context. That is property 3.
  **Order: commit the NEW tail first, then seal the old one.** Stated as a rule rather than left
  implied by the safe-to-fail criterion below. Either order is in fact recoverable —
  `generateStreamToAppend` rebuilds `unconfirmedBlocks` from the replayed events on every load
  branch, so no path ever scans off a stripped window — but pinning it makes the interrupt test
  deterministic.
- **The narrowness is load-bearing.** Every TRUNCATION PATH — the contiguity refusal keeping a
  prefix, and (later) a paused generation dropping its non-final points — makes a formerly-SEALED
  segment the new tail, and `StreamFetcher` must return a `LastSync` whenever it returns anything.
  `lastToBlock` is the SCANNED extent and is NOT derivable from the events, because a range that
  yielded no events leaves no trace. Strip the whole `lastSync` and a truncated prefix cannot say
  where it got to.
- **The strip is one extra write per SEAL, not per save, and is OFF THE CRITICAL PATH.** If it never
  happens, segment `N` keeps a stale window nothing reads (the live cursor is the TAIL's, and the
  tail is the highest ordinal) and the next pass empties it. Idempotent and safe to fail, so it needs
  no ordering rule and no recovery.
- **`sealed` means AFTER the strip.** The immutability assertion is over writes after that point;
  the strip itself is the sealing act.
- **The empty save rewrites the tail, and that is ACCEPTED.** `indexer.ts` calls `save`
  unconditionally (the `eventStream.length > 0` guard beside it covers only state updates), so a
  head-following indexer pays one tail rewrite per poll. It is bounded by the SEAL THRESHOLD and
  never by the history, which is what story 1 claims, and it is tunable.

**Do NOT hard-code the tail strategy into the helper.** Cursor PLACEMENT is where substrates
genuinely differ, and a SQL keeper with atomic multi-row updates should be able to hold its cursor in
its own row and satisfy properties 1 and 2 through its transaction, making 3 vacuous. So the helper
takes the cursor operations FROM the keeper and owns only the rules that must not drift. The fs
keeper supplies the tail implementation of those operations.

**FIVE keeper operations, and the last two are the ones a first draft omits.** Getting this list
wrong is what strands
the sibling keeper, because it may not edit the helper:

1. **commit-segment-with-cursor** — write a segment and make the cursor current, together.
2. **read-cursor** — the live cursor, or nothing. This is also what PRESENCE is.
3. **write-cursor-only** — move the cursor with NO segment. The cursor-record keeper needs it for an
   empty save and the truncation rewrite; on the tail keeper it is a tail rewrite.
4. **seal-segment** — make the segment at a given ordinal sealed. The helper DECIDES when to seal
   (the threshold, counted in events); the keeper decides what sealing COSTS. On the tail keeper it
   rewrites that segment with `unconfirmedBlocks` emptied; on a keeper whose cursor was never in a
   segment it is a NO-OP, and that is the whole reason it is a keeper operation rather than a helper
   `set`. A helper that stripped by writing the segment itself would rewrite a key the other keeper
   asserts is never written again, and that keeper could not fix it without editing the helper.
5. **clear-cursor** — forget the cursor. Needed because `clear` is enumerate-and-delete over an
   ANCHORED ordinal pattern, and a cursor held OUTSIDE a segment is deliberately keyed so that
   pattern REJECTS it. Without this operation a cleared stream keeps a cursor claiming coverage of
   an empty history, which is the cursor-AHEAD direction property 2 forbids, and it is not
   self-healing: `indexer.ts:590` finds `streamMatches` still passing, so it does not re-clear, and
   the next save's `fromBlock` sits BELOW the stale `lastToBlock + 1` so the hole guard does not fire
   either. The stream then holds head events only while claiming block 0 upward, and the next
   state discard replays that as if it were whole. This is the repo's own precedent, not a novelty:
   the `StateStore` cursor port is `readCursor`/`writeCursor`/`clearCursor` for the same reason.

The tail keeper implements clear-cursor as "delete the tail", which its `clear` does anyway, so this
costs it nothing; it exists so the seam is complete for the keeper that needs it.

**`clear` runs CLEAR-CURSOR FIRST, then deletes the segments.** The two are not one transaction on
every substrate (on IndexedDB they are a separate cursor write and a `delMany`), so the order is what
makes the crash-interrupted middle safe. **State the RULE as the PROPERTY, not as an outcome, because
the outcome differs per keeper and the general phrasing is false on one of them:** an interrupted
`clear` must never leave a cursor claiming coverage the surviving events lack (the cursor-AHEAD
direction). Concretely:

- on the CURSOR-RECORD keeper, cursor-first leaves segments with no cursor at all, so presence reads
  ABSENT and the next load self-heals through `indexer.ts`'s clear branch;
- on the TAIL keeper, clear-cursor IS deleting the tail, which merely promotes `_N-1` — and a sealed
  segment still carries its `lastSync` minus the window, so read-cursor returns something and
  presence stays TRUE. That is NOT absent and must not be asserted as such. It is the ordinary
  shorter-but-valid prefix this task already documents for an interrupted `clear`, and it is safe
  because the cursor is BEHIND the events rather than ahead of them.

Segments-first is what is forbidden on both: it leaves a cursor over no events, the non-self-healing
state clear-cursor exists to prevent. Note the consequence for the honesty of the gap analysis:
`clear` is now TWO operations on the cursor-record keeper, so "a partial clear cannot happen at all
there" is no longer true — what is true is that the reachable partial state is the SAFE one.

### Recovery, and what it must not do

- **The recovery SEQUENCE is the helper's, in this order, because one keeper has a window the other
  does not.** On finding a hole at `k`: read the surviving top segment (`k-1`) for its EXTENT;
  compose the recovered cursor from that extent plus the `context` of the cursor read before the
  recovery, with an EMPTY `unconfirmedBlocks`; **write-cursor-only** that recovered cursor; and only
  THEN delete `k` and everything above. Deleting first leaves an observable window where the cursor
  describes segments that are gone, and — worse on the cursor-record keeper — the ordinals are
  contiguous again afterwards, so the gap can never be re-detected. Carry the `context` FORWARD
  rather than fabricating one: a segment's extent has no `context`, `LastSync` requires one, and
  `indexer.ts` reads it through `streamMatches` on both load branches, so a fabricated one CLEARS the
  very prefix this recovery exists to keep. On the tail keeper the write-cursor-only call is
  satisfied by the surviving tail already being the cursor, so the sequence is a no-op there and is
  still the same sequence.
- **IF NOTHING SURVIVES, the stream is GONE, not empty-but-present.** A gap at ordinal 0 with no
  adopted legacy segment leaves the recovery no `k-1` to read an extent from. It must then
  CLEAR-CURSOR, so presence reads FALSE and the next load takes `indexer.ts`'s clear branch — an
  empty stream is honest where a stream claiming coverage it lacks is not. State this explicitly
  because the presence rule changed underneath it: when presence was "a tail exists" this case was
  self-evident, and now that presence is the CURSOR, the cursor-record keeper would otherwise read
  PRESENT with zero events and a cursor claiming block 0 upward, which is the worst state in this
  whole design.
- **A gap in the ordinals is REFUSED, the refusal CLEARS FROM THE GAP UPWARD, and the PREFIX BENEATH
  SURVIVES.** A GAP is a HOLE in the enumerated ordinals (`_0`, `_1`, `_3`), found on load, meaning a
  fragment was lost — replaying what remains as if it were the whole stream is silent wrong state.
  Be honest about WHEN it happens, because the obvious answer is no longer right: an interrupted
  `clear` does NOT produce one, since `clear` deletes from the highest ordinal DOWNWARD and so leaves
  a contiguous prefix, and on IndexedDB `delMany` is one transaction so a partial clear cannot happen
  at all. What remains are external deletion and CORRUPTION (a segment that fails to parse is treated
  as a gap at its ordinal). Rare, but the check is nearly free because the ordinals are being
  enumerated anyway, and the failure it prevents is the worst kind. Not a throw: `indexer.ts` calls `fetchFrom` with no `try`/`catch` in that method and
  the browser wrapper only records `FAILED_TO_LOAD` and rethrows, so a throw makes the indexer
  permanently unloadable — for a LOCAL CACHE whose correct recovery is to re-fetch. Not a whole-stream
  wipe either: that discards a good prefix (story 5) and, on the state-kept path, is SILENT, because
  `indexer.ts` only clears there when `streamMatches` fails.
- **Contiguity means NO HOLES, not "starts at ordinal 0."** After a legacy adoption the earliest
  segment is the legacy key.
- **KEEPING THE PREFIX IS ISOLATED AND REMOVABLE. Build it so it can be deleted.** Gaps are not
  routine (see above), so keeping a prefix rather than clearing rests on one argument — that when a
  gap does happen, a full re-index may be impossible on a public node. That may not always hold, so:
  put the recovery behind ONE seam with ONE call site, such that replacing it with "detect the gap,
  clear the stream" is a local change; and treat the SCANNED EXTENT on a sealed segment as having
  EXACTLY ONE READER, that recovery. It exists only to make a truncated prefix resumable. Do not use
  it for anything else, and do not let any other code path assume a truncated stream is resumable —
  a second consumer would silently make this permanent.
- **A save that would create a HOLE clears instead.** After a refusal the stream is short; a save
  whose `fromBlock` sits above the surviving tail's `lastToBlock + 1` would leave the stream claiming
  coverage it lacks, which no reader can detect.
- **`clear` deletes from the HIGHEST ordinal DOWNWARD.** The fs `clear` is N `unlinkSync` calls and
  is not atomic, so an interrupted clear is reachable in normal operation; downward leaves a
  contiguous prefix whose tail carries its own cursor, upward leaves a hole for no benefit.
- **Segments are written through temp-file-plus-rename.** A bare `writeFileSync` can leave a TORN
  file, and `storage().get` wraps only `readFileSync` in its `try`/`catch` — `JSON.parse` is OUTSIDE
  it — so a torn segment THROWS out of an unwrapped `fetchFrom`. Rename is atomic for one file. The
  temp name must be one the anchored pattern REJECTS (the temp sits in the same directory for the
  rename to be atomic, so `readdir` returns it, and a numeric suffix would parse as a phantom high
  ordinal and trip the contiguity refusal). A segment that still fails to parse is treated as a GAP.

### `clear` and the migration

- **`clear` is first-class.** It deletes a single storage id today; with N segment keys a naive port
  orphans every segment but one, after which the next save appends beside a dead prefix and the next
  `fetchFrom` concatenates it into the replay — wrong state, SILENTLY. Called from five paths in
  `indexer.ts`.
- **Enumerate; do not add a head pointer.** A head is a second thing that can disagree and cannot
  detect a partial clear. `packages/fs/src/utils/fs.ts` is our file and a `readdir` away from `keys`.
- **The legacy blob is ADOPTED IN PLACE, never copied.** It carries no format field, so the old shape
  is recognised structurally. It already contains a `lastSync`, so it IS a valid tail the moment it
  is adopted and the adoption writes NOTHING. It is stripped and sealed like any other tail when `_0`
  is opened — a one-time rewrite of the adopted blob, once per upgrade and off the critical path, so
  the cost assertion must not read it as a regression.

## Acceptance criteria

- [ ] A core helper implements segmentation over an injected `get`/`set`/`del`/`delMany`/`keys` port
      PLUS keeper-supplied operations, so cursor PLACEMENT and seal COST are not baked in. **FIVE
      operations**: commit-segment-with-cursor, read-cursor, **write-cursor-only**, **seal-segment**
      and **clear-cursor**. The last three are not optional — the cursor-record keeper needs
      write-cursor-only for an empty save (no segment) and for the truncation rewrite (no segment);
      seal-segment because a helper-issued segment write would rewrite a key that keeper asserts is
      never rewritten, while there sealing must cost nothing; and clear-cursor because its cursor is
      keyed so the anchored ordinal pattern REJECTS it, so enumerate-and-delete cannot reach it. A
      seam missing any of them leaves that keeper unable to satisfy its own criteria inside its scope
      fence. `keepStreamOnFile` supplies the tail implementation of all five (seal-segment empties the
      window; clear-cursor deletes the tail) and `packages/fs/src/utils/fs.ts` gains `keys`, `delMany`
      and an atomic write.
- [ ] **The SEGMENT RECORD shape is the HELPER's and is `{events, extent}`**, extent being
      `{lastFromBlock, lastToBlock, latestBlock}`. The helper never reads a segment's `lastSync`: it
      reads the cursor through read-cursor. A keeper MAY carry its cursor inside the tail record as
      well (that is the tail strategy), and a keeper whose segments carry no cursor at all is
      CONFORMING. Assert the helper's read path works against a segment record with no `lastSync` in
      it, so the sibling keeper is not blocked by an fs-shaped assumption.
- [ ] **PRESENCE is the read-cursor operation returning something**, asserted at the helper rather
      than as "a tail exists": the other keeper reads present with NO segment (an empty first save, an
      adopted legacy blob), and a tail-shaped check would clear a good stream there.
- [ ] **`clear` clears the CURSOR FIRST, then the segments**, asserted by interrupting between the
      two. Assert the PROPERTY, which holds on both keepers — what remains never has a cursor
      claiming coverage the surviving events lack — and not a single outcome: on THIS keeper
      clear-cursor deletes the tail and promotes `_N-1`, which still carries a `lastSync`, so the
      interrupted middle is a shorter VALID prefix (cursor-BEHIND) and presence stays TRUE. Reading
      ABSENT there would be wrong, and the cursor-record keeper is where ABSENT is the right
      assertion.
- [ ] **A recovery that leaves NO segment clear-cursors**, so presence reads FALSE rather than
      leaving an empty-but-present stream with a cursor claiming block 0 upward.
- [ ] **`clear` also clears the CURSOR.** Assert that after `clear` the read-cursor operation returns
      nothing, so presence reads FALSE. This is what stops a stream that was cleared coming back as
      an empty history with a cursor claiming coverage from block 0 — which `indexer.ts` does not
      re-clear (`streamMatches` still passes) and the hole guard does not catch (the next
      `fromBlock` is below the stale `lastToBlock + 1`), so the next state discard replays head-only
      events as if they were the whole stream.
- [ ] **The recovery SEQUENCE is asserted in order**: read the surviving top segment's extent,
      compose the recovered cursor from it plus the PRE-recovery cursor's `context` and an empty
      window, write-cursor-only, THEN delete from the gap upward. Assert the `context` is carried
      forward and not fabricated (a fabricated one fails `streamMatches` and clears the kept prefix).
- [ ] Core's `index.ts` re-exports the helper (core's `exports` map is only `.` and
      `./package.json`), so **ship a changeset**, scoped to `@etherfold/core` and `@etherfold/fs`.
      The sibling ships its own for `@etherfold/browser`.
- [ ] **The four CURSOR CONTRACT properties are asserted against the KEEPER**, not against a layout:
      one authoritative cursor; no cursor claiming coverage the events lack; no unconfirmed window on
      a SEALED segment; an empty save costing nothing proportional to history.
- [ ] **A save writes exactly ONE key** — the atomicity guard for the tail strategy — including an
      empty save and the first save after a legacy adoption.
- [ ] **Sealing empties the WINDOW and keeps the rest**: after a seal, the sealed segment's
      `unconfirmedBlocks` is empty while its `lastFromBlock`/`lastToBlock`/`latestBlock`/`context`
      survive, and the new tail carries a full `lastSync`. Assert the paired negative: a sealed
      segment must still be able to say where the stream got to.
- [ ] **A SEAL is safe to fail**: interrupt between opening the new tail and stripping the old, and
      assert the stream still reads correctly (the stale window is ignored, the live cursor being the
      tail's) and that a later pass empties it.
- [ ] **The cursor comes from the TAIL**, with no competing copy, and a sealed segment offers none.
- [ ] **Append cost is asserted as WORK, not wall-clock**, at a module-level mock of `node:fs` behind
      `packages/fs/src/utils/fs.ts`. Assert the CEILING: no save writes more than one tail plus its
      batch, and the 100th append costs no more than the 10th at the same tail phase. (The tenth
      equalling the first is false by design — a tail absorbs several batches before sealing.)
      Wall-clock would be flaky on a loaded machine, per ADR-0032.
- [ ] **A save with NO events rewrites only the open tail**, never the history — story 3 on the
      filesystem, bounded by the seal threshold.
- [ ] **A gap CLEARS FROM THE GAP UPWARD AND KEEPS THE PREFIX**: after punching a hole at `k`,
      nothing raises, `fetchFrom` returns a DEFINED result whose events are exactly `0..k-1`, and the
      resumed cursor is the new tail's. Paired negative: a healthy prefix is not wiped, and an adopted
      legacy stream followed by `_0.._N` is accepted rather than refused for not starting at `_0`.
      Note an interrupted `clear` is NOT a trigger — deleting downward leaves a contiguous prefix — so
      induce the gap directly (delete a middle segment, or corrupt one) rather than by half-clearing.
- [ ] **A TORN segment degrades instead of throwing**: temp-file-plus-rename, a temp name the
      anchored pattern rejects, and a still-unparseable segment treated as a gap.
- [ ] **A save that would create a HOLE clears instead.**
- [ ] **The prefix-keeping recovery is REMOVABLE**, demonstrated rather than asserted: it lives behind
      one seam with one call site, and the sealed segment's scanned extent has exactly one reader.
      Record in your `## Decisions` block what deleting it would take — it should be replacing that
      one call with a `clear`, plus dropping the scanned extent from the segment shape.
- [ ] **`clear` deletes from the HIGHEST ordinal DOWNWARD**, asserted by interrupting it: what remains
      is a contiguous prefix that still reads, not a hole.
- [ ] **`clear` deletes the ADOPTED LEGACY KEY BY NAME**, not by enumeration. `stream_<name>_<chainId>`
      carries NO ordinal, so the anchored pattern REJECTS it by construction — the same blind spot as
      the cursor record, and the second instance of it. Left behind, it survives a `clear`, then reads
      as a valid tail carrying its own `lastSync`, and `indexer.ts`'s `reset()` (clear the stream,
      clear the processor, load) replays the stale pre-upgrade prefix into a freshly-cleared
      processor: story 6 broken SILENTLY, with no crash and no gap to detect. Correspondingly,
      **clear-cursor means "forget the cursor from EVERY source it can come from"**, which on a keeper
      whose read-cursor has a legacy fallback includes that blob. Assert a `clear` on an ADOPTED
      stream leaves nothing and reads absent.
- [ ] **`clear` removes everything** and no orphan survives; **enumeration does not cross chains**
      (chains `1` and `10` sharing a name, where a `clear` on one leaves the other intact and its
      replay unpolluted); and a `clear` leaves `keepStateOnFile`'s `<name>_<chainId>` keys in the
      SAME folder untouched.
- [ ] **A sealed segment is never rewritten WHILE IT REMAINS SEALED**, and is **readable by its own
      key**. Scope it that way rather than as "never again": the truncation path deliberately makes a
      formerly-sealed segment the new TAIL, which the next save then appends to, so an unscoped
      immutability assertion and the truncation assertion cannot both pass.
- [ ] **SEALING goes through the keeper's seal-segment operation**, never a helper-issued write to a
      segment key. Assert the fs keeper's seal empties the window, and assert the helper issues no
      segment write of its own at a seal — that is what lets the sibling keeper make sealing free.
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order. Strict equality — this task changes no event shape.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **The migration**: a stream in the shipped blob format is read with no re-fetch; separately, a
      legacy blob whose raw half a `logValues` projection dropped is CLEARED, per ADR-0034.
- [ ] A clear or a migration says so through the existing logger.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None — can start immediately.

## Prompt

Read the source spec `appending-to-the-stream-costs-the-batch` (in `work/specs/proposed/` or
`work/specs/tasked/`) in full first: it carries the reasoning behind every rule above, including why
several tempting alternatives are wrong.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
it still match the code in `work/tasks/done/`, the relevant ADRs, and the tasks it depends on? If a
dependency landed differently, or an ADR superseded an assumption here, do NOT build on the stale
premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
needs-attention signal").

**Where to look.** `packages/fs/src/storage/stream/OnFile.ts` is the keeper;
`packages/browser/src/storage/stream/OnIndexedDB.ts` is its sibling — read it even though you do not
change it, because the helper must serve both. The port is `packages/fs/src/utils/fs.ts`. The
consumer is `packages/core/src/indexer.ts` (five `clear` call sites, the clear-on-undefined branch,
and the state-kept branch that has no `else`). The reorg re-append is in
`packages/core/src/internal/engine/utils.ts`. Prior art for a keeper test is
`packages/fs/test/keepStateOnFile.test.ts`; for a capability-style contract, `packages/state-store`'s
`capabilities.ts` and ADR-0020's conformance suite.

**Domain vocabulary.** A *segment* is one stored batch of events plus the SCANNED EXTENT
(`{lastFromBlock, lastToBlock, latestBlock}`) current after them; that pair is the helper's record
shape on every keeper. The *cursor* is a whole `LastSync` (the extent PLUS the `context` PLUS
`unconfirmedBlocks`) and WHERE it lives is the keeper's own business. On THIS keeper it rides inside
the open tail, so the *tail* is the highest-ordinal segment and holds the live cursor; everything
below is *sealed*, which here means its unconfirmed WINDOW has been emptied while the rest of its
`lastSync` remains. On the sibling keeper the cursor is its own record and no segment holds one at
all, which is CONFORMING — do not write a helper that assumes otherwise. The stored stream is an *emission stream*. A *truncation path* is any path that
deliberately leaves a shorter, still-usable stream — today the contiguity refusal, later a paused
generation — and it is why a sealed segment must still say where the stream got to.

**Easy to get wrong, each with a criterion above:**

- Segments are keyed by ORDINAL and the READ is still a full ordered scan. Do not make reads cheaper;
  the reorg model forbids it.
- ADR-0006 is relevant for its ORDERING argument ONLY. Do NOT invent a per-event sequence
  client-side, and do not import its two views, cursor validation or compaction.
- Enumerate with an ANCHORED regex. A `startsWith` on the storage id is silent cross-chain data
  corruption.
- Do not bake the tail strategy into the helper. Placement is the keeper's. Concretely: the helper
  must not read a segment's `lastSync`, must not define presence as "a tail exists", and must route
  every cursor move and every seal through the five keeper-supplied operations. The sibling task may not edit the
  helper, so anything it needs that you did not build strands it.

**Tests must not touch the real environment.** Point every keeper at a temp/scratch folder and assert
no real home/config path is written. The module-level `node:fs` mock behind
`packages/fs/src/utils/fs.ts` is the instrumented seam the cost assertions use, CHOSEN deliberately:
an injected writer would widen `keepStreamOnFile`. **REVISIT THAT REASON BEFORE FOLLOWING IT**: it
rested on `keepStreamOnFile` being published surface, and nothing is published (`CONTEXT.md`), so
widening costs a changeset and nothing else. Module-level mocking was chosen to avoid a cost that
does not exist. Two better options are now open and either is acceptable: widen the factory with an
optional writer, or — probably best, and available because of this task's own design — instrument the
PORT, since the helper already receives `get`/`set`/`del`/`delMany`/`keys` FROM the keeper, so a test
can pass a counting port and measure write volume exactly with no module mocking and no public
change. Keep a keeper-level round-trip test either way, so the wiring is still proven end to end.

**Scope fence.** Do NOT make the stream raw-only — that is `the-stream-stores-only-what-the-node-said`.
Do NOT add per-segment block-range metadata: nothing consumes one. Do NOT strip `unconfirmedBlocks`
from the TAIL (only sealing empties it, and removing it entirely is the raw-only spec's job). Do NOT
touch `packages/browser`.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (the
seal threshold and why; how the legacy shape is recognised; the temp-name convention; the exact shape
of the keeper-supplied cursor operations). That block is the ONE sanctioned channel for build-time
rationale and the runner transcribes it into the done record. Do NOT write the done record, the
commit message or the PR body, and do NOT open an observation note for decisions. If a choice meets
the ADR gate, write it as an ADR in `docs/adr/` and name it in the block.

---

### Claiming this task

```sh
dorfl claim segment-the-stream-behind-one-core-helper --arbiter origin
git fetch origin && git switch -c work/segment-the-stream-behind-one-core-helper origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/segment-the-stream-behind-one-core-helper.md work/tasks/done/segment-the-stream-behind-one-core-helper.md
```

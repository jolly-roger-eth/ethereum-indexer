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

### The address, which is where most of the old complexity went

**A stream is addressed HIERARCHICALLY**: `[<indexer-name>, <streamDigest>, <ordinal>]` for a segment.
On the filesystem that is `<folder>/stream/<name>/<digest>/<ordinal>.json`; the browser keeper uses
IndexedDB ARRAY keys for the same shape.

This matters more than it looks. An earlier design packed those components into one delimited string
(`stream_<name>_<chainId>_<ordinal>`) and then needed an anchored regex, a documented cross-chain
corruption hazard, a temp-file name that must not parse as an ordinal, and a cursor key deliberately
excluded from the pattern. **All of that was a consequence of the flat namespace, and none of it is
needed here.** Enumeration is a scoped listing: `readdir` of a directory, not a match over every key
in the store.

- **`chainId` is NOT part of the address.** It is already inside the stream digest (the block-0
  skeleton entry hashes `chainId` and `genesisHash`), so two chains produce different digests and
  cannot collide. Including it would be duplication, not protection.
- **The `<streamDigest>` level exists from the start, with a PLACEHOLDER value.**
  `a-reconfigure-is-not-an-outage` computes the real digest; this task neither computes nor invents
  one. Use a single fixed constant, and keep it a level so the successor fills it rather than
  re-keying. Record in your `## Decisions` what constant you used.
- **The canonical pointer is NOT yours** and lives outside the stream tree (`<folder>/canonical/`)
  so a name can never be both a file and a directory. Named only so you do not put it inside.

### The shape

- **An append-only log with an OPEN TAIL.** The newest segment is OPEN; a save appends to it, bounded
  by the tail plus its batch and never by the history. The tail is SEALED when it exceeds a size
  threshold and the next save opens a new one.
- **The open tail, its threshold and the SEAL are THIS keeper's, not a shared rule.** They exist for
  one reason: a save here must be a SINGLE write, because the filesystem has no transaction and that
  is how cursor-ahead atomicity holds. A keeper with a transaction does not need a tail and should
  not have one — the sibling writes one segment per batch and never rewrites anything. So the helper
  must not assume a tail exists: it owns the address, ordinal allocation, read order, the contiguity
  refusal and its recovery, presence and `clear`, and the KEEPER owns how a batch becomes segment(s).
- **The seal threshold is counted in EVENTS**, not bytes, so the seal test is deterministic and does
  not depend on serialised size.
- **Ordinals key the segments and the read stays a full ordered scan.** The stored stream is an
  EMISSION stream: on a reorg the indexer re-appends superseded events at their ORIGINAL
  `blockNumber` flagged `removed`, then continues at LOWER block numbers. So block ranges overlap,
  cannot key anything, and no segment can be skipped on a block bound. `fetchFrom(source, fromBlock)`
  KEEPS its signature and semantics: read every segment in ordinal order, concatenate, apply the
  existing `blockNumber >= fromBlock` filter. Segmentation is a WRITE-path optimisation only.
- **PRESENCE is "the read-cursor operation returns something"**, never "a tail exists". The other
  keeper reads present with NO segment (an empty first save, a legacy adoption), and a tail-shaped
  check would clear a good stream there. `fetchFrom` must keep returning a DEFINED result for a
  stream saved to but holding no events, because that is what stops `indexer.ts` taking its clear
  branch.

### The SEGMENT RECORD, which the helper owns and neither keeper may re-shape

The helper reads segments (it concatenates them for `fetchFrom`, and the recovery reads the surviving
top one), so their encoding cannot be a keeper's private choice even though the CURSOR's placement is.

- **A segment is `{events, extent}`**, the extent being the SCANNED extent
  `{lastFromBlock, lastToBlock, latestBlock}` current after those events.
- **The extent is NOT the cursor.** A cursor is a whole `LastSync` (the three block numbers PLUS the
  `context` PLUS `unconfirmedBlocks`); the extent is the three numbers only, and exists so a truncated
  prefix can say where it got to.
- **A keeper MAY additionally carry its cursor inside the tail segment record** — that is exactly what
  the tail strategy is. The helper never reads a segment's `lastSync`; it goes through read-cursor.
  A keeper whose segments carry no cursor at all is CONFORMING, not deficient.

### The CURSOR CONTRACT — four properties the helper enforces

WHERE a keeper puts its cursor is the KEEPER's business, subject to one invariant below.

1. **Exactly ONE authoritative cursor per stream.** A reader never chooses between competing copies.
2. **A save is atomic in the CURSOR-AHEAD direction.** A cursor claiming coverage the stored events
   do not have is silent data loss. Cursor-BEHIND is tolerable only if the excess is detectable and
   discardable.
3. **No unconfirmed WINDOW accumulates per sealed segment.** Narrow ON PURPOSE: `unconfirmedBlocks`
   is `EventBlock[]` and `EventBlock` carries the FULL decoded events of each block, so a per-segment
   copy is up to `finality` blocks of event data, forever, read by nothing.
4. **An empty save costs nothing proportional to the history.**

**THE INVARIANT: the cursor is addressed WITHIN its stream's subtree.** Wherever a keeper puts it, it
is under `[<name>, <digest>]`. That is what makes `clear` one scoped delete that cannot orphan a
cursor, and it replaces a `clear-cursor` operation an earlier flat-key draft needed because the cursor
sat outside the enumerable pattern.

### FOUR keeper operations, and why each exists

The helper owns the rules that must not drift; the keeper owns what its substrate makes cheap.

1. **commit-segment-with-cursor** — write a segment and make the cursor current, together.
2. **read-cursor** — the live cursor, or nothing. This is also what PRESENCE is.
3. **write-cursor-only** — move the cursor with NO segment. The cursor-record keeper needs it for an
   empty save and for the truncation rewrite; on the tail keeper it is a tail rewrite.
4. **seal-segment** — make the segment at a given ordinal sealed. Only a keeper that keeps an OPEN
   TAIL ever needs it; the sibling implements it as a no-op that is never invoked. Here it rewrites that segment with
   `unconfirmedBlocks` emptied; on a keeper whose cursor was never in a segment it is a NO-OP. It has
   to be a keeper operation rather than a helper-issued `set`, because a helper that stripped by
   writing the segment itself would rewrite a key the other keeper asserts is never rewritten.

There is deliberately NO clear-cursor: see the invariant above.

### How the fs keeper satisfies the contract: the TAIL strategy

IndexedDB has an atomic multi-key write and the filesystem does not, so the two keepers satisfy the
contract DIFFERENTLY and the helper must not assume either.

- **A save writes exactly ONE key — the open tail — holding its events, its extent AND the `lastSync`
  current after them.** One key is one write, so property 2 holds by CONSTRUCTION: nothing to order,
  no transaction to need, no orphan rule.
- **Sealing EMPTIES the window**, keeping the three block numbers and the context. That is property 3.
  **Order: commit the NEW tail first, then seal the old one.** Either order is recoverable
  (`generateStreamToAppend` rebuilds `unconfirmedBlocks` from the replayed events on every load
  branch), but pinning it makes the interrupt test deterministic.
- **The narrowness is load-bearing.** Every TRUNCATION PATH makes a formerly-SEALED segment the new
  tail, and `StreamFetcher` must return a `LastSync` whenever it returns anything. `lastToBlock` is
  the SCANNED extent and is NOT derivable from the events, because a range that yielded no events
  leaves no trace.
- **The strip is one extra write per SEAL, off the critical path.** If it never happens, that segment
  keeps a stale window nothing reads (the live cursor is the tail's) and the next pass empties it.
- **The empty save rewrites the tail, and that is ACCEPTED.** `indexer.ts` calls `save`
  unconditionally, so a head-following indexer pays one tail rewrite per poll. Bounded by the SEAL
  THRESHOLD and never by the history, which is what story 1 claims, and tunable.

### Recovery, and what it must not do

- **A gap in the ordinals is REFUSED, the refusal CLEARS FROM THE GAP UPWARD, and the PREFIX BENEATH
  SURVIVES.** A GAP is a HOLE in the enumerated ordinals (`0`, `1`, `3`), found on load. Replaying
  what remains as if it were the whole stream is silent wrong state. Not a throw: `indexer.ts` calls
  `fetchFrom` with no `try`/`catch` and the browser wrapper only records `FAILED_TO_LOAD` and
  rethrows, so a throw makes the indexer permanently unloadable — for a LOCAL CACHE whose correct
  recovery is to re-fetch. Not a whole-stream wipe either: that discards a good prefix (story 5).
- **Gaps are NOT routine, and the honest list is short.** An interrupted `clear` does not produce one
  (it deletes highest-ordinal-downward, leaving a contiguous prefix). What remains is external
  deletion and CORRUPTION (a segment that fails to parse is treated as a gap at its ordinal). Rare,
  but the check is nearly free because the ordinals are being enumerated anyway.
- **The recovery SEQUENCE is the helper's**: read the surviving top segment (`k-1`) for its EXTENT;
  compose the recovered cursor from that extent plus the `context` of the cursor read BEFORE the
  recovery, with an EMPTY `unconfirmedBlocks`; **write-cursor-only** that; and only THEN delete `k`
  and above. Carry the `context` FORWARD rather than fabricating one: a segment's extent has no
  context, `LastSync` requires one, and `indexer.ts` reads it through `streamMatches` on both load
  branches, so a fabricated one CLEARS the very prefix this exists to keep.
- **The empty window is SAFE, and this is why**: a recovered cursor never drives a scan with an empty
  window, because the prefix is REPLAYED first and `generateStreamToAppend` rebuilds the window from
  the replayed events. Do NOT truncate the prefix to a segment boundary below `latestBlock - finality`
  to "avoid duplication": the indexer scans to head, so a head-era segment has
  `lastToBlock == latestBlock` and NO segment passes that test — it would delete everything.
- **IF NOTHING SURVIVES** (a gap at ordinal 0 with no adopted legacy segment) the stream is GONE, not
  empty-but-present: there is no `k-1` extent to read, so remove the subtree and let presence read
  FALSE. State it explicitly because presence is the CURSOR, so a surviving cursor over no events
  would otherwise be the worst state in this design.
- **KEEPING THE PREFIX IS ISOLATED AND REMOVABLE. Build it so it can be deleted.** Put the recovery
  behind ONE seam with ONE call site, such that replacing it with "detect the gap, clear the stream"
  is a local change; and treat the SCANNED EXTENT on a sealed segment as having EXACTLY ONE READER,
  that recovery. Do not let any other path assume a truncated stream is resumable.
- **A save that would create a HOLE clears instead.** After a refusal the stream is short; a save
  whose `fromBlock` sits above the surviving tail's `lastToBlock + 1` would leave the stream claiming
  coverage it lacks, which no reader can detect.
- **`clear` deletes the stream's SUBTREE**, and on the filesystem that is one directory. Within it,
  delete from the HIGHEST ordinal DOWNWARD, because the fs delete is N `unlinkSync` calls and is not
  atomic: downward leaves a contiguous prefix whose tail carries its own cursor, upward leaves a hole
  for no benefit. The cursor is inside the subtree, so it goes with it and cannot be orphaned.
- **Segments are written through temp-file-plus-rename.** A bare `writeFileSync` can leave a TORN
  file, and `storage().get` wraps only `readFileSync` in its `try`/`catch` — `JSON.parse` is OUTSIDE
  it — so a torn segment THROWS out of an unwrapped `fetchFrom`. Rename is atomic for one file. The
  temp must be excluded from the ordinal listing (a dotfile, or anything the `^\d+\.json$` match
  rejects); this is now a local naming choice inside one directory rather than a cross-stream hazard.
  A segment that still fails to parse is treated as a GAP.

### `clear` and the migration

- **`clear` is first-class.** It deletes a single storage id today; with N segments a naive port
  orphans every segment but one, after which the next save appends beside a dead prefix and the next
  `fetchFrom` concatenates it into the replay — wrong state, SILENTLY. Called from five paths in
  `indexer.ts`.
- **Enumerate; do not add a head pointer.** A head is a second thing that can disagree and cannot
  detect a partial clear. `packages/fs/src/utils/fs.ts` is our file and a `readdir` away.
- **The legacy blob is ADOPTED IN PLACE, never copied.** The shipped keeper writes
  `stream_<name>_<chainId>` (a flat key, no format field, recognised structurally). It already
  contains a `lastSync`, so it IS a valid tail the moment it is adopted and the adoption writes
  NOTHING. It is sealed like any other tail when ordinal 0 is opened — a one-time rewrite, off the
  critical path, so the cost assertion must not read it as a regression. Because it sits OUTSIDE the
  new hierarchical tree, `clear` must delete it BY NAME as well as removing the subtree.

## Acceptance criteria

- [ ] A core helper implements segmentation over an injected `get`/`set`/`del`/`delMany`/`keys` port
      scoped to a stream's subtree, PLUS four keeper operations (commit-segment-with-cursor,
      read-cursor, write-cursor-only, seal-segment). `keepStreamOnFile` supplies the tail
      implementation; `packages/fs/src/utils/fs.ts` gains `keys`, `delMany`, nested-path support
      (`mkdirSync(dirname, {recursive: true})`) and an atomic write.
- [ ] Core's `index.ts` re-exports the helper (core's `exports` map is only `.` and
      `./package.json`), so **ship a changeset**, scoped to `@etherfold/core` and `@etherfold/fs`.
- [ ] **The ADDRESS is hierarchical** — `<folder>/stream/<name>/<digest>/<ordinal>.json` — with the
      digest level present and a placeholder value. Assert that enumeration is a SCOPED listing of one
      directory, that no regex over a flat namespace exists, and that `chainId` appears nowhere in the
      address.
- [ ] **Two streams under one name with different digests do not see each other**: writing, reading
      and clearing one leaves the other complete and readable. This is the successor to the old
      cross-chain test and it must pass by construction rather than by a pattern.
- [ ] **The SEGMENT RECORD is `{events, extent}`** and the helper never reads a segment's `lastSync`.
      Assert the helper's read path works against a record with no `lastSync` in it, so the sibling
      keeper is not blocked by an fs-shaped assumption.
- [ ] **PRESENCE is the read-cursor operation returning something**, asserted at the helper rather
      than as "a tail exists".
- [ ] **The four CURSOR CONTRACT properties are asserted against the KEEPER**, not a layout.
- [ ] **A save writes exactly ONE key** — the tail-strategy atomicity guard — including an empty save
      and the first save after a legacy adoption.
- [ ] **Sealing goes through seal-segment**, empties the WINDOW and keeps the rest, and the helper
      issues no segment write of its own at a seal. Assert the paired negative: a sealed segment must
      still say where the stream got to.
- [ ] **A SEAL is safe to fail**: interrupt between committing the new tail and sealing the old, and
      assert the stream still reads correctly and a later pass empties it.
- [ ] **The cursor comes from the TAIL** here, with no competing copy, and a sealed segment offers
      none.
- [ ] **Append cost is asserted as WORK, not wall-clock.** Assert the CEILING: no save writes more
      than one tail plus its batch, and the 100th append costs no more than the 10th at the same tail
      phase. Wall-clock would be flaky on a loaded machine (ADR-0032). **Instrument the PORT** — pass
      a counting port to the helper — rather than module-mocking `node:fs`. An earlier draft chose
      module mocking to avoid widening a published factory; nothing is published (`CONTEXT.md`), and
      the port is a seam this task already owns. Keep a keeper-level round-trip test so the wiring is
      still proven end to end.
- [ ] **A save with NO events rewrites only the open tail**, never the history — story 3 here.
- [ ] **A gap CLEARS FROM THE GAP UPWARD AND KEEPS THE PREFIX**: after punching a hole at `k`, nothing
      raises, `fetchFrom` returns a DEFINED result whose events are exactly `0..k-1`, and the resumed
      cursor is the new tail's. Paired negative: a healthy prefix is not wiped, and an adopted legacy
      stream followed by ordinals is accepted rather than refused for not starting at 0. Induce the
      gap directly (delete a middle segment, or corrupt one), since an interrupted `clear` is not a
      trigger.
- [ ] **The recovery SEQUENCE is asserted in order**: read the surviving top segment's extent, compose
      with the PRE-recovery cursor's `context` and an empty window, write-cursor-only, THEN delete
      upward. Assert the context is carried forward and not fabricated.
- [ ] **A recovery that leaves NO segment removes the subtree**, so presence reads FALSE rather than
      leaving an empty-but-present stream.
- [ ] **A TORN segment degrades instead of throwing**: temp-file-plus-rename, a temp name the ordinal
      listing rejects, and a still-unparseable segment treated as a gap.
- [ ] **A save that would create a HOLE clears instead.**
- [ ] **The prefix-keeping recovery is REMOVABLE**, demonstrated rather than asserted: one seam, one
      call site, and the scanned extent has exactly one reader. Record in `## Decisions` what deleting
      it would take.
- [ ] **`clear` removes the subtree and the adopted legacy key BY NAME**, deleting within the subtree
      from the highest ordinal DOWNWARD; assert by interrupting that what remains is a contiguous
      prefix that still reads, and that no cursor survives the completed clear. Assert
      `keepStateOnFile`'s own keys in the SAME folder are untouched.
- [ ] **A sealed segment is never rewritten WHILE IT REMAINS SEALED** (the truncation path
      deliberately reopens one as the new tail) and is **readable by its own address**.
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order. Strict equality — this task changes no event shape.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **The migration**: a stream in the shipped blob format is read with no re-fetch; separately, a
      legacy blob whose raw half a projection dropped is CLEARED, per ADR-0034.
- [ ] A clear or a migration says so through the existing logger.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None — can start immediately.

## Prompt

Read the source spec `appending-to-the-stream-costs-the-batch` (`work/specs/tasked/`) and
`docs/adr/0035-*` in full first: the ADR carries the reasoning behind the address shape, the cursor
contract and the four operations, including why several tempting alternatives are wrong.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it
still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed
differently, or an ADR superseded an assumption here, do NOT build on the stale premise — route to
needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

**Where to look.** `packages/fs/src/storage/stream/OnFile.ts` is the keeper;
`packages/browser/src/storage/stream/OnIndexedDB.ts` is its sibling — read it even though you do not
change it, because the helper must serve both. The port is `packages/fs/src/utils/fs.ts`. The consumer
is `packages/core/src/indexer.ts` (five `clear` call sites, the clear-on-undefined branch, and the
state-kept branch that has no `else`). The reorg re-append is in
`packages/core/src/internal/engine/utils.ts`. Prior art for a keeper test is
`packages/fs/test/keepStateOnFile.test.ts`.

**Domain vocabulary.** A *segment* is one stored batch of events plus the SCANNED EXTENT current after
them; that pair is the helper's record shape on every keeper. The *cursor* is a whole `LastSync` and
WHERE it lives is the keeper's business, subject to the invariant that it sits within the stream's
subtree. On THIS keeper it rides inside the open tail, so the *tail* is the highest-ordinal segment and
holds the live cursor; *sealed* here means its unconfirmed WINDOW has been emptied. On the sibling the
cursor is its own record and no segment holds one, which is CONFORMING.

**Easy to get wrong, each with a criterion above:**

- The address is hierarchical. Do not reintroduce a delimited flat key or a pattern match over the
  whole store; enumeration is a scoped listing.
- Segments are keyed by ORDINAL and the READ is still a full ordered scan. Do not make reads cheaper;
  the reorg model forbids it.
- ADR-0006 is relevant for its ORDERING argument ONLY. Do NOT invent a per-event sequence
  client-side, and do not import its two views, cursor validation or compaction.
- Do not bake the tail strategy into the helper. The helper must not read a segment's `lastSync`, must
  not define presence as "a tail exists", and must route every cursor move and every seal through the
  four keeper operations. The sibling task may not edit the helper, so anything it needs that you did
  not build strands it.

**Tests must not touch the real environment.** Point every keeper at a temp/scratch folder and assert
no real home/config path is written.

**Scope fence.** Do NOT make the stream raw-only — that is `the-stream-stores-only-what-the-node-said`.
Do NOT compute a real stream digest or a canonical pointer — those are
`a-reconfigure-is-not-an-outage`'s; use a placeholder for the digest level and do not write outside
`stream/`. Do NOT add per-segment block-range metadata. Do NOT strip `unconfirmedBlocks` from the TAIL
(only sealing empties it). Do NOT touch `packages/browser`.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (the
seal threshold and why; the placeholder digest constant; how the legacy shape is recognised; the temp
name convention; the exact shape of the four keeper operations). That block is the ONE sanctioned
channel for build-time rationale and the runner transcribes it into the done record. Do NOT write the
done record, the commit message or the PR body, and do NOT open an observation note for decisions. If
a choice meets the ADR gate, write it as an ADR in `docs/adr/` and name it in the block.

---

### Claiming this task

```sh
dorfl claim segment-the-stream-behind-one-core-helper --arbiter origin
git fetch origin && git switch -c work/segment-the-stream-behind-one-core-helper origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/segment-the-stream-behind-one-core-helper.md work/tasks/done/segment-the-stream-behind-one-core-helper.md
```

---
title: 'The browser stream keeper appends in segments, on the same core helper'
slug: the-browser-stream-keeper-appends-in-segments
spec: appending-to-the-stream-costs-the-batch
blockedBy: [segment-the-stream-behind-one-core-helper]
covers: [1, 2, 3, 4, 5, 6, 7]
---

## What to build

> **`covers` deliberately OVERLAPS the sibling task's.** Story 2 (no full structured-clone on the
> browser) is this task's alone; stories 1 and 3-7 are the shared `ExistingStream` contract and are
> only shipped FOR A BROWSER USER when this lands — the sibling delivers them on the filesystem.
> Reading the sibling's done record as "story 5 is shipped" would be wrong while every browser user
> still holds the old blob. The overlap is per-substrate, not duplicated work.

Put `keepStreamOnIndexedDB` on the segmentation helper that
`segment-the-stream-behind-one-core-helper` builds, so a save stops structured-cloning the entire
history. Today `OnIndexedDB.ts` reads the whole stream, concatenates and writes it all back on every
`saveNewEvents` — a full structured-clone of the accumulated history per index cycle — and it imports
only `get`/`set`/`del` from `idb-keyval`.

**This is the SECOND independent implementation of one contract, not a second design.** Every rule —
ordinal keys, anchored enumeration, the seal DECISION, the contiguity refusal and its recovery
sequence, legacy adoption, presence, the read order — lives in the helper. This task supplies the
**port** and the **five keeper operations**, and proves the contract holds on IndexedDB.

Two of those helper rules must not be read as the filesystem's. **PRESENCE is "the read-cursor
operation returns something"**, never "a tail exists": here an empty first save and a legacy adoption
both leave NO segment and must still read present. And **SEALING is a keeper operation**, which here
is a NO-OP — the cursor was never inside a segment, so there is nothing to strip and no write to make.

**The CURSOR CONTRACT, which is what the helper enforces and this keeper must satisfy:**

1. exactly ONE authoritative cursor per stream;
2. a save is atomic in the CURSOR-AHEAD direction (a cursor claiming coverage the events lack is
   silent data loss);
3. no unconfirmed WINDOW on a SEALED segment (`unconfirmedBlocks` carries whole blocks WITH their
   events, so a per-segment copy is up to `finality` blocks of event data, forever, read by nothing);
4. an empty save costs nothing proportional to the history.

**This keeper uses the CURSOR-RECORD strategy, NOT the filesystem's tail strategy**, and the
difference is the whole reason the contract was separated from the placement. IndexedDB has an atomic
multi-key write and the filesystem does not:

- a save commits the segment AND a separate cursor record in ONE `setMany` transaction (it opens one
  `readwrite` transaction, puts every entry and awaits `store.transaction`), so property 2 holds
  through the transaction rather than by writing one key;
- **property 3 is VACUOUS here** — the cursor was never inside a segment, so there is nothing to
  strip and NO SEAL-STRIP WRITE AT ALL;
- **property 4 is free** — an empty save writes one small cursor record instead of rewriting the open
  tail, which on the filesystem is the recurring cost of its strategy and is why it uses one.

So do NOT port the tail strategy here. The cursor record's key must be one the anchored segment
pattern REJECTS (that pattern matches a numeric ordinal suffix, so `_cursor` is safely excluded).

**What is the SAME on both keepers**: the helper's segment record is `{events, extent}` with the
SCANNED EXTENT `{lastFromBlock, lastToBlock, latestBlock}`, because the truncation recovery needs a
prefix that can say where it got to. What DIFFERS is only that the fs tail additionally carries its
`lastSync` inside that record, which the helper never reads. The recovery SEQUENCE (rewrite the
cursor from the surviving top segment's extent, then delete upward) is the helper's on both keepers;
it is merely INVISIBLE on the filesystem, where the surviving tail already is the cursor, and
observable here, where a stream-wide cursor record would otherwise be left describing segments that
are gone.

**The substrate facts this rests on**, checked rather than assumed:

- `idb-keyval` (6.2.4) ships `keys`, `getMany`, `setMany`, `delMany`, `entries`, `values`, `update`
  alongside `get`/`set`/`del`. The keeper imports only three. So "the browser keeper cannot
  enumerate" is FALSE — it was inferred from an import line.
- `delMany` is ONE transaction, so a segmented `clear` is atomic here even though the filesystem's is
  not.
- `idb-keyval`'s `clear()` wipes the **WHOLE store**, not one stream's keys. It is a capability, NOT
  the implementation of `ExistingStream.clear`.

**One existing test reaches into the stream key directly and this breaks it.**
`packages/browser/test/invalidation.test.ts` does `get(stream_<tag>_<chainId>)`, asserts it is
defined, and rewrites `lastSync` in place. Update it DELIBERATELY — it is also the closest prior art
for the migration test — rather than patching it blind on a red gate.

## Acceptance criteria

- [ ] `keepStreamOnIndexedDB` is implemented on the core helper, supplying the helper's
      `get`/`set`/`del`/`delMany`/`keys` port over `idb-keyval` plus the FIVE keeper operations
      (commit-segment-with-cursor, read-cursor, write-cursor-only, seal-segment, clear-cursor), of
      which seal-segment is a NO-OP here. No segmentation
      rule is re-implemented here. `setMany` is used INSIDE this keeper's commit operation rather
      than being a port member, so the port type stays exactly the sibling's — check the landed
      helper's port and match it rather than widening it.
- [ ] **A sealed segment is never rewritten WHILE IT REMAINS SEALED, and is readable by its own key**
      (story 7, on this substrate). Scoped that way because the truncation path deliberately makes a
      formerly-sealed segment the new tail that the next save appends to, so an unscoped immutability
      assertion and the truncation assertion cannot both pass. On this keeper sealing writes NOTHING
      at all — assert the seal-segment operation is a no-op here, which is the concrete payoff of the
      cursor never having been in a segment.
- [ ] **Ship a changeset for `@etherfold/browser`.** This changes the persisted IndexedDB layout and
      adds a legacy-blob migration, which is what a browser consumer needs a release note for; the
      sibling's changeset was written before this work existed and cannot describe it. A separate
      file means no merge contention.
- [ ] **No full structured-clone of the history on a save**, asserted as WORK at a module-level mock
      of `idb-keyval`'s **`setMany`** (and `set`, if any path still uses it) behind `OnIndexedDB`.
      Naming only `set` would make this assertion and the one-transaction assertion pass VACUOUSLY,
      because the commit path is `setMany`. Assert the CEILING: no save writes more than one
      tail plus its batch, and the 100th append costs no more than the 10th at the same tail phase.
      Wall-clock cannot be the yardstick: `fake-indexeddb` is itself quadratic, and ADR-0032 rules out
      wall-clock on a loaded machine.
- [ ] **A save commits the segment AND the cursor record in ONE `setMany` transaction**, asserted at
      the instrumented seam — this is how property 2 holds here, and it is why no write-ordering rule
      or crash recovery is needed on this keeper.
- [ ] **An empty save writes ONLY the cursor record**, not the tail — property 4, and the concrete
      advantage of this strategy over the filesystem's.
- [ ] **No ORDINAL segment contains a `lastSync` at all** on this keeper — property 3 is vacuous
      here, so there is no seal-strip to perform and none to test. Every segment DOES carry its
      scanned extent, asserted, because the truncation recovery needs it. **Scope the claim to
      ORDINAL segments, because the ADOPTED LEGACY BLOB is the one exception and it is load-bearing**:
      it is a segment, it DOES contain a `lastSync`, adoption writes nothing, and there is no
      seal-strip on this keeper to ever remove it. So read-cursor here has a PRECEDENCE: the cursor
      record if one exists, else the adopted legacy blob's own `lastSync`. Assert that precedence
      directly — without it an adopted stream has no cursor, `fetchFrom` reads absent, and every
      existing browser user re-fetches their whole history on upgrade, which is story 5 inverted.
- [ ] **The cursor comes from the CURSOR RECORD**, with no competing copy in any ORDINAL segment, and
      its key is one the anchored segment pattern rejects. Scoped to ordinal segments for the same
      reason the no-`lastSync` claim above is: the adopted legacy blob carries its own `lastSync`
      forever and is the documented precedence fallback, so an unscoped no-competing-copy assertion
      and the adoption assertion could not both pass.
- [ ] **The truncation recovery runs the HELPER's sequence and this keeper proves it at its own
      seam**: the cursor record is rewritten from the surviving top segment's extent (carrying the
      pre-recovery `context` forward, with an empty window) BEFORE the `delMany`. The ORDER is
      required and is the helper's, not this keeper's invention — the sibling task owns it. Assert it
      HERE because this is the keeper where it is observable: IndexedDB gives no delete-plus-put
      primitive, so deleting first leaves a window where the cursor describes segments that are gone
      (the cursor-AHEAD direction) and, worse, the ordinals are contiguous again afterwards so the
      gap can never be re-detected. The fs keeper has no such window because its surviving tail IS
      the cursor, which is exactly why the assertion belongs on this side. If the helper landed
      WITHOUT that sequence, that is drift: surface it rather than implementing the order locally.
- [ ] **Presence works when there is NO segment yet.** Two cases the tail rule does not cover here:
      an empty FIRST save writes only the cursor record and no segment; and a legacy adoption writes
      nothing at all, so an adopted stream has its `lastSync` inside the legacy blob and no cursor
      record. Assert `fetchFrom` returns DEFINED in both, or `indexer.ts` takes its clear branch and
      the migration becomes a full re-fetch for every browser user — breaking story 5.
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order, strict equality.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events, which is what stops
      `indexer.ts` taking its clear branch.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **A gap CLEARS FROM THE GAP UPWARD AND KEEPS THE PREFIX**, not thrown and not a whole-stream
      wipe, matching the helper. `indexer.ts` has no `try`/`catch` around `fetchFrom`, so a throw
      leaves the browser indexer permanently unloadable.
- [ ] **Enumeration does not cross chains**: two streams sharing a name on chains `1` and `10`, where
      a `clear` on one leaves the other intact. This fails loudly under a bare prefix filter.
- [ ] **`clear` removes every segment of ITS stream, ITS cursor record, and nothing else** — via
      `keys` + `delMany` over the anchored match for the segments, plus the helper's **clear-cursor**
      operation for the cursor record, never `idb-keyval`'s store-wide `clear()`. **The ORDER is
      clear-cursor FIRST, then the segments**, and it is the helper's rule: these are two IndexedDB
      transactions, so an interrupted `clear` is reachable, and cursor-first leaves segments with no
      cursor (which reads ABSENT and self-heals through the clear branch) while segments-first leaves
      a cursor over no events. Assert the interrupted middle. **On an ADOPTED stream, ABSENT requires
      the legacy blob to go too**: read-cursor here falls back to that blob's `lastSync`, so
      clear-cursor alone leaves it reading PRESENT — which is the state every upgraded user is in, so
      it is the case to test rather than the edge case. The cursor record
      is keyed so the anchored pattern REJECTS it (that is why the key was chosen), so
      enumerate-and-delete CANNOT reach it and a segments-only clear leaves it orphaned. Assert
      explicitly that after `clear` the read-cursor operation returns NOTHING and presence is FALSE:
      a surviving cursor claims coverage of an empty history, `indexer.ts:590` does not re-clear
      because `streamMatches` still passes, the hole guard does not fire because the next
      `fromBlock` is below the stale `lastToBlock + 1`, and the stream ends up holding head events
      only while claiming block 0 upward — replayed as whole by the next state discard. Assert an
      unrelated key in the same store survives. The adopted legacy key is deleted too, and it is
      excluded by the same anchored pattern, so name it explicitly rather than relying on the match.
- [ ] **The migration**: a stream in the shipped blob format is read with no re-fetch; separately, a
      legacy blob with a dropped raw half is cleared per ADR-0034. A clear or a migration says so
      through the existing logger, which is story 5's VISIBLE half on this substrate.
- [ ] `packages/browser/test/invalidation.test.ts` is updated deliberately for the new key layout and
      still asserts what it was written to assert.
- [ ] **The behaviours above are asserted PER PACKAGE, mirroring the sibling's**, and the mirroring is
      deliberate: `packages/browser` does not depend on `@etherfold/fs` (check its `package.json`) and
      cannot import it, so a single cross-keeper test is NOT in scope and must not be reached by
      widening the dependency. A genuinely shared `ExistingStream` conformance suite is a NAMED
      follow-up, with `packages/state-store-conformance` as the repo's precedent.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `segment-the-stream-behind-one-core-helper` — it builds the helper this task consumes and exports
  it from `@etherfold/core`. Also serialised on purpose: that task owns core's `index.ts` and its own
  changeset, so this one does not contend for either.

## Prompt

Read the source spec `appending-to-the-stream-costs-the-batch` (in `work/specs/proposed/` or
`work/specs/tasked/`) in full first, then read the helper the sibling task landed. Your job is to
supply a port and prove the contract, NOT to re-derive the rules.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). In
particular read the `## Decisions` block in
`work/tasks/done/segment-the-stream-behind-one-core-helper.md`: the seal threshold, how the legacy
shape is recognised, the temp-name convention, what a contiguity refusal DOES, and the shape of the
keeper-supplied cursor operations were all chosen there, and this task must MATCH them rather than
pick again. If the helper landed with a different port or cursor-operation shape than assumed here,
do NOT build on the stale premise — route to needs-attention with the discrepancy.

**Where to look.** `packages/browser/src/storage/stream/OnIndexedDB.ts` is the file. Its sibling is
`packages/fs/src/storage/stream/OnFile.ts`, already on the helper. The consumer is
`packages/core/src/indexer.ts`. `packages/browser/test/invalidation.test.ts` reaches into the stream
key and must be updated.

**Domain vocabulary** is the helper's: a *segment* is `{events, extent}`, the *scanned extent* being
the `{lastFromBlock, lastToBlock, latestBlock}` current after those events. The *cursor* is a whole
`LastSync`, and on THIS keeper it is NOT inside a segment at all — it is its own *cursor record*,
committed with its segment in one `setMany` transaction. (The filesystem keeper puts its cursor
inside the tail record instead; that is its business and must not be copied here.) The *tail* is
simply the open, highest-ordinal segment; *sealed* means "no longer the highest ordinal" and costs
NOTHING here, because there is no cursor in it to strip. The
stored stream is an *emission stream*, so a later segment can hold LOWER block numbers and no segment
may be skipped on a block bound.

**The two hazards specific to this substrate:**

- `idb-keyval`'s `clear()` wipes the WHOLE store. Using it for `ExistingStream.clear` would destroy
  every other stream and every other keeper's rows. Use `keys` + `delMany` over the anchored match.
- The anchored match matters MORE here than the rules make it look: a bare `startsWith` for chain `1`
  also matches every chain-`10` key. Same-name-different-chain is the designed-for case, since
  `chainId` is in the key precisely so one tag can serve many chains.

**Tests must not touch the real environment.** IndexedDB tests run against `fake-indexeddb`; make
sure nothing writes to a real profile or shared store, and assert unrelated keys in the same store
survive a `clear`.

**Scope fence.** Do NOT change the helper — a change there means this task found drift, so surface it
rather than editing. Do NOT make the stream raw-only (that is
`the-stream-stores-only-what-the-node-said`). Do NOT add per-segment block-range metadata. Do NOT strip `unconfirmedBlocks` from the CURSOR RECORD —
removing it entirely is the raw-only spec's job. Do NOT touch core's `index.ts`. Do NOT add a dependency on
`@etherfold/fs`.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (how
you mocked `idb-keyval`'s `set` for the cost assertion; anything the port had to do that the fs port
did not; the cursor-record key you chose and why the anchored pattern rejects it). That block is the ONE sanctioned channel
for build-time rationale and the runner transcribes it into the done record. Do NOT write the done
record, the commit message or the PR body, and do NOT open an observation note for decisions.

---

### Claiming this task

```sh
dorfl claim the-browser-stream-keeper-appends-in-segments --arbiter origin
git fetch origin && git switch -c work/the-browser-stream-keeper-appends-in-segments origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-browser-stream-keeper-appends-in-segments.md work/tasks/done/the-browser-stream-keeper-appends-in-segments.md
```

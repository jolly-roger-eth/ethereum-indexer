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
ordinal keys, anchored enumeration, the seal decision and the strip, the contiguity refusal, legacy
adoption, presence as the tail, the read order — lives in the helper. This task supplies the **port**
and the **cursor operations**, and proves the contract holds on IndexedDB.

**The CURSOR CONTRACT, which is what the helper enforces and this keeper must satisfy:**

1. exactly ONE authoritative cursor per stream;
2. a save is atomic in the CURSOR-AHEAD direction (a cursor claiming coverage the events lack is
   silent data loss);
3. no unconfirmed WINDOW on a SEALED segment (`unconfirmedBlocks` carries whole blocks WITH their
   events, so a per-segment copy is up to `finality` blocks of event data, forever, read by nothing);
4. an empty save costs nothing proportional to the history.

**This keeper uses the same TAIL strategy as the filesystem one**: the cursor rides in the open tail,
sealing empties its window while keeping the three block numbers and the context, and a save writes
exactly ONE key. One key is one write, so property 2 holds by construction here as it does there.

IndexedDB COULD instead hold the cursor in its own key and commit both in one `setMany` transaction —
placement is a keeper's business and the helper does not bake it in. That is not built here: matching
the filesystem keeps one strategy under test on both substrates, and the transactional alternative
buys only a cheaper empty save. If you find a reason to diverge, that is a `## Decisions` entry, not
a silent choice.

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

- [ ] `keepStreamOnIndexedDB` is implemented on the core helper, supplying a
      `get`/`set`/`del`/`delMany`/`keys` port over `idb-keyval` plus the tail cursor operations. No
      segmentation rule is re-implemented here.
- [ ] **Ship a changeset for `@etherfold/browser`.** This changes the persisted IndexedDB layout and
      adds a legacy-blob migration, which is what a browser consumer needs a release note for; the
      sibling's changeset was written before this work existed and cannot describe it. A separate
      file means no merge contention.
- [ ] **No full structured-clone of the history on a save**, asserted as WORK at a module-level mock
      of `idb-keyval`'s `set` behind `OnIndexedDB`. Assert the CEILING: no save writes more than one
      tail plus its batch, and the 100th append costs no more than the 10th at the same tail phase.
      Wall-clock cannot be the yardstick: `fake-indexeddb` is itself quadratic, and ADR-0032 rules out
      wall-clock on a loaded machine.
- [ ] **A save writes exactly ONE key**, including an empty save and the first save after a legacy
      adoption — the atomicity guard, and why no transaction is needed for a save here.
- [ ] **A save with NO events rewrites only the open tail**, never the history (story 3).
- [ ] **Sealing empties the WINDOW and keeps the rest**: a sealed segment's `unconfirmedBlocks` is
      empty while its `lastFromBlock`/`lastToBlock`/`latestBlock`/`context` survive and the new tail
      carries a full `lastSync`. Assert the paired negative — a sealed segment must still be able to
      say where the stream got to, or a truncation leaves an unresumable prefix.
- [ ] **A SEAL is safe to fail**: interrupt between opening the new tail and stripping the old, and
      assert the stream still reads correctly and a later pass empties it.
- [ ] **The cursor comes from the TAIL**, with no competing copy anywhere.
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
- [ ] **`clear` removes every segment of ITS stream and nothing else** — via `keys` + `delMany` over
      the anchored match, never `idb-keyval`'s store-wide `clear()`. Assert an unrelated key in the
      same store survives.
- [ ] **The migration**: a stream in the shipped blob format is read with no re-fetch; separately, a
      legacy blob with a dropped raw half is cleared per ADR-0034.
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

**Domain vocabulary** is the helper's: a *segment* is one stored batch of events plus the `lastSync`
current after them; the *tail* is the open, highest-ordinal segment and holds the live cursor;
*sealed* means the unconfirmed WINDOW has been emptied while the rest of the `lastSync` remains. The
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
`the-stream-stores-only-what-the-node-said`). Do NOT add per-segment block-range metadata. Do NOT
strip `unconfirmedBlocks` from the TAIL. Do NOT touch core's `index.ts`. Do NOT add a dependency on
`@etherfold/fs`.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (how
you mocked `idb-keyval`'s `set` for the cost assertion; anything the port had to do that the fs port
did not; any reason you diverged from the tail strategy). That block is the ONE sanctioned channel
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

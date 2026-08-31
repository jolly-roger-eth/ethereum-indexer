---
title: 'The browser stream keeper appends in segments, on the same core helper'
slug: the-browser-stream-keeper-appends-in-segments
spec: appending-to-the-stream-costs-the-batch
blockedBy: [segment-the-stream-behind-one-core-helper]
covers: [1, 2, 3, 4, 5, 6, 7]
---

## What to build

> **`covers` deliberately OVERLAPS the sibling task's.** Story 2 (no full structured-clone on the
> browser) is this task's alone, but stories 1 and 3-7 are the shared `ExistingStream` contract and
> are only shipped for a browser user when THIS task lands: the sibling delivers them on the
> filesystem. Reading the sibling's `done` record as "story 5, an existing persisted stream keeps
> working, is shipped" would be wrong while every browser user still holds the old blob. The overlap
> records that, and it is per-substrate rather than duplicated work.

Put `keepStreamOnIndexedDB` on the segmentation helper that
`segment-the-stream-behind-one-core-helper` builds, so a save on the browser stops structured-cloning
the entire history.

This is the SECOND independent implementation of one contract, not a second design. Every rule —
ordinal keys, the CURSOR CONTRACT (one authoritative cursor, never ahead of its events, none per sealed segment, empty save bounded), the tail strategy that satisfies it here, sealing as an explicit emptying of that cursor's window, the anchored enumeration, the contiguity refusal, legacy adoption in
place, presence as the tail — lives in the helper. This task supplies the **port** and
proves the contract holds on IndexedDB.

`packages/browser/src/storage/stream/OnIndexedDB.ts` today reads the whole stream, concatenates and
writes it all back on every `saveNewEvents`, which is a full structured-clone of the accumulated
history per index cycle. It imports only `get`/`set`/`del` from `idb-keyval`.

**The substrate facts this rests on**, checked rather than assumed:

- `idb-keyval` (6.2.4) ships `keys`, `getMany`, `setMany`, `delMany`, `entries`, `values`, `update`
  and `clear` alongside `get`/`set`/`del`. The keeper imports only three of them. So the belief that
  the browser keeper cannot enumerate is FALSE — it was inferred from an import line.
- `delMany` is ONE transaction, so a segmented `clear` is atomic.
- `idb-keyval`'s `clear()` wipes the **WHOLE store**, not one stream's keys. It is available as a
  capability and is NOT the implementation of `ExistingStream.clear`. Use `keys` plus `delMany` over
  the anchored match.

**One existing test reaches into the stream key directly and this breaks it.**
`packages/browser/test/invalidation.test.ts` does `get(stream_<tag>_<chainId>)`, asserts it is
defined, and rewrites `lastSync` in place. Update it DELIBERATELY — it is also the closest prior art
for the migration test — rather than patching it blind on a red gate.

## Acceptance criteria

- [ ] `keepStreamOnIndexedDB` is implemented on the core segmentation helper, supplying a
      `get`/`set`/`del`/`delMany`/`keys` port over `idb-keyval`. No segmentation rule is re-implemented here.
- [ ] **No full structured-clone of the history on a save**, asserted as WORK at a module-level mock
      of `idb-keyval`'s `set` behind `OnIndexedDB`: assert the CEILING — no save writes more than one
      tail plus its batch, and the 100th append costs no more than the 10th at the same tail phase.
      Wall-clock cannot be the yardstick here: `fake-indexeddb` is itself quadratic, and ADR-0032
      rules out wall-clock on a loaded machine.
- [ ] **No SEALED segment retains an unconfirmed WINDOW, while every segment still carries the rest
      of its `lastSync` and the TAIL carries a full one.** All three, matching the helper — a sealed
      segment that could not say where the stream got to would leave a truncated prefix unresumable. Do not strip `unconfirmedBlocks` out of the tail here; that belongs
      to `the-stream-stores-only-what-the-node-said`.
- [ ] **A save with no new events** costs nothing proportional to history.
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order, strict equality.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events, which is what stops
      `indexer.ts` taking its clear branch.
- [ ] **The cursor comes from the TAIL**, with no competing copy anywhere, because sealing stripped
      every sealed segment's.
- [ ] **A save writes exactly ONE key**, including an empty save and the first save after a legacy
      adoption — the atomicity guard, and on IndexedDB it means no transaction is needed for it.
- [ ] **A SEAL writes one extra key and is safe to fail**: interrupt between opening the new tail and
      stripping the old, and assert the stream still reads correctly and a later pass strips it.
- [ ] **A sealed segment is never rewritten** and is **readable by its own key**.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **Enumeration does not cross chains**: two streams sharing a name on chains `1` and `10`, where
      `clear` on one leaves the other intact. This fails loudly under a bare prefix filter.
- [ ] **`clear` removes every segment of ITS stream and nothing else** — via `keys` + `delMany` over
      the anchored match, never `idb-keyval`'s store-wide `clear()`. A test asserts an unrelated key
      in the same store survives.
- [ ] **A gap in the ordinals CLEARS FROM THE GAP UPWARD AND KEEPS THE PREFIX**, not thrown and not a
      whole-stream wipe — matching the helper, and asserted here too because `indexer.ts` has no
      `try`/`catch` around `fetchFrom`, so a throw would leave the browser indexer permanently
      unloadable, and because a whole-stream wipe would silently discard a good prefix.
- [ ] **The migration**: write a stream in the shipped blob format, read it with the new code, assert
      NO re-fetch; and separately, a legacy blob with a dropped raw half is cleared per ADR-0034.
- [ ] `packages/browser/test/invalidation.test.ts` is updated deliberately for the new key layout and
      still asserts what it was written to assert.
- [ ] The behaviours above are asserted PER PACKAGE, mirroring the fs assertions the sibling task
      landed, and the mirroring is deliberate rather than incidental: `packages/browser` does not
      depend on `@etherfold/fs` (check its `package.json`) and cannot import it, so a single
      cross-keeper test is NOT in this task's scope and must not be attempted by widening the
      dependency. If a genuinely shared contract suite is wanted, the repo's precedent is a separate
      package (`packages/state-store-conformance`) and that is a NAMED follow-up, not this task.
      What this criterion asks for is that the two packages assert the SAME behaviours, so a
      divergence between the two implementations of one contract shows up as a red test somewhere.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `segment-the-stream-behind-one-core-helper` — it builds the helper this task consumes and exports
  it from `@etherfold/core`. Also serialised on purpose: that task owns core's `index.ts` and the
  changeset, so this one does not contend for either.

## Prompt

Read `work/specs/proposed/appending-to-the-stream-costs-the-batch.md` in full first, and read the
helper that `segment-the-stream-behind-one-core-helper` landed. Your job is to supply a port and
prove the contract, NOT to re-derive the rules.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
it still match the code in `work/tasks/done/`, the relevant ADRs, and the task it depends on? In
particular, read the `## Decisions` block in
`work/tasks/done/segment-the-stream-behind-one-core-helper.md` — the seal threshold, how the legacy
shape is recognised, and exactly what a contiguity refusal DOES (it clears from the gap upward and
keeps the prefix; it does not throw and does not wipe the stream) were all chosen there, and this
task must match them rather than pick again. If the helper landed with a different port shape than this task
assumes, do NOT build on the stale premise: route to needs-attention with the discrepancy
(WORK-CONTRACT.md, "Drift is a needs-attention signal").

**Where to look.** `packages/browser/src/storage/stream/OnIndexedDB.ts` is the file. Its sibling
implementation is `packages/fs/src/storage/stream/OnFile.ts`, already on the helper. The consumer is
`packages/core/src/indexer.ts`. `packages/browser/test/invalidation.test.ts` is the test that reaches
into the stream key and must be updated.

**Domain vocabulary** is the helper's: a *segment* is one stored batch of EVENTS, and nothing else.
The *tail* is the open, highest-ordinal segment; everything below it is *sealed* and immutable. The
*cursor* is ONE record per stream, committed together with the segment it describes. The stored stream is an *emission stream*,
so a later segment can hold LOWER block numbers and no segment may be skipped on a block bound.

**The two hazards specific to this substrate:**

- `idb-keyval`'s `clear()` wipes the WHOLE store. Using it for `ExistingStream.clear` would destroy
  every other stream and every other keeper's rows in that store. Use `keys` + `delMany` over the
  anchored match.
- The anchored match matters MORE here than the rules make it look: stream keys are
  `stream_<name>_<chainId>`, so a bare `startsWith` filter for chain `1` also matches every chain-`10`
  key. That is silent cross-chain data corruption, and same-name-different-chain is the designed-for
  case, since `chainId` is in the key precisely so one tag can serve many chains.

**Tests must not touch the real environment.** IndexedDB tests run against `fake-indexeddb`; make
sure nothing writes to a real profile or shared store, and assert unrelated keys in the same store
survive a `clear`.

**Scope fence.** Do NOT change the helper (that is the sibling task's file, and a change there means
this task found drift — surface it rather than editing). Do NOT make the stream raw-only — that is
`the-stream-stores-only-what-the-node-said`. Do NOT add per-segment block-range metadata. Do NOT touch
core's `index.ts`; the sibling task owns it. Do NOT add a dependency on `@etherfold/fs`.

DO ship your OWN changeset, for `@etherfold/browser` only. This task changes the persisted IndexedDB
layout and adds a legacy-blob migration, which is exactly what a browser consumer needs a release
note for, and the sibling task's changeset was written before this work existed so it cannot describe
it. A separate changeset file means no merge contention with it.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (how
you mocked `idb-keyval`'s `set` for the cost assertion; anything the port had to do that the fs port
did not). That block is the ONE sanctioned channel for build-time rationale and the runner
transcribes it into the done record. Do NOT write the done record, the commit message or the PR body
yourself, and do NOT open an observation note for decisions.

---

### Claiming this task

```sh
dorfl claim the-browser-stream-keeper-appends-in-segments --arbiter origin
git fetch origin && git switch -c work/the-browser-stream-keeper-appends-in-segments origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-browser-stream-keeper-appends-in-segments.md work/tasks/done/the-browser-stream-keeper-appends-in-segments.md
```

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
the hierarchical address, the segment record, the seal DECISION, the contiguity refusal and its
recovery sequence, legacy adoption, presence, the read order — lives in the helper. This task supplies
the **port** and the **four keeper operations**, and proves the contract holds on IndexedDB.

### ARRAY KEYS, which is the whole reason this keeper gets simpler

`idb-keyval` takes `IDBValidKey`, and **`IDBValidKey` includes arrays**. So the hierarchical address
is expressible with the dependency exactly as it is, no raw-IndexedDB layer and no new package:

```
['stream', <indexer-name>, <digest>, <ordinal>]   segment
['stream', <indexer-name>, <digest>, 'cursor']    cursor record
```

`keys<KeyType>()` returns typed keys, so enumeration FILTERS BY ELEMENT (`k[1] === name && k[2] ===
digest`) rather than by string prefix. That is not a stylistic preference: an earlier design used one
delimited string, where the chain-`1` prefix also matched every chain-`10` key, and needed an anchored
regex to avoid silently concatenating another stream's events into the replay. **Comparing elements
cannot make that mistake**, so the hazard is gone rather than guarded. `chainId` is not in the address
at all — it is already inside the digest.

Two of the helper's rules must not be read as the filesystem's. **PRESENCE is "the read-cursor
operation returns something"**, never "a tail exists": here an empty first save and a legacy adoption
both leave NO segment and must still read present. And **SEALING is a keeper operation**, which here
is a NO-OP, because the cursor was never inside a segment so there is nothing to strip.

### The CURSOR CONTRACT, which the helper enforces and this keeper must satisfy

1. exactly ONE authoritative cursor per stream;
2. a save is atomic in the CURSOR-AHEAD direction (a cursor claiming coverage the events lack is
   silent data loss);
3. no unconfirmed WINDOW on a SEALED segment (`unconfirmedBlocks` carries whole blocks WITH their
   events, so a per-segment copy is up to `finality` blocks of event data, forever, read by nothing);
4. an empty save costs nothing proportional to the history.

Plus the INVARIANT that removes an operation: **the cursor is addressed WITHIN its stream's subtree**,
so `clear` is one scoped delete that cannot orphan it.

**This keeper has NO OPEN TAIL AT ALL: one segment per batch, plus a cursor record.** That is the
sharpest difference from the filesystem keeper and it is worth understanding rather than copying.

The fs keeper keeps an open tail and REWRITES it on every save, bounded by a seal threshold. It does
that for ONE reason: a save must be a single write, because the filesystem has no transaction and
that is how cursor-ahead atomicity holds. IndexedDB HAS a transaction, so it never needed the tail
for atomicity — the only thing a tail would buy here is fewer records, and it would cost a rewrite of
up to a whole threshold's worth of events on every single save, including the empty ones a
head-following indexer makes on every poll.

So this keeper writes each batch as its OWN segment at the next ordinal, together with the cursor
record, in ONE `setMany` transaction:

- **A save writes exactly its BATCH.** Not a batch plus a rewritten tail. Nothing already written is
  ever touched again, so a segment is immutable from birth.
- **An empty save writes ONLY the cursor record** — no segment at all.
- **Property 2** holds through the transaction rather than by writing one key.
- **Property 3 is VACUOUS**: the cursor was never inside a segment, so there is nothing to strip.
- **There is no SEAL here.** `seal-segment` exists for the tail keeper and is NEVER INVOKED on this
  one. Implement it as a no-op and assert it is not called.

**How a batch becomes segment(s) is the KEEPER's choice, exactly like cursor placement.** The helper
owns the address, ordinal allocation, read order, the contiguity refusal and its recovery, presence
and `clear`; it does NOT own the write shape. The fs keeper batches into a tail because it must; this
one does not because it need not. Do NOT port the tail strategy here.

**What is the SAME on both keepers**: the helper's segment record is `{events, extent}` with the
SCANNED EXTENT `{lastFromBlock, lastToBlock, latestBlock}`, because the truncation recovery needs a
prefix that can say where it got to. What DIFFERS is only that the fs tail additionally carries its
`lastSync` inside that record, which the helper never reads. The recovery SEQUENCE (rewrite the cursor
from the surviving top segment's extent, then delete upward) is the helper's on both keepers; it is
merely INVISIBLE on the filesystem, where the surviving tail already IS the cursor, and observable
here.

**The substrate facts this rests on**, checked rather than assumed:

- `idb-keyval` (6.2.4) ships `keys`, `getMany`, `setMany`, `delMany`, `entries`, `values`, `update`
  alongside `get`/`set`/`del`. The keeper imports only three. So "the browser keeper cannot
  enumerate" is FALSE — it was inferred from an import line.
- `setMany` and `delMany` are each ONE transaction.
- `idb-keyval`'s `clear()` wipes the **WHOLE store**, not one stream's keys. It is a capability, NOT
  the implementation of `ExistingStream.clear`.

**One existing test reaches into the stream key directly and this breaks it.**
`packages/browser/test/invalidation.test.ts` does `get(stream_<tag>_<chainId>)`, asserts it is
defined, and rewrites `lastSync` in place. Update it DELIBERATELY — it is also the closest prior art
for the migration test — rather than patching it blind on a red gate.

## Acceptance criteria

- [ ] `keepStreamOnIndexedDB` is implemented on the core helper, supplying a
      `get`/`set`/`del`/`delMany`/`keys` port over `idb-keyval` plus the FOUR keeper operations
      (commit-segment-with-cursor, read-cursor, write-cursor-only, seal-segment), of which
      seal-segment is a NO-OP here. No segmentation rule is re-implemented. `setMany` is used INSIDE
      the commit operation rather than being a port member, so the port type stays exactly the
      sibling's — check the landed helper's port and match it rather than widening it.
- [ ] **The address is an ARRAY KEY** `['stream', name, digest, ordinal]`, with the cursor at
      `[..., 'cursor']`. Assert enumeration filters BY ELEMENT and that no string-prefix match exists
      anywhere in this keeper.
- [ ] **Two streams under one name with different digests do not see each other**: writing, reading
      and clearing one leaves the other complete and readable, and its replay is unpolluted. This
      replaces the old cross-chain test and now passes by construction.
- [ ] **Ship a changeset for `@etherfold/browser`.** This changes the persisted IndexedDB layout and
      adds a legacy-blob migration, which is what a browser consumer needs a release note for; the
      sibling's changeset cannot describe it. A separate file means no merge contention.
- [ ] **A save writes exactly its BATCH plus the cursor record, and NOTHING already written**,
      asserted as WORK at a module-level mock of `idb-keyval`'s **`setMany`** (and `set`, if any path
      still uses it) behind `OnIndexedDB`. Naming only `set` would make this and the one-transaction
      assertion pass VACUOUSLY, because the commit path is `setMany`. This is a stronger claim than
      the fs keeper's ceiling (one tail plus its batch) and it is the point of having no tail: assert
      that the bytes written on the 100th save match the 100th batch and do not grow with the history
      OR with a threshold, and that no previously-written segment key is ever written again.
      Wall-clock cannot be the yardstick: `fake-indexeddb` is itself quadratic, and ADR-0032 rules out
      wall-clock on a loaded machine.
- [ ] **`seal-segment` is NEVER INVOKED on this keeper.** Implement it as a no-op and assert the
      helper does not call it, which is the observable form of "this keeper has no tail".
- [ ] **A save commits the segment AND the cursor record in ONE `setMany` transaction**, asserted at
      the instrumented seam — this is how property 2 holds here, and why no write-ordering rule or
      crash recovery is needed on this keeper.
- [ ] **An empty save writes ONLY the cursor record**, no segment — property 4, and the concrete
      advantage of having no tail.
- [ ] **A segment is immutable from BIRTH here**: assert no segment key is ever written twice, which
      on this keeper is unconditional rather than scoped to "while it remains sealed" (the truncation
      path deletes segments; it never reopens one for appending, because there is no tail to reopen).
- [ ] **No ORDINAL segment contains a `lastSync` at all** — property 3 is vacuous here, so there is no
      seal write to perform and none to test; assert seal-segment is a no-op. Every segment DOES carry
      its scanned extent. **Scope the claim to ORDINAL segments, because the ADOPTED LEGACY BLOB is
      the exception and it is load-bearing**: it is a segment, it DOES contain a `lastSync`, adoption
      writes nothing, and there is no seal here to ever remove it. So read-cursor has a PRECEDENCE:
      the cursor record if one exists, else the adopted legacy blob's own `lastSync`. Assert that
      precedence directly — without it an adopted stream has no cursor, `fetchFrom` reads absent, and
      every existing browser user re-fetches their whole history, which is story 5 inverted.
- [ ] **The cursor comes from the CURSOR RECORD**, with no competing copy in any ORDINAL segment, and
      it is addressed inside the stream's subtree. Scoped to ordinal segments for the same reason as
      above.
- [ ] **`clear` removes the stream's whole SUBTREE and nothing else** — `keys` + `delMany` over the
      element match, never `idb-keyval`'s store-wide `clear()`. The cursor record is inside that
      subtree, so it goes with the segments and no separate step or ordering rule is needed; assert
      that after `clear` the read-cursor operation returns NOTHING and presence is FALSE. The ADOPTED
      LEGACY KEY sits OUTSIDE the subtree (it is a flat string key), so it must be deleted BY NAME as
      well — assert a `clear` on an adopted stream leaves nothing. Assert an unrelated key in the same
      store survives.
- [ ] **The truncation recovery runs the HELPER's sequence and this keeper proves it at its own
      seam**: the cursor record is rewritten from the surviving top segment's extent (carrying the
      pre-recovery `context` forward, with an empty window) BEFORE the `delMany`. The ORDER is the
      helper's, not this keeper's invention — assert it HERE because this is where it is observable:
      IndexedDB gives no delete-plus-put primitive, so deleting first leaves a window where the cursor
      describes segments that are gone, and the ordinals are contiguous again afterwards so the gap
      can never be re-detected. If the helper landed WITHOUT that sequence, that is drift: surface it
      rather than implementing the order locally.
- [ ] **Presence works when there is NO segment yet.** Two cases the tail rule does not cover here: an
      empty FIRST save writes only the cursor record and no segment; and a legacy adoption writes
      nothing at all. Assert `fetchFrom` returns DEFINED in both, or `indexer.ts` takes its clear
      branch and the migration becomes a full re-fetch for every browser user.
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order, strict equality.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **A gap CLEARS FROM THE GAP UPWARD AND KEEPS THE PREFIX**, not thrown and not a whole-stream
      wipe, matching the helper. `indexer.ts` has no `try`/`catch` around `fetchFrom`, so a throw
      leaves the browser indexer permanently unloadable.
- [ ] **A sealed segment is never rewritten WHILE IT REMAINS SEALED, and is readable by its own
      address** (story 7 on this substrate). Scoped that way because the truncation path deliberately
      makes a formerly-sealed segment the new tail.
- [ ] **The migration**: a stream in the shipped blob format is read with no re-fetch; separately, a
      legacy blob with a dropped raw half is cleared per ADR-0034. A clear or a migration says so
      through the existing logger, which is story 5's VISIBLE half here.
- [ ] `packages/browser/test/invalidation.test.ts` is updated deliberately for the new address and
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

Read the source spec `appending-to-the-stream-costs-the-batch` (`work/specs/tasked/`) and
`docs/adr/0035-*` in full first, then read the helper the sibling task landed. Your job is to supply a
port and prove the contract, NOT to re-derive the rules.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). In
particular read the `## Decisions` block in
`work/tasks/done/segment-the-stream-behind-one-core-helper.md`: the seal threshold, the placeholder
digest constant, how the legacy shape is recognised, what a contiguity refusal DOES, and the shape of
the four keeper operations were all chosen there, and this task must MATCH them rather than pick
again. If the helper landed with a different port or operation shape than assumed here, do NOT build
on the stale premise — route to needs-attention with the discrepancy.

**Where to look.** `packages/browser/src/storage/stream/OnIndexedDB.ts` is the file. Its sibling is
`packages/fs/src/storage/stream/OnFile.ts`, already on the helper. The consumer is
`packages/core/src/indexer.ts`. `packages/browser/test/invalidation.test.ts` reaches into the stream
key and must be updated.

**Domain vocabulary** is the helper's: a *segment* is `{events, extent}`, the *scanned extent* being
the `{lastFromBlock, lastToBlock, latestBlock}` current after those events. The *cursor* is a whole
`LastSync` and on THIS keeper it is NOT in a segment at all — it is its own *cursor record*, committed
with its segment in one `setMany` transaction, addressed inside the same stream subtree. (The
filesystem keeper puts its cursor inside its open tail instead; that is its business and must not be
copied here.) *Tail* and *sealed* are TAIL-STRATEGY words and do not apply on this keeper at all:
there is no open segment, so every segment is sealed the instant it is written. The stored stream is an *emission stream*, so a later segment
can hold LOWER block numbers and no segment may be skipped on a block bound.

**The two hazards specific to this substrate:**

- `idb-keyval`'s `clear()` wipes the WHOLE store. Using it for `ExistingStream.clear` would destroy
  every other stream and every other keeper's rows. Use `keys` + `delMany` over the element match.
- The ADOPTED LEGACY BLOB is a flat string key that predates the hierarchical address, so it sits
  OUTSIDE the subtree: it is the one thing enumeration cannot reach, and both `clear` and the
  read-cursor precedence have to name it explicitly.

**Tests must not touch the real environment.** IndexedDB tests run against `fake-indexeddb`; make sure
nothing writes to a real profile or shared store, and assert unrelated keys in the same store survive
a `clear`.

**Scope fence.** Do NOT change the helper — a change there means this task found drift, so surface it
rather than editing. Do NOT make the stream raw-only (that is
`the-stream-stores-only-what-the-node-said`). Do NOT compute a real stream digest or write a canonical
pointer — those are `a-reconfigure-is-not-an-outage`'s. Do NOT add per-segment block-range metadata.
Do NOT strip `unconfirmedBlocks` from the CURSOR RECORD. Do NOT touch core's `index.ts`. Do NOT add a
dependency on `@etherfold/fs`.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (how
you mocked `idb-keyval`'s `setMany` for the cost assertion; anything the port had to do that the fs
port did not; how you addressed the cursor record within the subtree). That block is the ONE
sanctioned channel for build-time rationale and the runner transcribes it into the done record. Do NOT
write the done record, the commit message or the PR body, and do NOT open an observation note for
decisions.

---

### Claiming this task

```sh
dorfl claim the-browser-stream-keeper-appends-in-segments --arbiter origin
git fetch origin && git switch -c work/the-browser-stream-keeper-appends-in-segments origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-browser-stream-keeper-appends-in-segments.md work/tasks/done/the-browser-stream-keeper-appends-in-segments.md
```

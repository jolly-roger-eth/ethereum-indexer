---
title: 'The stream appends in segments, behind one core helper, on IndexedDB'
slug: the-stream-appends-in-segments-on-indexeddb
spec: appending-to-the-stream-costs-the-batch
blockedBy: []
covers: [1, 2, 3, 4, 5, 6, 7]
---

## What to build

The stream stops being one blob rewritten in full on every append and becomes an **append-only log of
segments**, with the rules in ONE core helper and **IndexedDB as the only keeper**.

Today `OnIndexedDB.ts` reads the whole stream, concatenates and writes it all back on every
`saveNewEvents` — a full structured-clone of the accumulated history per index cycle. `save` runs once
per `indexMore`, so a backfill is QUADRATIC, and the empty-batch branch pays the same cost purely to
move `lastSync`.

> **This task REPLACES two earlier ones** (a filesystem keeper plus a browser sibling). Filesystem
> stream storage is not supported: `keepStreamOnFile` had ZERO callers, the CLI never used
> `@etherfold/fs` (it has its own `keepState`), and the only consumer of that package is a fixture
> loader. Everything the filesystem keeper needed — an open tail, a seal threshold, a strip,
> temp-file-plus-rename, torn-segment recovery — existed to serve a substrate with no transaction and
> no users. It is all gone. The helper is still a HELPER rather than inlined, because a second keeper
> (SQL for the server, OPFS in a browser) is a real prospect and the seam is what makes it cheap.

### The address

**Hierarchical, as IndexedDB ARRAY keys** (`idb-keyval` takes `IDBValidKey`, which includes arrays):

```
['stream', <indexer-name>, <digest>, <ordinal>]   segment
['stream', <indexer-name>, <digest>, 'cursor']    cursor record
```

An earlier design packed these into one delimited string and then needed an anchored regex, a
cross-chain corruption hazard, a temp-name rule and an extra keeper operation. **All of that was a
consequence of the flat namespace.** Comparing key ELEMENTS cannot confuse chain `1` with chain `10`,
so the hazard is gone rather than guarded.

- **`chainId` is NOT in the address.** It is already inside the stream digest (the block-0 skeleton
  entry hashes `chainId` and `genesisHash`), so two chains produce different digests and cannot
  collide.
- **The `<digest>` level is present with a PLACEHOLDER value.** `a-reconfigure-is-not-an-outage`
  computes the real digest; do not invent one. Keep it a level so the successor fills it rather than
  re-keying. Record the constant in `## Decisions`.
- **`<indexer-name>` is supplied by the caller**, and a browser app may legitimately run SEVERAL (an
  NFT viewer naming one per watched account). It is the same discriminator the server gets from
  `upload`.

**Read segments with a KEY RANGE, not a whole-store scan.** `idb-keyval`'s `keys()` is an unbounded
read of every key in the store, so with several streams it costs O(store) per `fetchFrom` and per
`clear`. Use `createStore`'s escape hatch — `UseStore = (txMode, cb: (store: IDBObjectStore) => T)` —
with an `IDBKeyRange` over the stream's prefix. Note the two ranges are NOT the same and using the
wrong one is a real bug: IndexedDB orders `number < string < array`, so
`bound([...prefix, 0], [...prefix, []])` spans the WHOLE SUBTREE and returns the `'cursor'` record
along with the ordinals — which is what `clear` wants. For a SEGMENTS-ONLY read exclude the string
bound: `bound([...prefix, 0], [...prefix, 'cursor'], false, true)`, or filter on
`typeof key[3] === 'number'`. `packages/state-store-indexeddb/src/keys.ts` is the repo's precedent for
building these. `@etherfold/state-store-indexeddb` already drives raw IndexedDB with key
ranges, cursors and multi-store transactions, so this is the repo's existing practice, not a new
dependency or a new idea.

### The shape

- **ONE SEGMENT PER BATCH. There is no open tail.** A save writes its batch as a new segment at the
  next ordinal, together with the cursor record, in ONE `setMany` transaction. Nothing already
  written is ever touched again.
- **An empty save writes ONLY the cursor record**, no segment.
- **A segment is immutable from BIRTH**, unconditionally.
- **Ordinals key the segments and the read is a full ordered scan.** The stored stream is an EMISSION
  stream: on a reorg the indexer re-appends superseded events at their ORIGINAL `blockNumber` flagged
  `removed`, then continues at LOWER block numbers. So block ranges overlap, cannot key anything, and
  no segment can be skipped on a block bound. `fetchFrom(source, fromBlock)` KEEPS its signature and
  semantics.
- **PRESENCE is "the read-cursor operation returns something"**, never "a segment exists": an empty
  first save writes only a cursor record. `fetchFrom` must keep returning a DEFINED result for a
  stream saved to but holding no events, because that is what stops `indexer.ts` taking its clear
  branch.

### The SEGMENT RECORD

**A segment is `{events}` and nothing else.** No extent, no cursor, no `lastSync`. An earlier draft
carried a per-segment SCANNED EXTENT whose only reader was a gap-recovery that no longer exists (see
below), so it goes with it.

**No segment and no cursor record stores `unconfirmedBlocks`**, and this is settled by evidence
already in the repo rather than by argument: `captureStream` persists `unconfirmedBlocks: []` and
`replayStream` returns `[]` (`packages/core/src/stream/capture.ts`, `stream/fixture.ts`) — a shipped,
tested third implementation of this same `ExistingStream` seam that stores no window and works. The
window has two other homes that ARE read (`KeepState.save` takes `{state, lastSync}`; the entity
path's `serializeLastSync` is `JSON.stringify` of the whole `LastSync`, written in the block's
transaction), and the stream's copy is read by nobody: `promiseToFeed` reads only the three block
numbers, and `generateStreamToAppend` rebuilds the window from the replayed events. The cursor record
therefore holds the three block numbers plus the `context`, and `fetchFrom` returns
`unconfirmedBlocks: []`.

### THREE keeper operations, and the cursor contract

WHERE a keeper puts its cursor is its own business, subject to one invariant: **the cursor is
addressed WITHIN its stream's subtree**, so a scoped delete removes it with the segments and `clear`
cannot orphan one.

1. **commit-segment-with-cursor** — write a segment and make the cursor current, together.
2. **read-cursor** — the live cursor, or nothing. This is also what PRESENCE is.
3. **write-cursor-only** — move the cursor with NO segment (an empty save; the truncation rewrite).

There is deliberately no seal and no clear-cursor. Sealing existed only to strip a window that is no
longer stored; clear-cursor existed only because a flat key put the cursor outside the enumerable
pattern.

**The cursor contract is THREE properties** (ADR-0035, as amended):

1. **Exactly ONE authoritative cursor per stream.**
2. **A save is atomic in the CURSOR-AHEAD direction.** A cursor claiming coverage the stored events
   do not have is silent data loss. Here it holds through the `setMany` transaction.
3. **An empty save costs nothing proportional to the history.** Here it is one small record.

### Inconsistency is CLEARED, not repaired

**One rule replaces a whole recovery machine: if what is stored is not a complete, contiguous stream
with a cursor, DELETE THE SUBTREE and let it rebuild.** That covers every case:

- a GAP in the ordinals (`0`, `1`, `3`);
- a cursor with NO segments beneath it;
- segments with NO cursor (presence is the cursor, so these are unreachable anyway);
- a segment that fails to parse.

An earlier draft kept the contiguous PREFIX beneath a gap and resumed from it, which needed a
per-segment scanned extent, a recovery sequence with a pinned write-then-delete order, a rule for
carrying the `context` forward, a separate no-survivors branch, a would-create-a-HOLE guard, and about
four acceptance criteria — all for a state only a test can manufacture. **It is deleted.** The
justification for keeping a prefix was that a full re-index might be impossible on a public node; that
is a real concern, and it is the SEEDING spec's to answer
(`a-generation-can-be-seeded-from-a-published-artifact`), not this keeper's to hedge against. Story 5
explicitly permits this branch: "or be rebuilt deliberately and visibly".

**Not a throw.** `indexer.ts` calls `fetchFrom` with no `try`/`catch` and the browser wrapper only
records `FAILED_TO_LOAD` and rethrows, so a throw makes the indexer permanently unloadable — for a
LOCAL CACHE whose correct recovery is to re-fetch. Clear, log, return nothing, let the indexer take
its existing clear branch.

**Gaps are NOT routine, which is why hedging against them earned so little.** `delMany` is one
transaction so a partial `clear` cannot happen, nothing rewrites a segment, and IndexedDB eviction is
per-origin rather than per-key so it cannot punch a hole in the ordinals. What remains is external
deletion and corruption. The check is nearly free because the ordinals are being read anyway.

### `clear`, and no legacy adoption

- **`clear` deletes the stream's whole SUBTREE** — a `delMany` over the key range, never
  `idb-keyval`'s `clear()`, which wipes the WHOLE store including every other keeper's rows. The
  cursor is inside the subtree, so it goes with the segments.
- **The legacy blob is DELETED, not adopted.** The shipped keeper writes `stream_<name>_<chainId>` as
  a flat key. An earlier draft adopted it in place to spare users a re-index; there are no such users
  (`CONTEXT.md`: nothing is published, and the reference deployment has a live contract but no
  players), and story 5 explicitly allows the cheap branch — "or be rebuilt deliberately and
  visibly". So on finding one, DELETE it and let the stream rebuild, saying so through the logger.
  That is the repo's own precedent for the same class of artifact (`packages/fs/src/utils/fs.ts`, on
  a stale-format blob: "inventing one to reject a cache whose recovery is a re-index would be more
  machinery than the problem. Clear the folder."). Dropping adoption also removes the read-cursor
  precedence rule and every "ORDINAL segments" carve-out that existed only for it.

## Acceptance criteria

- [ ] A core helper implements segmentation over an injected port scoped to a stream's subtree, plus
      THREE keeper operations (commit-segment-with-cursor, read-cursor, write-cursor-only).
      `keepStreamOnIndexedDB` supplies them. Core's `index.ts` re-exports the helper, so **ship a
      changeset** for `@etherfold/core` and `@etherfold/browser`.
- [ ] **The address is an ARRAY KEY** with the digest level present and a placeholder value. Assert no
      string-prefix matching exists anywhere, and that `chainId` appears nowhere in the address.
- [ ] **Segments are read by KEY RANGE, not a whole-store scan.** Assert that reading one stream does
      not read keys belonging to another, by count at the instrumented seam — this is what keeps
      `fetchFrom` O(stream) rather than O(store) once several streams exist.
- [ ] **Two streams under one indexer name with different digests do not see each other**, and two
      different indexer names likewise: writing, reading and clearing one leaves the other complete
      and readable.
- [ ] **A save writes exactly its BATCH plus the cursor record, and NOTHING already written**,
      asserted as WORK at a module-level mock of `idb-keyval`'s **`setMany`** (naming only `set` makes
      this pass vacuously, because the commit path is `setMany`). Assert the bytes written on the
      100th save match the 100th batch and grow with neither the history NOR any threshold, and that
      no previously-written segment key is ever written again. Wall-clock cannot be the yardstick:
      `fake-indexeddb` is itself quadratic (`work/notes/observations/fake-indexeddb-write-cost-grows-quadratically.md`)
      and ADR-0032 rules it out on a loaded machine.
- [ ] **A save commits the segment AND the cursor record in ONE `setMany` transaction.**
- [ ] **An empty save writes ONLY the cursor record**, no segment.
- [ ] **THE STREAM KEEPER stores no `unconfirmedBlocks`** — not in a segment, not in the cursor
      record — and `fetchFrom` returns a `LastSync` whose window is `[]`. Assert a full load-and-replay
      still produces the same state, which is what proves the window was redundant HERE rather than
      merely unread.
- [ ] **The STATE side still stores it, and this is asserted as a GUARD, not assumed.** The scope
      above is the stream keeper ONLY. `KeepState.save` takes `{state, lastSync}` and the entity
      path's `serializeLastSync` is `JSON.stringify` of the whole `LastSync`, both including the
      window, and both are READ: `checkTxInclusion` is answered from `LastSync.unconfirmedBlocks` and
      nothing else, and a deployment with NO stream configured recovers its window from that cursor on
      reload. Assert `checkTxInclusion` still answers correctly across a reload with no stream keeper
      configured — that is the test that fails loudly if someone reads the criterion above as global
      and strips the window everywhere.
- [ ] **The cursor comes from the CURSOR RECORD**, with no competing copy, addressed inside the
      stream's subtree.
- [ ] **`clear` removes the subtree and nothing else**: assert an unrelated key in the same store
      survives, that after `clear` read-cursor returns NOTHING and presence is FALSE, and that a
      legacy flat-key blob is DELETED (not adopted) with the deletion logged.
- [ ] **Any inconsistency CLEARS the subtree**, asserted for each shape: a hole punched at ordinal
      `k`, a cursor with no segments, segments with no cursor, and an unparseable segment. In every
      case nothing raises, the subtree is gone, presence reads FALSE, the clear is logged, and the
      next load takes `indexer.ts`'s existing clear branch. Assert the paired negative too: a HEALTHY
      stream is never cleared.
- [ ] **A segment is never written twice.**
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order. Strict equality — this task changes no event shape.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **The migration**: a stream in the shipped blob format is deleted and re-indexed rather than
      adopted, visibly; separately, a legacy blob with a dropped raw half is cleared per ADR-0034.
- [ ] `packages/browser/test/invalidation.test.ts` reaches into the old stream key and is updated
      DELIBERATELY for the new address, still asserting what it was written to assert.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None — can start immediately.

## Prompt

Read the source spec `appending-to-the-stream-costs-the-batch` (`work/specs/tasked/`) and
`docs/adr/0035-*` INCLUDING ITS AMENDMENT in full first. The ADR carries the reasoning behind the
address, the cursor contract and the operations, including why several tempting alternatives are
wrong and which earlier rules were withdrawn.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
dependency landed differently, or an ADR superseded an assumption here, do NOT build on the stale
premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
needs-attention signal").

**Where to look.** `packages/browser/src/storage/stream/OnIndexedDB.ts` is the keeper.
`packages/state-store-indexeddb/src/idb.ts` and `src/keys.ts` are the repo's existing raw-IndexedDB
practice (promise wrappers, `IDBKeyRange.bound`, cursors, multi-store transactions) and are the model
for the key-range reads. The consumer is `packages/core/src/indexer.ts` (five `keepStream.clear` call
sites, the clear-on-undefined branch, and the state-kept branch that has no `else`). The reorg
re-append and `generateStreamToAppend` are in `packages/core/src/internal/engine/utils.ts`.
`packages/browser/test/invalidation.test.ts` reaches into the stream key.

**Domain vocabulary.** A *segment* is `{events}`. The *cursor* is a `LastSync` MINUS its window, kept
as its own *cursor record* inside the stream's subtree and committed with its segment in one
transaction; it is the ONLY place the three block numbers and the `context` live. The
stored stream is an *emission stream*, so a later segment can hold LOWER block numbers and no segment
may be skipped on a block bound. There is no *tail* and no *seal* — those were a filesystem strategy
and the filesystem keeper is gone.

**Easy to get wrong:**

- Use a KEY RANGE. `keys()` reads the whole store; with several streams that is the quadratic problem
  moved from the write path to the read path.
- `idb-keyval`'s `clear()` wipes the WHOLE store, destroying every other stream and every other
  keeper's rows. It is a capability, NOT the implementation of `ExistingStream.clear`.
- Do not store `unconfirmedBlocks` anywhere, and do not "helpfully" reconstruct it into the stored
  cursor. Return `[]`.
- Segments are keyed by ORDINAL and the READ is a full ordered scan. Do not make reads cheaper by
  block; the reorg model forbids it.
- ADR-0006 is relevant for its ORDERING argument ONLY. Do NOT invent a per-event sequence
  client-side, and do not import its two views, cursor validation or compaction.
- Keep the helper substrate-neutral: it must not assume a tail, must not read a segment's cursor, and
  must route every cursor move through the three keeper operations. A SQL keeper and an OPFS keeper
  are the expected next consumers.

**Tests must not touch the real environment.** IndexedDB tests run against `fake-indexeddb`; assert
unrelated keys in the same store survive a `clear`.

**Scope fence.** Do NOT make the stream raw-only (that is `the-stream-stores-only-what-the-node-said`).
Do NOT compute a real stream digest or write a canonical pointer (those are
`a-reconfigure-is-not-an-outage`'s); use a placeholder for the digest level. Do NOT add per-segment
block-range metadata. Do NOT add a filesystem keeper.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (the
placeholder digest constant; the key-range construction and its upper bound; how you mocked `setMany`
for the cost assertion; the exact shape of the three keeper operations). That block is the ONE
sanctioned channel for build-time rationale and the runner transcribes it into the done record. Do NOT
write the done record, the commit message or the PR body.

---

### Claiming this task

```sh
dorfl claim the-stream-appends-in-segments-on-indexeddb --arbiter origin
git fetch origin && git switch -c work/the-stream-appends-in-segments-on-indexeddb origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-stream-appends-in-segments-on-indexeddb.md work/tasks/done/the-stream-appends-in-segments-on-indexeddb.md
```

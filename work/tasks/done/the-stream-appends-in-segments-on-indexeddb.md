---
title: 'The stream appends in segments, behind one core helper, on IndexedDB'
slug: the-stream-appends-in-segments-on-indexeddb
spec: appending-to-the-stream-costs-the-batch
blockedBy: [the-indexer-and-its-stream-cache-agree-on-who-is-ahead]
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

- **`chainId` is not a level of its own**, because the digest that occupies the third position
  distinguishes chains by itself — the real one because the block-0 skeleton entry hashes `chainId`
  and `genesisHash`, and the placeholder because it is derived from `chainId` (above). Never let that
  position collapse to a value shared across chains.
- **The `<digest>` level is present, and its PLACEHOLDER value is DERIVED FROM `chainId`** (for
  example `chain-<chainId>`). `a-reconfigure-is-not-an-outage` computes the real digest and replaces
  the level; do not invent one here. But it must not be a bare constant: the reason `chainId` is
  absent from the address is that the REAL digest already contains it (the block-0 skeleton entry
  hashes `chainId` and `genesisHash`), and that is FALSE of a constant placeholder. With a constant,
  every chain under one indexer name would share one subtree — a REGRESSION against the shipped
  keeper, which separates them with `stream_<name>_<chainId>`, and against `keepStateOnIndexedDB`,
  which still keys `${name}_${chainId}`. Two tabs on two chains would interleave writes into one
  subtree, which is the cross-chain corruption hierarchical addressing is supposed to have deleted.
  Deriving the placeholder from `chainId` preserves the isolation with no extra level and no change of
  shape when the real digest lands. Record the exact form in `## Decisions`.
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

**The keyspace stays in `idb-keyval`'s DEFAULT store**, which is `createStore('keyval-store',
'keyval')` — the same database and object store the bare `get`/`set` calls reach today, and therefore
the one already holding `keepStateOnIndexedDB`'s rows, the legacy flat-key blob and the keys
`invalidation.test.ts` reaches into. `defaultGetStore` is module-private, so re-deriving it from those
two names is the ONLY way to get a `UseStore` over it. This is load-bearing rather than incidental,
and a keeper that quietly opened a store of its own would break three things at once: it would never
SEE the legacy blob it is required to delete (and the test would pass vacuously, because the test
would write the blob through the keeper's own store); it would make "an unrelated key in the same
store survives `clear`" vacuous; and it would remove the whole ground for banning `idb-keyval`'s
`clear()`, which is dangerous exactly BECAUSE the stream shares one store with every other keeper.
Record the two names in `## Decisions`.

### The shape

- **ONE SEGMENT PER BATCH. There is no open tail.** A save writes its batch as a new segment at the
  next ordinal, together with the cursor record, in ONE `readwrite` transaction. Nothing already
  written is ever touched again.
- **The NEXT ORDINAL is carried IN THE CURSOR RECORD, and it is READ INSIDE THE COMMIT
  TRANSACTION.** Both halves matter and the second one is easy to drop. Carrying it in the record is
  forced because nothing else stored holds position metadata any more, and the alternatives differ
  asymptotically: an in-memory counter breaks across tabs, and a `getAllKeys` over the range is
  O(segments) PER SAVE, which would leave the append quadratic in key reads while passing a cost
  criterion that only watches the writes. Reading it in the SAME transaction that writes is what makes
  the allocation safe: `idb-keyval`'s `setMany` opens its own transaction, so a `get` before it is a
  separate one, and two tabs saving at once would both read next-ordinal `5`, both `put` segment `5`,
  and one batch would be lost — with the ordinals still CONTIGUOUS, so the gap check below can never
  detect it. That is silent, permanent data loss, and it is the precise hazard the cursor record was
  chosen over an in-memory counter to avoid, so do not reintroduce it at the transaction boundary.
  **commit-segment-with-cursor is therefore one `readwrite` transaction over the raw store — read the
  cursor, `put` the segment, `put` the cursor — and NOT a call to `setMany`.** IndexedDB serialises
  overlapping `readwrite` transactions on one object store, across tabs, so that is all the mutual
  exclusion this needs; `packages/state-store-indexeddb/src/idb.ts` is the precedent, including its
  rule that inside a transaction you may await only IndexedDB's own promises. Allocation stays O(1).
  (If a future keeper cannot extend its cursor record, the fallback is a reverse key cursor —
  `openCursor(range, 'prev')`, O(log n) — for which `packages/state-store-indexeddb/src/store.ts` is
  the repo's precedent. Do not use a full scan.)
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
therefore holds the three block numbers plus the `context` — plus two numbers that are the keeper's
own bookkeeping rather than part of a `LastSync`: the NEXT ORDINAL (above) and the stream's own
`startBlock` (below). `fetchFrom` returns `unconfirmedBlocks: []`.

### THREE keeper operations, and the cursor contract

WHERE a keeper puts its cursor is its own business, subject to one invariant: **the cursor is
addressed WITHIN its stream's subtree**, so a scoped delete removes it with the segments and `clear`
cannot orphan one.

1. **commit-segment-with-cursor** — write a segment and make the cursor current, together.
2. **read-cursor** — the live cursor, or nothing. This is also what PRESENCE is.
3. **write-cursor-only** — move the cursor with NO segment. An empty save, and nothing else: the
   truncation rewrite that used to share this operation went with the gap recovery.

There is deliberately no seal and no clear-cursor. Sealing existed only to strip a window that is no
longer stored; clear-cursor existed only because a flat key put the cursor outside the enumerable
pattern.

**The cursor contract is THREE properties** (ADR-0035, as amended):

1. **Exactly ONE authoritative cursor per stream.**
2. **A save is atomic in the CURSOR-AHEAD direction.** A cursor claiming coverage the stored events
   do not have is silent data loss. Here it holds through the one `readwrite` transaction that reads
   the cursor and writes both records.
3. **An empty save costs nothing proportional to the history.** Here it is one small record.

### Inconsistency is CLEARED, not repaired

**One rule replaces a whole recovery machine: if what is stored is not a complete, contiguous stream
with a cursor, DELETE THE SUBTREE and let it rebuild.** That covers every case:

- a GAP in the ordinals (`0`, `1`, `3`);
- SEGMENTS with no cursor. Do NOT reason that this one is unreachable and skip the check: read-cursor
  returning nothing is ALSO what a never-written stream looks like, so `fetchFrom` must delete the
  subtree UNCONDITIONALLY before reporting absent. "They would be replayed by nothing and re-appended
  over" is false — with no cursor there is nothing to allocate from, so the next save takes ordinal
  `0` again, overwrites the old segment `0` and leaves every higher ordinal in place to be replayed as
  part of the new stream. And nothing else will clean it up: `indexer.ts` only clears on absence in
  its state-DISCARDED branch;
- a segment that fails to parse.

**A CURSOR WITH NO SEGMENTS IS LEGAL AND MUST NOT BE CLEARED.** It is the ordinary state of a stream
that has been scanned but found nothing yet: an empty save writes exactly that, and a deployment whose
contracts have not emitted anything is in it for as long as that lasts. Clearing it would wipe the
cursor on every reload and re-scan from the start block forever, which is the bug this rule most has
to avoid. `fetchFrom` returns a DEFINED result with no events, which is precisely what stops
`indexer.ts` taking its clear branch. Distinguishing it costs nothing: the cursor says how far the
scan got, and "no events in that range" is a fact about the chain rather than damage.

**Not clearing it is only HALF of it, and the other half is NOT this task's.** Keeping the cursor
stops the clear branch; it does not by itself make the indexer RESUME from it, because in the
state-discarded load branch the fetched cursor is adopted only as a side effect of feeding events (the
`feed` call sits behind a `replayable.length > 0` guard). A stream holding a cursor and no events
therefore leaves the in-memory cursor at `freshLastSync` and the scan restarts from the start block on
every reload. That is the same bug arriving through the consumer, and it is fixed in
`the-indexer-and-its-stream-cache-agree-on-who-is-ahead`, which this task is `blockedBy`. Build
against it as done: the keeper's job here is only to keep the cursor and report the stream present.

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

**But that clear branch exists in only ONE of the two load branches, which is why the cursor record
also carries the stream's own START BLOCK.** `indexer.ts` clears on an absent stream when the STATE
was discarded; its state-KEPT branch guards everything behind `if (existingStreamData)` and has no
`else`, so a self-clear there is followed by no re-fetch at all. Indexing simply carries on from the
STATE's cursor, and the next save opens a NEW subtree whose first segment begins mid-history. Nothing
marks that stream as partial — `streamMatches` compares the source hashes against `lastToBlock` and
nothing else — so a later state discard REPLAYS it as though it were the whole history and rebuilds
silently wrong state. Every self-clear the rule above adds reaches this: a gap, an unparseable
segment, orphan segments, and the legacy blob, which is the one every existing local profile hits on
its first upgrade.

So the cursor record ALSO holds `startBlock`: the `lastFromBlock` of the FIRST save into this subtree,
written once and never updated. **`fetchFrom(source, fromBlock)` refuses a stream it cannot serve**:
if `startBlock > fromBlock`, the subtree is CLEARED, the clear is logged, and it reports absent, like
any other inconsistency. In the state-kept branch that test passes and costs nothing (the requested
`fromBlock` IS the resume point); on the next load that discards state the request is for
`defaultFromBlock`, the partial stream is cleared, and the indexer re-fetches the history instead of
trusting a stream that starts above it. One number and one comparison, and it is what makes "clear it
and let it rebuild" safe on BOTH branches rather than on one.

**Compare against the REQUESTED `fromBlock`, never against the source's own minimum**, even though
the two coincide exactly where it matters. `defaultFromBlock` IS `defaultFromBlockOf(source)` — the
lowest `startBlock` among the source's contracts, `0` if any contract declares none — and a healthy
first-ever save records precisely that as its `startBlock`, since the first fetch runs from there. So
in practice the rule reads: a stream that does not reach back to the source's earliest start block is
not served for a REBUILD. But a keeper that re-derived that minimum itself would hold a second copy
of a rule the indexer owns, and it would apply it in the wrong place: the state-kept branch asks from
the RESUME point, so a keeper comparing to the source minimum would clear the partial stream on every
reload and the next save would recreate it partial — a clear-and-recreate loop that never converges,
and a re-index nobody asked for on a deployment whose state is perfectly good. Comparing to what was
ASKED defers the clear to the one moment it changes an outcome. (A source that GAINS a contract with
an earlier `startBlock` lowers `defaultFromBlock` and therefore clears the stream on the next
rebuild, which is correct; `streamMatches` will usually have failed first, since that is a filter
growth.)

**One guard on the WRITE side, and it REFUSES rather than destroys.** A batch whose `lastFromBlock` is
above the stored cursor's `lastToBlock + 1` would put a HOLE in the middle of the stream, and no
segment-level check can see it afterwards: segments are keyed by save rather than by block, so a save
that never happened leaves the ordinals perfectly contiguous. That hole's real cause is an engine one
(a state that advanced past events the stream never received) and it is FIXED there, by
`the-indexer-and-its-stream-cache-agree-on-who-is-ahead`. So this is not the fix; it is what makes the
fix's FREEZE safe.

On a forward jump: **write nothing, keep everything, log it once rather than once per cycle.** Do NOT
clear. What is on disk is a contiguous prefix with a cursor that describes it honestly, which is a
usable partial seed (it replays, and the remainder is re-fetched from its cursor), and destroying it
would cost the user a re-fetch from the source's first block for no gain. Refusing is also what makes
the cache REVIVE by itself: the engine keeps attempting the write, an append that is contiguous or
overlapping is accepted and the stream is whole again, and one that would jump is simply declined.
This guard is the arbiter of both, which is why it is one comparison and not a policy.

**Only a forward jump** — an OVERLAP (`lastFromBlock` at or below the stored `lastToBlock`) is the
ordinary reorg re-scan, since every cycle at the tip re-reads the last `finality` blocks, and treating
that as damage would refuse almost every save. The one exception that DOES clear is a keeper that
knows its write failed for want of SPACE: there the cache is itself the problem, so freeing it is the
remedy rather than a loss.

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
      string-prefix matching exists anywhere, and that `chainId` is not a LEVEL of the address. It is
      NOT absent from the address altogether — the placeholder digest is derived from it, which is
      what keeps two chains apart until the real digest lands — so an assertion that the string never
      appears anywhere in the key is the wrong test and would push the placeholder back to the bare
      constant this task rejects.
- [ ] **Segments are read by KEY RANGE, not a whole-store scan.** Assert that reading one stream does
      not read keys belonging to another, by count at the instrumented seam — this is what keeps
      `fetchFrom` O(stream) rather than O(store) once several streams exist.
- [ ] **Two CHAINS under one indexer name do not see each other**, which during the placeholder period
      is what the digest level is carrying: index the same name on two chains, and assert writing,
      reading and clearing one leaves the other complete and readable, and that its replay is
      unpolluted. This is the successor to the shipped keeper's `stream_<name>_<chainId>` isolation
      and it must not regress. Two different indexer NAMES likewise.
- [ ] **A save writes exactly its BATCH plus the cursor record, and NOTHING already written**,
      asserted as WORK at the INSTRUMENTED OBJECT STORE — wrap the `UseStore` and count the `put`s and
      their keys. Mocking `idb-keyval`'s `set` or `setMany` measures nothing now that the commit is a
      raw transaction, and a criterion naming either would pass vacuously. Assert exactly TWO puts per
      non-empty save (its segment, its cursor), that the bytes written on the 100th save match the
      100th batch and grow with neither the history NOR any threshold, and that no previously-written
      segment key is ever written again. Wall-clock cannot be the yardstick:
      `fake-indexeddb` is itself quadratic (`work/notes/observations/fake-indexeddb-write-cost-grows-quadratically.md`)
      and ADR-0032 rules it out on a loaded machine.
- [ ] **A save reads the cursor and writes both records in ONE `readwrite` transaction**, and
      **two keepers cannot lose a batch**: drive two keeper instances over one store with interleaved
      saves and assert no ordinal is ever written twice and no batch goes missing. A `get` followed by
      `setMany` passes every other criterion here and fails this one, which is the point of having it.
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
      `k`, segments with no cursor, and an unparseable segment. In every case nothing raises, the
      subtree is gone, presence reads FALSE, the clear is logged, and the next load takes
      `indexer.ts`'s existing clear branch.
- [ ] **A stream that does not reach back to the requested `fromBlock` is CLEARED, not served.** Build
      the case end to end rather than by hand, because it is the one a self-clear creates: with state
      KEPT, make `fetchFrom` clear (a legacy blob is the cheapest trigger), index further so a new
      subtree is written from mid-history, then discard the state and reload. Assert the partial
      stream is cleared rather than replayed, that the indexer re-fetches from the start block, and
      that the rebuilt state equals a from-scratch index. Without the `startBlock` check this test
      produces state that is silently WRONG and everything else stays green. Assert the NEGATIVE too,
      in the same test: while the state is still kept, reloading repeatedly does NOT clear the partial
      stream, because a keeper that compares `startBlock` against the source's minimum instead of
      against the requested `fromBlock` passes the first half of this criterion and then re-indexes
      on every reload forever.
- [ ] **A FORWARD JUMP on save is REFUSED, not cleared, and an OVERLAP is accepted**: hand the keeper
      a batch starting above the stored cursor's `lastToBlock + 1` and assert nothing is written, the
      existing segments and cursor are untouched, and it is logged; hand it an ordinary tip re-fetch
      that dips back into the finality window and assert it is appended normally with its retractions.
      Then hand it a contiguous batch and assert the stream accepts it and is whole again, which is
      the revival path the engine task depends on.
- [ ] **A CURSOR WITH NO SEGMENTS IS NOT CLEARED**, and this is the paired negative that matters most:
      write an empty first save, reload, and assert the cursor SURVIVES, `fetchFrom` returns a DEFINED
      result with no events, and the indexer resumes from that cursor rather than the start block.
      Then do it repeatedly, as a deployment whose contracts have emitted nothing does, and assert the
      scan position keeps ADVANCING across reloads. A keeper that treats this as damage re-scans from
      the start block forever. **Run it with NO `keepState` configured**, which is the only shape
      where the stream's cursor is what resumption depends on; with state kept the state's cursor
      carries it and the criterion passes without testing anything. The resumption half of this is
      delivered by `the-indexer-and-its-stream-cache-agree-on-who-is-ahead`; assert it here anyway, as
      the check that the two halves met.
- [ ] **The next ORDINAL comes from the cursor record**, asserted by instrumenting reads: a save
      performs NO range scan or `getAllKeys` to decide where to write, and its one cursor read happens
      INSIDE the commit transaction. This is what keeps the append linear in key reads as well as in
      bytes, and what keeps two tabs from colliding on an ordinal.
- [ ] **A segment is never written twice.**
- [ ] **`fetchFrom` answers exactly what it answers today** for the same `fromBlock`: same events,
      same order. Strict equality — this task changes no event shape.
- [ ] **`fetchFrom` returns a DEFINED result** for a stream saved with no events.
- [ ] **Replay across a reorg** returns retractions in APPEND order.
- [ ] **The migration**: a stream in the shipped flat-key blob format is DELETED and re-indexed rather
      than adopted, and the deletion is logged. Detect it in `fetchFrom` (not only in `clear`):
      `indexer.ts`'s state-kept branch guards its `clear` behind `if (existingStreamData)`, so a blob
      found only by `clear` would survive indefinitely. There is no dropped-raw-half case to test
      here — ADR-0034's clearing mandate is about a blob that is READ and cannot be re-decoded, and
      this design never reads one.
- [ ] `packages/browser/test/invalidation.test.ts` reaches into the old stream key and is updated
      DELIBERATELY for the new address, still asserting what it was written to assert.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `the-indexer-and-its-stream-cache-agree-on-who-is-ahead`: it fixes the engine side of the same
  invariant — the stream is written BEFORE the state advances, a failed write drops the cache instead
  of holing it, a stream ahead of the state is replayed rather than re-fetched, and a present-but-empty
  stream's cursor is adopted. Two criteria here cannot pass until it lands, and the clear-on-damage
  rule below is only safe once the write order is fixed.

## Prompt

Read the source spec `appending-to-the-stream-costs-the-batch` (`work/specs/tasked/`) and
`docs/adr/0035-*` INCLUDING ITS AMENDMENT in full first. The ADR carries the reasoning behind the
address, the cursor contract and the operations, including why several tempting alternatives are
wrong and which earlier rules were withdrawn.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
dependency landed differently, or an ADR superseded an assumption here, do NOT build on the stale
premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
needs-attention signal").

**The code that exists is EVIDENCE, not authority.** Read it to learn what is true today, not to
infer what must stay. Nothing here is published (`CONTEXT.md`), and this review already found one
mechanism in the engine that looks like a safety net and never fires. If a shape in your way is
wrong, refactor it rather than building around it; the only fixed points are this task's acceptance
criteria, its scope fence, and the ADRs it names.

**Where to look.** `packages/browser/src/storage/stream/OnIndexedDB.ts` is the keeper.
`packages/state-store-indexeddb/src/idb.ts` and `src/keys.ts` are the repo's existing raw-IndexedDB
practice (promise wrappers, `IDBKeyRange.bound`, cursors, multi-store transactions) and are the model
for the key-range reads. The consumer is `packages/core/src/indexer.ts` (five `keepStream.clear` call
sites, the clear-on-undefined branch, and the state-kept branch that has no `else`). The reorg
re-append and `generateStreamToAppend` are in `packages/core/src/internal/engine/utils.ts`.
`packages/browser/test/invalidation.test.ts` reaches into the stream key.

**Domain vocabulary.** A *segment* is `{events}`. The *cursor* is a `LastSync` MINUS its window, kept
as its own *cursor record* inside the stream's subtree and committed with its segment in one
transaction; it is the ONLY place the three block numbers and the `context` live, and it carries two
numbers of the keeper's own beside them: the NEXT ORDINAL and the stream's `startBlock`. The
stored stream is an *emission stream*, so a later segment can hold LOWER block numbers and no segment
may be skipped on a block bound. There is no *tail* and no *seal* — those were a filesystem strategy
and the filesystem keeper is gone.

**Easy to get wrong:**

- Use a KEY RANGE. `keys()` reads the whole store; with several streams that is the quadratic problem
  moved from the write path to the read path.
- Keep the keyspace in `idb-keyval`'s DEFAULT store (`createStore('keyval-store', 'keyval')`). A store
  of its own silently hides the legacy blob and makes two `clear` criteria vacuous.
- The commit is a raw `readwrite` transaction that READS the cursor and writes both records, not a
  `get` followed by `setMany`. The split version loses a batch across two tabs, contiguously, so
  nothing detects it afterwards.
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

**Scope fence.** Do NOT edit `packages/core/src/indexer.ts`: the engine changes this task depends on
(the write order, the failed-write drop, feeding a stream that is ahead, adopting an empty cursor) are
`the-indexer-and-its-stream-cache-agree-on-who-is-ahead`'s, they land first, and touching that file
here would collide. Do NOT make the stream raw-only (that is `the-stream-stores-only-what-the-node-said`).
Do NOT compute a real stream digest or write a canonical pointer (those are
`a-reconfigure-is-not-an-outage`'s); use a placeholder for the digest level. Do NOT add per-segment
block-range metadata. Do NOT add a filesystem keeper.

> **DRIFT CORRECTION (conductor, 2026-09-02) — this is NOT a needs-attention signal.** This task's
> fence used to read "do NOT DELETE `packages/fs`: it still exists at HEAD". It no longer does:
> `drop-filesystem-storage-and-rehome-the-fixture-loader` has since LANDED and deleted both
> `packages/fs` and `packages/fs-cache`. There is nothing left to collide with and nothing to avoid
> deleting — the fence is simply moot, so do NOT stop on it. Two consequences for the text above,
> both cosmetic: the `packages/fs/src/utils/fs.ts` clear-the-folder precedent cited for the legacy
> blob is now a HISTORICAL citation (read it in `git log` if you want it; the argument it supports is
> unchanged and still governs), and `@etherfold/fs` is no longer a package you could import even by
> accident. Everything else in this task — the address, the cursor contract, the three keeper
> operations, every acceptance criterion — is unaffected.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (the
placeholder digest constant; the two store names and how you obtained a `UseStore` over the default
store; the key-range construction and its upper bound; how you instrumented the object store for the
cost and allocation assertions; the exact shape of the three keeper operations and of the cursor
record, `startBlock` and next-ordinal included). That block is the ONE
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

## Requeue 2026-09-02

Environment was torn down mid-build (session teardown cleared /tmp and killed the agent). The runner's abort handler saved ~1600 lines as WIP commit 9298e29; the conductor pushed that branch to the arbiter so this re-claim CONTINUES from its tip. Work completed so far: core/src/stream/segments.ts helper, OnIndexedDB keeper rewrite, core+browser segment tests, changeset. NOT yet run: the acceptance gate. Continue from the branch tip and finish; do not restart.

## Decisions

**Placeholder digest is `chain-${chainId}`, exported as `placeholderStreamDigest(chainId)`.** Derived from `chainId` rather than a bare constant, because the ground for `chainId` being absent from the address is that the *real* digest contains it, and that is false of a constant: every chain under one indexer name would share one subtree, regressing both the shipped `stream_<name>_<chainId>` and `keepStateOnIndexedDB`'s `${name}_${chainId}`. Alternative considered and rejected: a `'placeholder'` literal plus a fifth `chainId` level, which changes the address *shape* when `a-reconfigure-is-not-an-outage` lands. Touches that task: it replaces this function's return value and nothing else.

**Store names `'keyval-store'` / `'keyval'`, re-derived via `createStore`, memoised module-wide.** `idb-keyval`'s `defaultGetStore` is module-private, so naming the two strings is the only route to a `UseStore` over the very store the bare `get`/`set` calls reach. Exported as `KEYVAL_DATABASE` / `KEYVAL_OBJECT_STORE` so a test can build an instrumented `UseStore` over the *same* store. Memoised (one connection per page, not per keeper) mirroring `idb-keyval`'s own memoisation. Touches `keepStateOnIndexedDB` and `invalidation.test.ts` implicitly: they share this store, which is exactly the point.

**Two key ranges, not one, exposed from `streamAddress`.** `subtree` is `bound([...prefix, 0], [...prefix, []])` — the empty ARRAY upper bound spans the whole subtree including the `'cursor'` string record, since IndexedDB orders `number < string < array`; that is what `clear` uses so a scoped delete cannot orphan the cursor. `segments` is `bound([...prefix, 0], [...prefix, 'cursor'], false, true)` — the string bound excluded, so a full ordered scan does not return the cursor record as though it were a segment. Using the wrong one is a real bug in either direction, so both are named and commented at the construction site.

**`keepStreamOnIndexedDB(name, {store?})` gains an injectable `UseStore`.** This is a new user-visible parameter. It exists because cost and allocation must be asserted as work at the *instrumented object store*: now that the commit is a raw transaction, mocking `idb-keyval`'s `set`/`setMany` measures nothing and a criterion naming either would pass vacuously. The test wraps the object store in a `Proxy` counting `put`/`get`/`delete` and the three scan methods, capturing each request's `IDBTransaction` identity — which is how "one transaction" is asserted rather than assumed. Defaults to the shared default store, so no caller changes. Alternative rejected: a module-level test hook, which would be a hidden global.

**The port is FIVE operations, not three.** ADR-0035's three (`commitSegmentWithCursor` / `readCursor` / `writeCursorOnly`) are the CURSOR seam and are all named as such; `readSegments` and `clearSubtree` are the ordered scan and the scoped delete every substrate needs and neither moves a cursor. I kept the ADR's word "three" for the cursor operations rather than re-meaning it to five, and said so in the type's doc comment. A SQL or OPFS keeper supplies all five.

**The two write operations take a DECISION FUNCTION, not a record.** `commitSegmentWithCursor(source, allocate)` where `allocate(current) => SegmentCommit | undefined`. Forced: the ordinal, the start block and the hole check must be decided from the current cursor *inside* the keeper's transaction, and a port that read-returned-then-wrote would lose a batch across two tabs with the ordinals still contiguous afterwards. The callback is synchronous for the same reason `@etherfold/state-store-indexeddb` keeps its cursor steps synchronous. Returning `undefined` is how the helper expresses "refuse this write", which is what makes the forward-jump guard a decision the helper owns and the keeper merely honours.

**Cursor record shape:** `{context, latestBlock, lastFromBlock, lastToBlock, startBlock, nextOrdinal}`. A `LastSync` minus `unconfirmedBlocks`, plus two of the keeper's own. `nextOrdinal` is the ordinal the next segment takes (equal to the segment count), read inside the commit. `startBlock` is the `lastFromBlock` of the first save into the subtree, written once and never updated. A segment is `{events}` and nothing else — asserted by `Object.keys()` in the browser suite, so a later addition breaks a test rather than passing silently.

**`fetchFrom` also cross-checks `stored.length` against `cursor.nextOrdinal`.** Not named in the criteria; it catches a truncation at the TOP of the range (segments `0,1` with a cursor claiming 3), which the per-index gap check alone cannot see. Same clear-and-rebuild rule, no new concept.

**`streamCache.test.ts`'s inspection helpers now ask from `START_BLOCK`, not `0`.** Deliberate and worth flagging: `fetchFrom` now *clears* a stream that does not reach back to what was asked, so a test helper asking from block 0 would destroy the very stream it came to read. The assertions are unchanged; only the block asked for is.

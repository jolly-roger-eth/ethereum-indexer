---
title: 'The indexer and its stream cache agree on who is ahead'
slug: the-indexer-and-its-stream-cache-agree-on-who-is-ahead
blockedBy: []
covers: []
---

## What to build

Three changes to the ENGINE, which together make one invariant true by construction instead of by
hope: **the cached stream may be behind the state or ahead of it, and either is recoverable, because
it is always a contiguous prefix of the history.** What must never exist is a stream with a HOLE, and
today one can form silently and is undetectable afterwards.

This is engine work, not keeper work. It is split out of
`the-stream-appends-in-segments-on-indexeddb`, which is `blockedBy` this task and owns the storage
layout; nothing here changes how a stream is stored.

### Why a hole can form today, and why nothing catches it

First, the word. A **hole** is a gap in what the stream CONTAINS, hidden behind a cursor that claims
the range: events `[100..5000]` and then `[6001..7000]`, with a cursor saying 7000. It is NOT the two
cursors disagreeing, which is harmless: the cursor is a coverage CLAIM rather than a timestamp on each
event, so writing an earlier cycle's events together with a later cycle's cursor is entirely correct
as long as the events written complete the coverage the cursor claims.

`promiseToIndex` processes and THEN saves: `processor.process(...)` is awaited, and the stream save is
awaited after it. The processor persists its own state inside `process()`. So the state advances
first, and if the save then fails, the stream is behind by that batch. The next cycle then computes
its delta from the state's ALREADY-ADVANCED cursor, so it contains only the newer events, and the
stream's cursor jumps over a range its events never received.

**The mechanism that is supposed to prevent exactly this never runs, and that is worth checking before
building rather than trusting.** `promiseToSave` swallows the failure and keeps the unsaved events in
an in-memory list (`streamNotYetSaved`) held on the save operation's promise CONTEXT, to be written
with the next save. But `save()` uses that wrapper's `queue` mode, and the context survives only when
a save is queued onto a save that is still IN FLIGHT; when the previous one has completed, `_execute`
falls through to the branch that resets `_context` to `undefined`. And `promiseToIndex` awaits the
save before the cycle ends, so in the ordinary rhythm no save is ever queued onto an in-flight one.
The list is therefore empty at push time every time: the carry-forward never happens, and a single
failed write drops its batch immediately, in the same session, with no reload and no crash needed.

The result is a stream holding, say, `[100..5000]` and then `[6001..]`, with a cursor claiming
coverage of all of it. **Nothing detects that.** Segments are keyed by SAVE, not by block, so a save
that never happened leaves no ordinal gap: the contiguity check in the keeper task is satisfied. On
the next state discard the stream replays as though it were complete, and `5001..6000` is simply
absent from the rebuilt state. Silent, permanent, and self-consistent.

**A second incoherence comes from the same cause**, and it is the reorg form of it: once the state has
advanced its unconfirmed window past events the stream never received, a reorg on the next cycle
derives retractions FROM THAT WINDOW and hands the stream a `removed` marker for an event it does not
hold. So state one of the invariant explicitly: **a retraction is never written into a stream that
lacks the event it retracts.** Holding the cursor back until the write lands gives that for free,
since the window cannot then advance past the stream.

### 1. Save the stream BEFORE processing, and do not process a batch that was not saved

Swap the two. A cache must never be behind the thing it exists to replay into.

Flipping the order alone is not enough, because the swallowed error would reproduce the same hole one
line earlier. **A failed stream write means the batch is not processed and the cursor does not move.**
The cycle simply achieves nothing and the next one tries again, which is the whole recovery: nothing
is lost, nothing is skipped, and the stream cannot fall behind the state even by one batch.

**Retrying costs nothing to arrange, and it DELETES a mechanism rather than adding one.**
`promiseToSave` currently keeps unsaved events in an in-memory list (`streamNotYetSaved`, held on the
save operation's context) and carries them to the next save. That list exists ONLY to compensate for
processing first: the cursor ran ahead of the write, so something had to remember what the write had
missed. With the order flipped and the cursor held back, the next cycle recomputes the delta from the
SAME cursor and re-derives those events plus whatever the tip has added since, so the list is
redundant. Worse than redundant: it appends without de-duplicating, so a cursor that no longer
advances would make it accumulate the same events on every retry. Delete it. It is read nowhere else.

**But a cache must never be able to WEDGE the indexer, so the retry is bounded.** A store that is
permanently unwritable is not hypothetical: a quota exceeded, a private window, a disabled or evicted
database. Retrying forever would leave a browser showing stale data indefinitely because an
OPTIMISATION failed, and `keepStream` is optional, so that would make configuring a cache strictly
more fragile than not having one. So after a small number of CONSECUTIVE failed writes, **stop trying,
say so loudly, and carry on processing without the cache.** Reset the counter on any successful write,
and pick the bound and say why in `## Decisions`.

**Stopping means FREEZING the stream, not clearing it**, and the difference matters more than it
looks. What is on disk at that point is a contiguous prefix with a cursor that describes it honestly.
That is the BEHIND case, which is benign by construction: on a rebuild it is replayed and the
remainder is re-fetched from its cursor. So a frozen prefix is a usable partial seed, and throwing it
away would cost the user a re-fetch from the source's first block, which is exactly the thing that can
be impossible on a public node. Keep it.

**A frozen stream REVIVES by itself, with no new machinery**, because the keeper's forward-jump guard
is already the arbiter: an append that is contiguous with (or overlaps) the stored cursor is accepted,
and one that would jump is refused. A short outage therefore heals seamlessly, since every cycle
re-reads the finality window and the next successful append still overlaps. A long one does not, and
the stream simply stays where it stopped. So keep ATTEMPTING the write on a schedule of your choosing
rather than latching the cache off permanently; the guard makes a wrong attempt harmless.

**One cause justifies discarding instead, and it is the one that is self-inflicted: no space left.**
There the cache IS the problem, freezing preserves the cause, and deleting frees it. So this is
cause-directed rather than a policy: a keeper that knows its write failed for want of space says so,
and THAT clears the subtree. Read the flag STRUCTURALLY, the way `isRetryable` already does in
`@etherfold/fetcher-host`, so a second copy of the package in one dependency tree cannot turn it into
something else, and do not invent a parallel vocabulary for it. Every other persistent failure
freezes.

One consequence to keep in view: a driver that loops until the tip advances (the CLI's one-shot, the
browser's auto-index) must not spin hot while writes are failing. The bound above guarantees it
terminates; make sure the retries are paced rather than immediate.

**Closing the one new path this order creates.** The batch handed to a save is a DELTA computed
against the in-memory cursor, and that cursor only advances after `process` RETURNS. So with the
writes flipped, a processor that THROWS leaves the events already in the stream while the cursor stays
put, and the next cycle recomputes the identical delta and appends it AGAIN. A handler that throws
deterministically (an app bug, the ordinary reason for this) therefore grows the cache by one
duplicate copy per retry, and those duplicates replay twice once the app is fixed. Today, with process
first, a failing processor writes nothing, so this path does not exist and it must not be created.

The cure is not a clear (a transient processor failure must not cost a large cache) and not a
transaction: **track the extent of the last SUCCESSFUL write in memory, and skip a save that repeats
it.** That is the same in-memory slot the deleted list occupied, inverted: a high-water mark of what
IS written rather than a buffer of what is not, which is the honest thing to remember once the cursor
can no longer run ahead of the write. In-memory is the right scope because it only has to survive the
retry loop; a reload is covered by change 2, which catches the state up to the stream so the next
delta starts above it. Do NOT try to detect this in the keeper by comparing block ranges: an
overlapping re-fetch and a reorg at an unchanged tip look the same from there, and the keeper would
drop a retraction.

### 2. FEED a stream that is ahead of the state, in the state-kept load branch

Once the write order is flipped, the reachable divergence becomes "stream ahead of state": the write
lands and then `process` throws, or the tab is closed between the two awaits, which in a browser is
ordinary rather than exotic.

That direction is supposed to be benign because the processor just catches up. The state-DISCARDED
load branch does exactly that. **The state-KEPT branch does not**: it calls `fetchFrom`, reads only
`lastToBlock` and the context, clears on a mismatch, and never feeds. So the state catches up from the
NODE instead, and those blocks are appended to the stream a second time. On the next rebuild the
processor sees them twice, which for anything that is not idempotent is wrong state, again silently.

So: when the stream is present, matches, and its `lastToBlock` is ABOVE the state's, re-decode it and
feed it. `fetchFrom` is already being called with `getFromBlock(<state cursor>)`, so it already returns
precisely the events the state is missing. This is what a cache is for, and it turns a node re-fetch
into a local replay. The two load branches end up nearly the same code, which is a simplification.

Two details that will otherwise cost an afternoon:

- **Assign the requested `fromBlock` onto the fetched cursor before feeding**, exactly as the
  discarded branch already does. `generateStreamToAppend` throws `UnexpectedFromBlockError` unless the
  incoming `lastFromBlock` equals `getFromBlock(<current cursor>)`, and the stored cursor's own
  `lastFromBlock` is whatever the last fetch used, not what was asked for now.
- **Set the current cursor BEFORE the keepStream block, not after it.** The state-kept branch
  currently assigns `this.lastSync = currentLastSync` AFTER consulting the stream; feeding inside that
  branch and then hitting that assignment throws the catch-up away.

### 3. ADOPT a fetched cursor when the replay is EMPTY

In the state-discarded branch the fetched cursor is adopted only as a SIDE EFFECT of feeding events:
the `feed` call sits behind a `replayable.length > 0` guard. So a stream that holds a cursor and no
events (the ordinary state of a deployment whose contracts have not emitted anything, and what an
empty save writes) leaves the in-memory cursor at `freshLastSync`, whose `latestBlock` is `0`, so
`getFromBlock` returns the default and the scan restarts from the start block on every reload, forever.

When the stream is present and the replay is empty, adopt the fetched cursor directly, with the
current processor hash and an empty window. The empty window is correct rather than lossy: there are
no stored events, so there is nothing a reorg could retract, and the window is rebuilt from the next
fetch.

### What must NOT change

- **An OVERLAP stays legal.** The stored stream is an emission stream and every cycle at the tip
  re-fetches the last `finality` blocks, so a batch whose range dips below the stream's `lastToBlock`
  is ordinary. Only a FORWARD JUMP is damage.
- **The window still lives on the state side.** `checkTxInclusion` is answered from
  `LastSync.unconfirmedBlocks` and nothing else, and a deployment with no stream keeper recovers it
  from the state's cursor on reload.
- **Retraction batching.** `feed` deliberately puts every retraction of one reorg in a single
  `process` call; the new feed path must not split them.

## Acceptance criteria

- [ ] **The stream is written BEFORE the processor is called**, asserted at instrumented seams rather
      than read off the source: with both stubbed, the stream write completes before `process` starts.
- [ ] **A TRANSIENT write failure loses nothing and keeps the cache**: fail one write, assert the
      batch was NOT processed and the cursor did not move, let the next cycle succeed, and assert the
      stream holds that batch exactly once, the subtree was never cleared, and the state lands where
      an unbroken run lands.
- [ ] **A PERMANENT write failure does not wedge the indexer, and does not destroy the cache**: fail
      every write, assert that after a bounded number of consecutive failures the failure is logged
      plainly and indexing RESUMES and the state advances, and that what was already on disk SURVIVES
      as a contiguous prefix. Then assert a reload replays that prefix and re-fetches only the
      remainder, landing on a state equal to a from-scratch index. That last equality is the assertion
      that would have failed before this task.
- [ ] **A frozen stream revives when writes recover**: fail writes for a couple of cycles, then let
      them succeed while the fetch range still overlaps the stored cursor, and assert the append is
      accepted and the stream is contiguous. Let the outage run long enough to move past the window
      instead, and assert the append is REFUSED and the prefix is still intact.
- [ ] **A no-space failure DOES clear**: with the keeper reporting that the store is out of space,
      assert the subtree is cleared rather than frozen, since there the cache is the cause.
- [ ] **A retraction is never written into a stream that lacks the retracted event**, asserted on the
      path that produced it: hold the write back, let a reorg land, and assert the stream never
      receives a `removed` marker for an event it does not hold.
- [ ] **No hot spin**: while writes are failing, the retry is paced, and a driver that loops to the
      tip still terminates.
- [ ] **A throwing processor does not grow the cache.** Make `process` throw deterministically, let
      the cycle retry several times, and assert the stream holds exactly ONE copy of that batch and
      that the subtree is NOT cleared (a transient processor failure must not destroy a large cache).
      Then let `process` succeed and assert a replay produces the same state as a from-scratch index.
- [ ] **Death between the two writes leaves no duplicate.** Simulate the tab dying after the stream
      write and before `process` (drop the indexer, keep the stores), reload with the state behind the
      stream, and assert the missing blocks are NOT re-fetched from the node, that no event appears
      twice in a subsequent replay, and that the final state equals a from-scratch index.
- [ ] **A stream ahead of the state is REPLAYED, not re-fetched**: with state kept and the stream
      ahead, assert the node is asked for nothing already in the stream (count the ranges the fake
      chain was asked for, the way the invalidation tests do) and the state catches up to the stream's
      cursor.
- [ ] **A cursor with no segments resumes**: with a stream keeper and NO `keepState`, save an empty
      batch, reload, and assert the indexer resumes from the stored cursor rather than the start
      block; repeat it and assert the scan position keeps ADVANCING across reloads.
- [ ] **A reorg still behaves**: an overlapping re-fetch is not treated as damage, retractions come
      back in append order, and every retraction of one reorg still arrives in ONE `process` call.
- [ ] **`checkTxInclusion` is unaffected**, asserted across a reload with NO stream keeper configured,
      so a change to the stream path cannot quietly cost the state path its window.
- [ ] Tests live beside the existing engine tests and use the repo's fake chain and `fake-indexeddb`;
      no test touches a real environment.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green, plus a changeset for `@etherfold/core` if any
      published surface moved.

## Blocked by

- None — can start immediately. `the-stream-appends-in-segments-on-indexeddb` is blocked on THIS, not
  the other way round: the keeper's cursor-with-no-segments criterion cannot pass until change 3
  lands, and its clear-on-damage rule is only safe once the write order is fixed.

## Prompt

> Make the indexer and its cached event stream agree on which of them is ahead, in the `etherfold`
> monorepo, so that the cache can be behind or ahead but never HOLED.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently, or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **The code that exists is EVIDENCE, not authority.** This task is largely the consequence of taking
> one mechanism at face value: the unsaved-events list READS as a safety net and never fires, because
> the promise context it lives on is reset between cycles. So read the existing code to learn what is
> true, not to infer what must stay. Nothing here is published (`CONTEXT.md`). Where a shape is in your
> way, refactor it rather than building around it, and delete what stops earning its keep; the fixed
> points are the acceptance criteria, the scope fence and the ADRs named here. If a refactor grows
> beyond this task's three changes, say so in `## Decisions` rather than smuggling it in.
>
> **Where to look.** Everything is in `packages/core/src/indexer.ts`: the index cycle that processes
> and then saves, the save wrapper that swallows a failed write and holds unsaved events in memory, and
> the two branches of the load path (one for a discarded state, which replays the stream, and one for a
> kept state, which only validates it and has no `else`). The reorg model and the cursor arithmetic are
> in `packages/core/src/internal/engine/utils.ts` (`generateStreamToAppend`, `getFromBlock`). The
> keeper this exercises is `packages/browser/src/storage/stream/OnIndexedDB.ts`; the browser tests that
> already count what the fake chain was asked for are the model for the replay-not-refetch assertions.
>
> **Domain vocabulary.** The stored stream is an *emission stream*: on a reorg the indexer re-appends
> superseded events at their ORIGINAL block flagged `removed` and then continues at LOWER blocks, so
> ranges OVERLAP and an overlap is ordinary. A *hole* is the one shape that is damage, and it is
> invisible to a segment-level check because segments are keyed by save rather than by block. The
> *window* (`unconfirmedBlocks`) belongs to the STATE side and is what `checkTxInclusion` is answered
> from; do not move it.
>
> **Easy to get wrong:**
>
> - Flipping the write order WITHOUT changing the swallowed error just moves the hole one line.
> - Retrying a failed cache write FOREVER is the wrong cure: the cache is disposable, the state is
>   the product. Do not process the batch, retry, and after a bounded run of failures drop the cache
>   and keep indexing.
> - Feeding in the state-kept branch needs the requested `fromBlock` assigned onto the fetched cursor
>   first, or `generateStreamToAppend` refuses the batch; and the current cursor must be assigned
>   BEFORE that block, or the assignment after it discards the catch-up.
> - Do not make an overlap into an error. Only a forward jump is damage.
>
> **Scope fence.** Do NOT change how the stream is STORED: the segment layout, the cursor record, its
> `startBlock` field and the read-time refusal all belong to
> `the-stream-appends-in-segments-on-indexeddb`, which is blocked on this task. Work against the keeper
> as it exists at HEAD. Do not rewrite the load path beyond the three changes above.
>
> Done means: with the current blob keeper still in place, a transient failed write, a permanently
> failing write, a throwing processor, a death between the two writes, and an empty-but-present stream
> each end with a state identical to a from-scratch index; a stream ahead of the state is replayed from
> the cache rather than re-fetched from the node; and no cache failure can stop the indexer.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (how
> you simulated the death between the two writes; the bound you chose on consecutive failed writes and
> why; what exactly a failed write logs; whether the feed in the state-kept branch re-decodes). That block is the ONE sanctioned channel for build-time rationale
> and the runner transcribes it into the done record. Do NOT write the done record, the commit message
> or the PR body.

---

### Claiming this task

```sh
dorfl claim the-indexer-and-its-stream-cache-agree-on-who-is-ahead --arbiter origin
git fetch origin && git switch -c work/the-indexer-and-its-stream-cache-agree-on-who-is-ahead origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-indexer-and-its-stream-cache-agree-on-who-is-ahead.md work/tasks/done/the-indexer-and-its-stream-cache-agree-on-who-is-ahead.md
```

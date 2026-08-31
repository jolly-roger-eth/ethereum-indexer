---
title: 'The filesystem stream could be a REAL append, once the cursor stops carrying the window'
slug: the-filesystem-stream-could-be-a-real-append
---

A named follow-up, deliberately NOT built yet and GATED on
`work/specs/proposed/the-stream-stores-only-what-the-node-said.md` landing. Recorded so the option is
not lost and not attempted early.

## What is true after `appending-to-the-stream-costs-the-batch`

The headline claim is "appending costs the batch, not the history", and it is delivered as a BOUNDED
REWRITE rather than as an append. Per save:

- **IndexedDB** writes exactly its batch plus a small cursor record, in one transaction, and never
  rewrites anything. That keeper has no open tail. This half is already as good as it gets.
- **The filesystem** REWRITES its open tail on every save, bounded by the seal threshold and never by
  the history. A head-following indexer therefore rewrites up to a threshold's worth of events on
  every poll, including the polls that carry no events at all.

So the cost went from O(history) to O(threshold), which was the point. What is left on the filesystem
is the O(threshold), and it is not inherent.

## Why the tail is there

Exactly one reason: **a save must be a single write**, because the filesystem has no transaction and
that is how the cursor-ahead property holds by construction (ADR-0035). The tail is not a storage
layout anyone wanted; it is the cheapest way to make one write carry both the events and the cursor.

## The option: newline-delimited JSON, appended

Make a segment a JSONL file. A save APPENDS its events as lines, followed by a cursor line. Then:

- a save costs exactly its batch, on both keepers, and the O(threshold) disappears;
- the single-write atomicity survives, and arguably improves: it is one `appendFile` rather than a
  read-modify-write, so there is no window in which the file holds a partially-rebuilt history;
- a crash-torn TRAILING line is detectable and discardable, because newline framing says where a
  record ends. That is the standard append-only-log recovery and it is strictly easier than detecting
  a torn whole-file rewrite, which is what `temp-file-plus-rename` exists to prevent today;
- the seal, the threshold and the strip could all go, because nothing is ever rewritten.

## Why it is GATED rather than done now

Appending a cursor line per save would accumulate a `LastSync` per save inside the file, and a
`LastSync` carries `unconfirmedBlocks`, which is `EventBlock[]` holding the FULL decoded events of
each block. That is precisely the accumulation the cursor contract's property 3 forbids, arriving
through a different door.

`the-stream-stores-only-what-the-node-said` removes the door: it establishes that the stream keeper's
stored `unconfirmedBlocks` is NEVER READ BACK as events (`promiseToLoad` takes only `lastFromBlock`,
`lastToBlock`, `latestBlock` and `context`; the live reorg window is in memory and
`generateStreamToAppend` rebuilds it from the replayed events), and strips it. After that a cursor
line is three numbers and a context hash, so appending one per save costs nothing and the last one
wins on read.

**Doing this BEFORE that spec lands would mean either accumulating windows or inventing a strip that
spec is about to make unnecessary.** Hence the gate.

## What it would touch

`packages/fs/src/storage/stream/OnFile.ts` and `packages/fs/src/utils/fs.ts` (an append primitive and
a line-framed read). It needs NO change to the shared helper's seam: `commit-segment-with-cursor` is
already a KEEPER operation, so it can be an append here and a `setMany` there without the helper
knowing which. That is the seam doing its job, and it is the reason this is a local change rather
than a redesign.

## What it does NOT change

The address (`[<indexer-name>, <streamDigest>, <ordinal>]`), the read being a full ordered scan, the
contiguity refusal and its recovery, or the four cursor-contract properties. It is a change to how ONE
keeper commits, which is exactly the layer ADR-0035 leaves to a keeper.

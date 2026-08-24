---
title: The sync cursor is written in a second round trip, so a crash between them can wedge the indexer
slug: sync-cursor-write-is-not-atomic-with-the-block-it-describes
observed: 2026-08-24
source: 'derived from reading packages/processor-sqlite/src/VersionedStateEventProcessor.ts and packages/processor-entities/src/apply.ts @ cd69459, while scoping backend-neutral-entity-event-processor. The duplicate-apply throw is pinned by existing tests; the crash window itself is read from the call ordering and has NOT been reproduced live.'
---

`VersionedStateEventProcessor.process()` applies the stream and then writes the cursor as a SEPARATE round trip:

```ts
await applyEventStream(this.store, this.processor, eventStream, this.config as ProcessorConfig);

const cursor = writeLastSyncStatement(lastSync);
await this.db.batch([this.db.prepare(cursor.sql).bind(...cursor.args)]);
```

`applyEventStream` writes each block through `store.applyBlock`, which is atomic per block. The cursor is not part of any of those transactions, so between the last `applyBlock` and the cursor write there is a window where the STATE has advanced and the CURSOR has not.

## Why that window is not self-healing

On restart the indexer resumes from the persisted (stale) cursor and re-fetches blocks it has already applied. `applyEventStream` only reverts when the stream carries a retraction (`forkPoint(eventStream) !== undefined`); a plain replay of already-applied blocks has no fork point, so nothing reverts and the loop goes straight to `store.applyBlock` for a block the store already holds.

Every backend refuses that by design. `MemoryStateStore` raises `block <n> is already recorded: applying the same block twice is a caller bug`, and the shared conformance suite pins the behaviour for every backend (`raises when the same block is applied twice`). That refusal is correct in itself: silently re-applying a block would double-write versions.

The consequence is that the indexer does not merely redo work, it throws on every subsequent start, and no amount of restarting clears it. Recovery needs a hand: revert the store above the cursor, or move the cursor forward to match the state.

## Scope

Read on the SQLite path, which is the only shipped `EventProcessor` over the seam today. The ordering is a property of the processor rather than of any store, so any future processor that writes the cursor after `applyEventStream` inherits it.

The window is narrow (one round trip) and needs a crash or a kill inside it, which is presumably why it has not been seen. It widens with per-request latency, so a remote libSQL is more exposed than a local file.

## The fix has a natural home

`backend-neutral-entity-event-processor` has to move cursor persistence off SQL anyway, because a browser on IndexedDB has no SQL to write a cursor into. Putting the cursor behind the storage seam is the only one of the candidate designs that CAN close this, since only the store holds the transaction the block write happens in. If that task lands the cursor as a seam port, it should write the cursor in the same transaction as the block it describes, and this note is what says why that is worth doing rather than merely tidy.

A deployment-level alternative exists if the seam route is rejected: make replay idempotent instead of atomic, by having the processor skip blocks the store already records rather than letting `applyBlock` refuse them. That trades a crash-consistency guarantee for a tolerance, and it weakens a check that currently catches a real caller bug, so it is the worse answer unless the atomic route proves impossible.

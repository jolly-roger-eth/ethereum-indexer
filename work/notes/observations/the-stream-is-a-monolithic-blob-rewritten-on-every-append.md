---
title: 'The stream is one blob rewritten in full on every append, so it can neither be shared by pointer nor appended to cheaply'
slug: the-stream-is-a-monolithic-blob-rewritten-on-every-append
observed: 2026-08-29
source: 'noticed while investigating whether stream branching (work/notes/ideas/a-stream-branches-instead-of-being-discarded.md) is cheap enough to spec'
---

Both stream keepers persist the WHOLE stream under one key and rewrite it on every append.
`packages/fs/src/storage/stream/OnFile.ts` and `packages/browser/src/storage/stream/OnIndexedDB.ts`
are the same shape:

```ts
const existingStream = await get<StreamData<ABI>>(storageID);
const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
```

Two consequences, and the second was not what we were looking for.

**1. A prefix cannot be shared by pointer.** The branching idea assumes a new version can point at an
existing stream's prefix and grow its own tail. There is no prefix to point AT: there is one value
under one key, and appending rewrites it. Branching therefore needs an append-only, block-keyed
(or segmented) stream before it needs anything else. This is the gate on that whole design, and it
is a storage change rather than an indexer change.

**2. Appending is O(total stream), on every append.** Independent of versioning, and probably the
more urgent finding. Every batch read the entire accumulated stream into memory, concatenated, and
serialised all of it back. So the cost of ingesting block N grows with the number of events already
stored, and a long backfill degrades quadratically. On IndexedDB the whole array is
structured-cloned each time; on the filesystem it is a full re-serialise and rewrite.

**And it doubles the cost of storing `args`.** A `LogEvent` carries the raw log (`topics`, `data`,
`address`) AND the decode of it (`args`, `eventName`). `WireBatch`'s own documentation already
concedes that `args` "restates what `data` and `topics` already encode", accepted there because the
receiving primitive takes decoded events. In STORAGE that redundancy is not just extra bytes at
rest, it is extra bytes rewritten on every single append.

Worth noting what this does NOT undermine: `reparse` (ADR-0034) is transient and in-memory, so it
never rewrites the stream and is not implicated. The problem is the storage shape, not the
re-decode.

Not touched: outside the task that found it, and it wants deciding rather than patching. The
options are at least an append-only segment file, a block-keyed store with range reads, or keeping
the blob and accepting that branching is off the table.

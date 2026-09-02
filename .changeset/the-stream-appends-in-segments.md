---
'@etherfold/core': minor
'@etherfold/browser': minor
---

The cached event stream appends in SEGMENTS, so a save costs its batch and not the history.

`keepStreamOnIndexedDB` used to read the whole stream, concatenate and write all of it back on every `saveNewEvents` — a full structured clone of the accumulated history per index cycle, which made a backfill QUADRATIC and charged an empty batch the same price purely to move the cursor. It now writes one immutable SEGMENT per batch, at the next ordinal, together with a CURSOR RECORD, in one `readwrite` transaction; nothing already written is ever touched again, and an empty save writes only the small cursor record.

The rules live once, in `@etherfold/core`'s new `createSegmentedStream`, over a five-operation `StreamSegmentPort` a keeper supplies (`commitSegmentWithCursor` / `readCursor` / `writeCursorOnly`, plus a scoped segment read and a scoped delete). A SQL keeper and an OPFS keeper are the expected next consumers, and they inherit every rule: the ordinal allocated from the cursor record INSIDE the commit, the full ordered scan on the way back, the one comparison that refuses a write which would leave a hole, and the one rule for damage.

**A stream is now addressed HIERARCHICALLY**, as IndexedDB array keys in `idb-keyval`'s default store: `['stream', <indexer-name>, <digest>, <ordinal>]` for a segment and `['stream', <indexer-name>, <digest>, 'cursor']` for the cursor record. The digest level carries a PLACEHOLDER derived from `chainId` until the real stream digest lands, so two chains under one indexer name stay isolated exactly as `stream_<name>_<chainId>` kept them. Segments are read with a key RANGE, never a whole-store scan.

**A stream stored in the previous whole-blob format is DELETED and re-indexed, not adopted**, and the deletion is logged. Nothing is published and no disk anywhere holds state this had to preserve, so the cheap branch is the right one.

**An inconsistent stream is CLEARED rather than repaired** — a gap in the ordinals, segments with no cursor, an unparseable segment, or a stream that does not reach back to the block a rebuild asks for. Nothing raises: the indexer takes its existing clear branch and re-fetches. A cursor with NO segments is not damage and is kept, because that is the ordinary state of a deployment whose contracts have not emitted anything yet.

**The stream keeper stores no `unconfirmedBlocks`**, in a segment or in the cursor record, and `fetchFrom` returns a `LastSync` whose window is `[]`. The window's two homes that are actually READ (the state keeper's saved cursor, and the entity path's serialized sync cursor) are unchanged.

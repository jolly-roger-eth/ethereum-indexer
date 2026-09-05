---
'@etherfold/server': minor
---

`GET /{indexer}/feed` serves the RETRACTION-AWARE view over the stored emission stream: `seq`-ordered, `removed` entries included, resumed from an opaque cursor the caller holds. The first of ADR-0006's two views.

This is the view for a consumer that WANTS to see reorgs (it acts optimistically on a log and cancels the pending action when the retraction arrives), so retractions are DELIVERED and `alive` is never consulted. Filtering on it, and a caller-supplied block gate, belong to the canonical view, which is the next task.

```
GET /alpha/feed?limit=100
{"success": true, "stream": "0x…", "entries": [{"removed": false, "blockNumber": 101, …}], "cursor": "<opaque>", "hasMore": true}
```

**The cursor is OPAQUE, and it is VALIDATED rather than trusted.** It is a server-encoded string, not data a client parses: the same call ADR-0027 makes for the sync cursor, one step further out, because an encoding a client can read becomes a contract that can never change, and here the audience is not even ours (a consumer is built outside etherfold, ADR-0005). It CARRIES the view, the indexer name, the stream and the position, and the first three are never used to route. The route already routed; those copies exist so a MISMATCH is refused:

- a cursor minted at indexer A and presented at B is `400 indexer-mismatch`, never re-interpreted. Two named indexers can hold byte-identical streams, so a position in one means nothing in the other. The refusal names the indexer the caller ADDRESSED and never the one its cursor was minted at.
- a cursor for the OTHER view is `400 view-mismatch`, because the two views count in different spaces.
- a cursor whose STREAM is no longer the one served is `400 stream-mismatch`, and it is the one refusal that ANSWERS: it carries the current stream's identity (`stream`) and a cursor at the position that stream's feed begins at (`startCursor`), so a consumer can re-subscribe deliberately. It is explicitly NOT a rewind: there is no fork block, because the logs a filter change produces were never on the old stream at all.
- anything else is `400 invalid-cursor`, which says nothing about WHY on purpose: telling an edited cursor from an invented one would tell a client about the encoding.

**Holes in `seq` are legal, and the read is built for them.** A page is `seq > <position> LIMIT n` and the next position is the `seq` of the last row actually served, never the previous one plus anything. Pair-compaction will create the holes later; this is what already has to be true when it does, and it is tested with page sizes smaller than the widest hole.

**No position is published anywhere.** Entries carry the raw log and the `removed` verdict and no `seq`, because publishing one is how a consumer ends up incrementing it.

`limit` defaults to 100 and is capped at 1000, and a larger one is REFUSED rather than silently reduced: a short page must always mean the stream is short.

The feed is a PUBLIC read and is deliberately not behind `INGEST_TOKEN`, which guards the fetcher's private write API. It does need the named-indexer registry, because validating a cursor's stream means knowing which stream is served and only the registered receiver knows that. So a host built with no registry answers `501` here exactly as it does on ingest, and `etherfold serve` does not serve the feed today.

New export: the `FeedEntry` type. The cursor codec is deliberately NOT exported; publishing a decoder would make the encoding a contract by the back door.

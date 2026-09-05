---
'@etherfold/server': minor
---

`GET /{indexer}/canonical` serves the CANONICAL view over the stored emission stream: live entries only, ordered by `(blockNumber, logIndex)`, at or below a block gate the CALLER supplies. The second of ADR-0006's two views, and the one for a consumer that never wants to hear the word reorg, so its entire sync state is one advancing position.

```
GET /alpha/canonical?gate=4200000&limit=100
{"success": true, "stream": "0x…", "entries": [{"blockNumber": 101, "blockHash": "0x…", "logIndex": 0, …}], "cursor": "<opaque>", "hasMore": true}
```

An entry here carries **no `removed` field at all** (new `CanonicalEntry` type, exported beside `FeedEntry`). A flag that is false on every entry a view can ever serve is an invitation to write `if (entry.removed)` handling that can never fire, which is exactly the reorg handling this view exists to remove.

**`gate` is REQUIRED and is never defaulted** (`400 invalid-gate` when absent or malformed). A consumer that only wants settled data passes a low gate and one that wants the tip passes a high one (ADR-0007's two lanes); how deep a consumer trusts the chain is the consumer's decision, and this system deliberately knows nothing else about a consumer (ADR-0005). Every candidate default is wrong for somebody and none of them says so.

**Because it hides reorgs, it owes the compensating guarantee.** The cursor carries the block HASH the consumer last saw and the server validates it on every request. A cursor whose block is no longer canonical is answered with a REWIND and never a page:

```
409 {"success": false, "error": "rewind-required", "stream": "0x…", "forkBlock": 103, "rewindCursor": "<opaque>", "message": "…"}
```

`forkBlock` is F, the lowest block the consumer must read again, and it is the one thing no cursor can say for it: it must also roll its own derived state back to before F. `rewindCursor` is a cursor at F meant to be PRESENTED next, and it is named to say so, unlike the stream mismatch's `startCursor`, which is a place to BEGIN a new subscription and a decision a human takes. Continuing from the consumer's own position instead would serve the new branch from `(blockNumber, logIndex)` onward and silently skip the replacement blocks BELOW it, which is exactly the events it never received. That is also why it is a non-2xx rather than a `200` carrying an instruction: a consumer that ignores a field it does not know would read that as "caught up".

It is a `409` and not a `400` deliberately. ADR-0004 already makes `409` the one RESUMABLE refusal in this system ("your position is not where mine is, carry on from here") and this is that same sentence spoken to a consumer; every other cursor refusal on this surface stays a `400`, because no amount of re-presenting the same cursor makes any of them right.

**One hash check is provably enough**, because a reorg invalidates a contiguous suffix: if the block at the cursor is still canonical then the whole prefix behind it is too. Nothing walks back over the window. The fork block is the lowest block the stream has retracted anything at SINCE the cursor was minted, so a second, deeper reorg moves the answer DOWN rather than stranding a consumer at the first fork.

**ONE cursor codec across both views.** The canonical view adds its block hash and its mark to the shared opaque envelope rather than minting a second encoding; two encoders would be two refusal paths that drift. The view is carried inside the envelope and validated, so presenting one view's cursor at the other is a `400 view-mismatch` and never a position read in the wrong space. `limit`, the `indexer-mismatch` / `stream-mismatch` / `invalid-cursor` refusals, the `501` / `404` registry answers and the public-read stance are all the feed's, unchanged.

New exports: the `CanonicalEntry` type. The cursor codec is still deliberately not exported.

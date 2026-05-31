---
'ethereum-indexer': patch
---

Several bug fixes in the core indexer:

- `getNewToBlockFromError`: only treat `-32602` errors as block-range hints when the message actually looks like one (avoids mis-parsing unrelated "invalid params" errors), and fix the `"block range too large"` detection that always evaluated truthy.
- `fetchLogsFromProvider`: deduplicate block/transaction extra-data fetches by hash instead of by block number, so every distinct block hash gets its timestamp (fixes missing `blockTimestamp` when two hashes share a block number, e.g. after a reorg in the unconfirmed window).
- `createAction`: forward falsy-but-valid arguments (`0`, `''`, `false`) to the executor instead of dropping them based on truthiness; and fix the `next()` (queue) path that fell through and executed the queued action twice / broke serialization.
- Log previously-swallowed listener and `tokenURI` fetch errors via `named-logs` instead of empty `catch {}`.

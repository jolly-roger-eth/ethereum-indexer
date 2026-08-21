---
'ethereum-indexer': minor
---

Read `blockTimestamp` off the log, and only fetch the blocks that are missing one.

`ethereum/execution-apis#639` (merged 2025-08-25) puts `blockTimestamp` on every log object, and geth (>= 1.16.0), reth, besu, erigon and anvil all serve it. The fetcher was dropping the field during decoding, so `alwaysFetchTimestamps` always paid for a second `eth_getBlockByHash` per block even when the timestamp had already arrived with the log.

`NumberifiedLog` now carries an optional `blockTimestamp`, populated from the log when the node provides it (hex QUANTITY or decimal, per `parseLogBlockTimestamp`; anything unreadable is treated as absent rather than coerced to 0). `alwaysFetchTimestamps` becomes a fallback: the block-fetch list is built only from the blocks whose logs carried no timestamp, so it costs nothing on a compliant node and behaves exactly as before on one that is not. Hardhat's EDR does not emit the field as of hardhat 3.14.0, which is why the fallback stays.

Verified end to end against a real anvil 1.5.1 (indexing three blocks of real events uses `eth_chainId`, `eth_blockNumber` and `eth_getLogs` only, with zero block fetches) and against a real Hardhat node (the fallback engages and timestamps are still correct). This matters most for the in-browser path ADR-0002 makes primary, where a provider frequently cannot batch those calls and each one is its own round-trip.

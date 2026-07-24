---
title: Use blockTimestamp now returned in logs instead of an extra fetch
slug: use-blocktimestamp-from-logs
---

## The opportunity

The core README documents a constraint: `eth_getLogs` does not return block timestamps, so obtaining them needs an extra `eth_getBlockByNumber`/`ByHash` round-trip (the `alwaysFetchTimestamps` path in the engine). That constraint is now **obsolete**: modern Ethereum clients include `blockTimestamp` directly in log results, and it was standardized into the execution-apis spec (reth, go-ethereum 1.16, then `ethereum/execution-apis#639`). See the research doc `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db/` (§ Timestamps).

## What to do

- Read `blockTimestamp` straight from each log when the connected node provides it, avoiding the extra block fetch; fall back to the current fetch path when it is absent (older nodes).
- Normalize on ingestion (one client returned it as decimal vs hex initially).
- Update the README caveat + the `alwaysFetchTimestamps` docs to reflect that timestamps are often available for free now.

## Why it matters

This is the drift recorded as a consequence in ADR 0002 (in-browser EIP-1193 indexing). Fewer round-trips is especially valuable in the browser (the primary target) and directly benefits the historical-state DB design, which keys a `_blocks.timestamp` column and wants the timestamp without a second call. Related to the `historical-state-database` spec.

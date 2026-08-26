---
title: Answer tx inclusion for a transaction that emitted no indexed event, by asking our own node
slug: tx-inclusion-for-a-tx-that-emitted-no-indexed-event
---

## The gap this closes

`checkTxInclusion` (`@etherfold/core`) answers "does the state I am about to render already account for this transaction", which is what an app needs before it lays an optimistic update over indexed state. It answers it out of `LastSync.unconfirmedBlocks`, which costs nothing extra because that window already holds whole blocks with their events, and every event carries its `transactionHash`.

That window is **sparse**: `generateStreamToAppend` keeps a block only when it carries events (`packages/core/src/internal/engine/utils.ts`, the `block.events.length > 0` guard). So a transaction that emitted no event this indexer indexes can never produce a `window-hit`, and is reported `absent`/`window-miss` for as long as it sits inside the window. It only resolves once it falls below `latestBlock - finality`, and even then only for a caller that passes `minedAtBlock`.

For the case the function exists to serve this is not a restriction: an app optimistically updates precisely because it expects the events its own processor handles, and etherfold's first consumer confirmed every optimistic transaction it sends is event-bearing. So this is written down, not built.

## What NOT to do about it

Making `unconfirmedBlocks` dense. It is the obvious move and it is the wrong one twice over:

- **It does not close the gap.** A dense window of block HASHES still holds no transaction hashes for a block whose logs we never fetched. Closing it needs the block's transaction list, which means `eth_getBlockByNumber(n, false)` per block.
- **It is priced per block, on the wrong axis.** The fetcher's whole pricing model is one `eth_getLogs` per RANGE; this would add one call per BLOCK, on every cycle, and one per block over the entire backlog during catch-up. Memory is the cheap part, though not free either: a dense transaction-hash set is hundreds to thousands of 32-byte hashes per block times the finality window, and it rides in `LastSync`, which is serialized through the cursor port on every write. And on this repo's own measured workload it would be roughly **429x the entries** for zero benefit, since that is the median block gap between event-bearing blocks on the real stratagems stream.

## What to do instead, when it is needed

**Ask our own node on a miss.** When a witness query misses the window, the indexer can call `eth_getTransactionReceipt(txHash)` against the RPC it is already connected to. That answers in the indexer's OWN chain view, which is the only view the question is about, and it is compared against the indexer's own cursor exactly as `minedAtBlock` already is. Cost is one RPC per miss, nothing on a hit, nothing at all when nobody asks. Storage stays zero.

The result would feed the existing `below-window` / `ahead-of-cursor` branches rather than adding a verdict: the receipt supplies the `minedAtBlock` the caller could not.

## What it would have to answer

- **It is a capability, not a guarantee.** The receiving half of the ADR-0004 split is deliberately chain-free, so a serverless indexer-server hosting a processor has no node to ask. It works in-browser (the provider is right there) and in a combined Node deployment. It should be DECLARED rather than stubbed to throw, on the same ground as every other backend difference in this repo.
- **It is a network call on a read path**, so it wants a bound (how many misses per request) and probably a short-lived cache keyed by transaction hash. A receipt is not immutable under reorg, so the cache must be short-lived or invalidated on a reorg, and never keyed as if the answer were final.
- **A miss on the node too is still ambiguous** between "not mined" and "mined and dropped from this node's view", which is what the caller wanted to know anyway, so `absent` is the right answer there.

## When it earns its turn

When a consumer appears that optimistically updates on a transaction whose effect on indexed state is real but whose own transaction emits nothing this indexer indexes. Until then the sparse window answers every case that exists.

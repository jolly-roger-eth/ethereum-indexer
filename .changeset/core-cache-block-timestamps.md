---
'@etherfold/core': patch
---

Cache fetched block timestamps, so the unconfirmed window is not re-fetched every round.

On a node that does not put `blockTimestamp` on the log, `alwaysFetchTimestamps` costs one `eth_getBlockByHash` per block. `getFromBlock` deliberately re-scans back to `latestBlock - finality` on every round to catch reorgs, so the same unconfirmed blocks were fetched again on every single round: indexing 3 blocks over 5 rounds against a Hardhat node cost 15 block fetches, and it now costs 3.

The cache is keyed by block **hash**, and that is what makes it safe rather than merely smaller: a hash uniquely determines a block, so a cached timestamp cannot become wrong and a reorged-out block's hash simply never appears again. Keying by height would answer a replaced block with the dead branch's timestamp, silently, across exactly the reorgs the re-scan window exists to detect.

It is bounded by the reorg window rather than by the length of the chain: entries below `latestBlock - finality` are evicted, since `getFromBlock` can never ask for them again, and that is also what evicts reorged-out hashes. A node that supplies timestamps on the log populates nothing at all.

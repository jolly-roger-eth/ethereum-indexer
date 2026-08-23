---
'@etherfold/core': patch
---

Distinguish the two ways a reorg is concluded, and report the dangerous one loudly. `generateStreamToAppend` now returns an optional `reorg: {cause, blockNumber, blockHash}` alongside the stream, where `cause` is either `contradiction` (the same height now carries a different hash, which is proof) or `absence` (a block we held is simply not in the re-fetched range, which is an inference).

The distinction matters because absence is indistinguishable from a sender that under-delivered the range: a truncated `eth_getLogs`, a wrong address or topic filter, a misconfigured chain. Both causes revert state, so an absence-driven revert is logged at `error` level with the range that produced it, while an ordinary hash contradiction stays at `info`. A rising rate of absence-driven reverts means truncation or misconfiguration rather than chain activity.

Purely additive: the returned object gains a field, and existing destructuring is unaffected.

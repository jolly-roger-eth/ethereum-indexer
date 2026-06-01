---
'ethereum-indexer-cli': patch
---

Make the CLI's indexing loop resilient and drop a redundant RPC call. The `run()` loop previously made a standalone `eth_blockNumber` request at startup (immediately made redundant by `indexMore()`, which re-fetches and returns the latest block) and had no retry — a single transient `indexMore()` error (e.g. an RPC blip) aborted the whole batch. The loop is now extracted into an exported, testable `indexToTip(indexer, opts?)` that discovers the tip via `indexMore()` alone and retries transient errors with a bounded number of attempts (default 5) before giving up. Termination contract is unchanged: it indexes up to the live chain tip (suitable for the snapshot-behind-finality use case).

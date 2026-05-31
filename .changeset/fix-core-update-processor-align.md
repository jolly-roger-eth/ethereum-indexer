---
'ethereum-indexer': patch
---

Align `EthereumIndexer.updateProcessor` with `updateIndexer`: it now calls `disableProcessing()` first (so a racing index/feed tick cannot interleave with the processor swap) and re-enables processing afterwards. The processor instance is now swapped only once a change has been decided, instead of being replaced before the version-hash check — so a no-op (same-version) update no longer replaces the running instance mid-flight.

When the new processor has the same version hash as the current one, the swap is skipped and a warning is logged (in case the developer changed the processor but forgot to bump its version hash). A new `updateProcessor(newProcessor, {force: true})` option swaps, clears, and reloads regardless of the version hash.

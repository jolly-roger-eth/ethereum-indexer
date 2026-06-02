---
'ethereum-indexer-server': patch
---

Rewrite `setupIndexing()` to use the new shared `resolveProcessorAndSource` helper from `ethereum-indexer-utils` instead of its own copy of the processor-module loading / contract-data / source-resolution logic (LOW-4 in the server/CLI batch audit). Behaviour is preserved: the server still owns its provider construction (including the `createProvider` seam) and its caching (`useCache` / `useFSCache`) and `EthereumIndexer` wiring, and still passes its `folder` as the processor factory argument (now expressed explicitly via the helper's `processorConfig` parameter).

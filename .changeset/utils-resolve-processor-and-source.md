---
'ethereum-indexer-utils': minor
---

Add a shared `resolveProcessorAndSource` helper (plus the smaller `loadProcessorModule`, `instantiateProcessor` and `resolveSource` building blocks) that turns a processor module path + options into `{processor, processorModule, source}`. This extracts the near-identical processor/source setup that was previously copy-pasted between the CLI's `init()` and the server's `setupIndexing()` (LOW-4 in the server/CLI batch audit), removing the divergence risk between the two copies.

Behaviour is the superset of the previous copies: module resolution keeps the server's `createRequire(...).resolve()` fallback for bare package specifiers (the CLI lacked it), and the processor-factory argument is now an explicit `processorConfig` parameter so the intentional CLI/server difference (CLI calls the factory with no args, the server passes its folder) is documented rather than accidental. The helpers are pure and unit-tested (module-resolution paths, the `contractsDataPerChain`/`contractsData` resolution, the provided-source path, and the no-factory / no-chainId / no-contracts error cases).

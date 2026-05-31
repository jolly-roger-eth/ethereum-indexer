---
'ethereum-indexer-browser': patch
---

Add an optional `createIndexer` factory to `createIndexerState` options. When provided it is used to construct the underlying `EthereumIndexer`, receiving the same arguments (request-tracked/logged provider, configured processor, source, config) that the default `new EthereumIndexer(...)` would. Useful for injecting a subclass, a shared instance, or a spy/fake (e.g. in tests). Defaults to the existing behaviour when omitted.

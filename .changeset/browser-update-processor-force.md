---
'ethereum-indexer-browser': patch
---

`updateProcessor` now accepts an optional `{force?: boolean}` argument that is forwarded to the core `EthereumIndexer.updateProcessor`, allowing a processor swap (clear + reload) even when the new processor has the same version hash as the current one.

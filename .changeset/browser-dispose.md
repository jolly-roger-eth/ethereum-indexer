---
'ethereum-indexer-browser': minor
---

Add a `dispose()` method to the object returned by `createIndexerState`. It stops the auto-index loop and clears any armed timer (previously the self-re-arming `setTimeout(_auto_index, ...)` would keep firing forever if the consumer dropped its references without calling `stopAutoIndexing()`), detaches the `onLoad`/`onLastSyncUpdated`/`onStateUpdated` callbacks (which closed over the stores), drops the underlying `EthereumIndexer` reference, and resets the syncing/status state. It is idempotent. After `dispose()`, `init(...)` may be called again to re-initialise — note this reuses the same stores and processor instance rather than performing a full fresh start.

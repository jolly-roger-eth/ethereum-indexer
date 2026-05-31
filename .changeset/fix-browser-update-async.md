---
'ethereum-indexer-browser': patch
---

Make the browser `updateIndexer` / `updateProcessor` `async` and await the underlying core call, returning a promise callers can await before re-indexing. Errors from the core reconfiguration are now routed into `$syncing.error` (`FAILED_TO_UPDATE_INDEXER` / `FAILED_TO_UPDATE_PROCESSOR`) and re-thrown, instead of surfacing as an unhandled promise rejection.

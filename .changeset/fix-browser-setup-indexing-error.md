---
'ethereum-indexer-browser': patch
---

Fix `setupIndexing` reporting a `FAILED_TO_LOAD` error on every call. The error was set in a `finally` block, so it ran even when loading succeeded. Use a `catch` (re-throwing the error) so the error flag is only set on an actual failure.

---
'ethereum-indexer-browser': patch
---

Pause auto-indexing during `updateIndexer` / `updateProcessor` and resume it afterwards. Previously the auto-index timer kept firing while the core was mid-reinit, so a tick could call `indexMore` against a blocked/half-reconfigured indexer (throwing `Blocked` → retry → re-arm, racing the reconfigure). Now the loop is stopped before the awaited core call and resumed (even if the reconfigure fails) once it settles. On success, stale syncing state is cleared before the loop resumes so it does not early-return on the old `lastSync`.

---
'ethereum-indexer-browser': patch
---

Clear stale `$syncing.lastSync` after a successful `updateIndexer` / `updateProcessor`. Previously `setupIndexing()` would early-return on the leftover `lastSync` from the old configuration, so after a live reload (new contracts / event ABIs / processor) progress was computed against the old start block and setup did not re-run. State is only cleared on success — a failed reconfigure keeps the previous valid progress and surfaces `$syncing.error`. Status is left untouched and corrects itself on the next indexing operation.

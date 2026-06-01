---
'ethereum-indexer-server': patch
---

Make the server's indexing more robust and observable:

- **Exponential backoff on auto-index errors.** The auto-index loop previously retried every 1s forever on failure and logged at `info`. It now backs off exponentially (1s → 2s → 4s … capped at 60s), resets on success, and logs at `error`.
- **Surface the last error in the `/` status.** A failing/stuck server reported `indexing: true` with no indication of trouble. The `/` response now includes a `lastError` (`{message, at}`) so operators can see the loop is failing.
- **Serialize all indexing entrypoints.** The auto-index loop, manual `/indexMore`, `/feed` and `/replay` now go through a single in-flight guard, so two indexing operations never run concurrently on the same indexer instance (previously two concurrent `/indexMore` calls could race, and `/feed`/`/replay` were not guarded against an in-flight manual `/indexMore`).

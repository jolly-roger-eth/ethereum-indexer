---
'ethereum-indexer-cli': patch
---

Add a versioned envelope to the snapshot state file and stop silently swallowing corrupt snapshots. The state file is now written as `{format, processor, savedAt, lastSync, state, history}` (the `processor` is the processor version hash from the lastSync context, `savedAt` is an ISO timestamp). This is backward-compatible: reads accept both the new enveloped form and the legacy bare `{lastSync, state, history}` form, and `state`/`lastSync`/`history` remain at the top level so existing consumers keep working. On read, a missing file is still treated as a normal first run, but a file that exists yet cannot be read or parsed (e.g. truncated by an old non-atomic write, or a bad commit) is now logged via `named-logs` instead of being silently treated as "no snapshot".

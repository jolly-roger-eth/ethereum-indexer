---
'ethereum-indexer-cli': patch
---

Write the snapshot state file atomically. Previously `keepState.save` wrote the `state` and `lastSync` files in place via `fs.writeFileSync` on every `indexMore()`, so a process killed mid-write (CI timeout, OOM, Ctrl-C) could leave a truncated, invalid-JSON snapshot on disk — which a CI snapshot pipeline could then commit and publish. The save now writes each file to a temp file in the same directory, fsyncs, and renames it over the destination (atomic on POSIX same-filesystem), cleaning up the temp file on failure. An interrupted save now leaves the previous valid snapshot intact.

Internally, the file-backed `keepState` implementation was extracted from `init()` into an exported `createFileKeepState(folder)` (behaviour-preserving) so it can be unit-tested.

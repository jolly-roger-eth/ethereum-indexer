---
'ethereum-indexer-browser': patch
---

Serialize reconfiguration so overlapping `updateIndexer` / `updateProcessor` calls no longer interleave. Source changes (new contracts / event ABIs) and processor changes (new handler logic) are independent events that can arrive close together and in either order (e.g. a slow deploy's source change racing a processor edit). Previously each call ran its own reset/reinit/load asynchronously, so two overlapping calls could interleave on the same indexer instance. They now run through an internal queue — each reconfigure runs only after the previous one has fully settled (success or failure), preserving arrival order — while remaining independently usable. The pause/resume of auto-indexing and the clear-on-success of stale syncing state happen inside the serialized section.

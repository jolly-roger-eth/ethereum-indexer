---
'@etherfold/core': patch
---

A cancellation arriving while the processor is applying a batch no longer makes the next cycle deliver the same events twice.

`unlessCancelled(p)` rejects the CALLER; it cannot stop `p`, and it only throws once `p` has RESOLVED. So when a cancellation fired during `process`, the batch had already been applied and persisted, state and cursor together in one transaction (ADR-0027), and the engine threw before its in-memory cursor moved. The next cycle re-derived the same range and handed the same events over again: on a store that refuses a re-applied block that is a wedge no number of cycles clears, and on one that accepts it, a silent double-apply.

This is the ordinary path rather than an exotic one: every reconfigure verb calls `disableProcessing()` first, and the cancellation lands in exactly this window.

The completed batch is now recorded before the cancellation is honoured, in both the `indexMore` path and the `feed`/`replay` batch loop, so the in-memory cursor agrees with what is on disk.

**Why the work is kept rather than reverted.** Reverting would be the intuitive fix and is not available: `process` is the processor's own transaction, its write is already durable, and the `EventProcessor` interface has no per-batch undo, only `reset`/`clear`, which discard everything. Keeping a completed batch and recording it is both the smaller change and the one that leaves the two halves consistent.

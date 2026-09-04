---
'@etherfold/core': patch
'@etherfold/processor-entities': patch
---

Fixed silent, permanent event loss when a `feed`/`replay` batch loop is interrupted: every intermediate cursor is now true on its own.

`promiseToFeed` hands the processor one batch at a time, and the processor PERSISTS the cursor it is given (`applyEventStream` writes it verbatim for the batch's last block). Those cursors were built by copying the FINAL cursor and walking `lastToBlock` forward, so every intermediate batch carried the final unconfirmed WINDOW: a cursor claiming to have synced through block X while listing blocks above X as already folded.

That is unresumable. The engine treats the top of the window as the boundary above which events are new, so a run resuming from such a cursor skips every block between `lastToBlock` and the top of the window: they are neither below the resume point nor above the window, and nothing ever delivers them again. The loss is bounded by the finality window, permanent, and completely silent.

The same defect handed a RETRACTION-ONLY batch the extent of the whole scan. A batch that reverts blocks 101 to 103 and applies nothing was told `lastToBlock: 103` while the fold was back at 100, with the replacement blocks still queued behind it. A crash between the revert and the re-apply left state reverted and a cursor claiming completeness, so the resumed run applied nothing and the replacement branch was lost outright.

Both are reachable on the ordinary path, not only on a crash: every reconfigure verb calls `disableProcessing()` first, and a cancellation lands in exactly this loop.

Now each batch is handed a cursor narrowed to what IT has folded, and only the LAST batch gets the stream's own cursor, at which point the whole stream is folded and the claim is true. A retraction-only batch reports the fork point, which is a genuine move backwards and the correct one: the state really is back there until the replacements land. A retraction-only batch that is the last one still takes the stream's cursor, so a scan that legitimately found nothing continues to advance.

The narrowing rule now exists ONCE, as `cursorSyncedThrough`, newly exported from `@etherfold/core`. `@etherfold/processor-entities` re-exports it as `syncedThrough`, the name its callers already use: the engine narrows per batch and the processor narrows per block, and two copies of a rule this subtle is how the two halves drift apart.

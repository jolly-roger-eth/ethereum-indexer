# A replayed reorged stream applies the replacement block TWICE

2026-09-02, noticed while building `the-stream-appends-in-segments-on-indexeddb`.

Index branch A to its tip with a stream keeper, serve branch B (a reorg at 104), index again: the live state applies `0xb104:0` once. Discard the state and reload against the same stored stream, and the rebuild applies it TWICE — the replay feeds the retractions and the replacement, and the following tip cycle re-reads the finality window and applies `0xb104:0` again rather than recognising it as already in the window. Reproduced independently of this task's keeper: a hand-rolled whole-blob `ExistingStream` that stores the full `lastSync` including `unconfirmedBlocks` (the SHIPPED shape) behaves identically, so it is engine-side and pre-dates the segmented keeper. Nothing in `packages/browser/test/` asserts a reorged replay's rebuilt state against the live one today, which is why it is green.

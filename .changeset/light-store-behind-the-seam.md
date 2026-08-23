---
'@etherfold/state-store-patch': minor
'@etherfold/processor-entities': patch
---

The light state store, behind the same seam: `@etherfold/state-store-patch`.

**A new package.** Current state as a plain object, history as immer reverse patches, reorg revert by replaying them backwards. It is the cheapest legitimate implementation of the storage seam, so a browser tab that only needs current state and reorg safety pays nothing for versioned rows while running the SAME processor as the server:

```ts
const store = new PatchStateStore(processor.entities, {retention: 'revert-only', finalityDepth: 64});
await applyEventStream(store, processor, eventStream, config); // the same processor as on SQLite
```

`packages/processor-entities/test/patch-backend.test.ts` asserts that equality against `@etherfold/state-store-sqlite` on the same input, and the store passes `@etherfold/state-store-conformance` under its own claim.

**It advertises `revert-only`, and that is a MEASURED result rather than a limitation.** Backwards replay is correct wherever the patches exist (matched the recorded state at every depth to 64 on Chromium, Firefox, WebKit and node, at a cost linear in depth). What withdraws the capability is SPARSITY: history is pruned by BLOCK-NUMBER distance from the tip, while a real stream carries only event-bearing blocks, which on the launched stratagems game on Base are median **429 blocks apart**. At a finality of 64 exactly one block's reversals survive, the tip's, and no tuning returns it. So `revertTo` works and is the reason this backend exists, while every as-of read throws `BlockNotRetainedError` at every depth — never the tip value, which is the single failure mode this design exists to prevent because it is plausible. Asking this store for a window is refused where it is configured rather than downgraded quietly.

**A revert it cannot perform is an error, not a partial revert.** Once a block's reverse patches have been pruned, `revertTo` throws `RevertBeyondPatchHistoryError` (naming the blocks it cannot undo, the deepest revert still available and the declared depth) and leaves the state untouched, because a half-undone reorg is the write-path twin of a historical read served from the tip. `store.retainedReversals()` reports the depth still available — on a sparse stream, one block.

**Memory-only, and the capability report says so** (`durability: 'memory-only'`): a reload is an empty store. Persisting is deliberately left to the seams that own it — the whole-state `KeepState` path above, and the row-level IndexedDB backend beside. See ADR-0023.

`prune()` drops the reverse patches at or below `tip - finalityDepth` and is a call the host schedules (ADR-0022), never a side effect of a write, which is the deliberate difference from `@etherfold/js-processor`'s `History`.

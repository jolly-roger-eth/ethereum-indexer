# @etherfold/state-store-patch

## 0.1.0

### Minor Changes

- c359dcb: The light state store, behind the same seam: `@etherfold/state-store-patch`.

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

- 5854d60: **The storage seam gains a sync-cursor port, and `applyBlock` can write the cursor with the block** (ADR-0027).

  `StateStore` gains `readCursor(key)` / `writeCursor(key, value)` / `clearCursor(key)` over an **opaque string**, and `applyBlock(block, mutations, cursor?)` takes an optional `{key, value}` that is written in the SAME transaction as the block. This reverses an explicit "deliberately absent" on the interface: a cursor that could only be a SQL table stopped one-processor-several-backends at the first deployment that was not SQLite, and only the store holds the transaction the block write happens in, so only the store can stop a crash from leaving state ahead of the cursor.

  It stays a STRING and never a typed `LastSync`: that is a `@etherfold/core` type, and typing the port with it would make this package depend on core, invert ADR-0016 and drag viem into every storage primitive. `@etherfold/state-store` still declares no dependencies at all.

  Per backend:
  - **`@etherfold/state-store-sqlite`**: a new fixed `_cursor (key, value)` table, created by `migrate()` alongside `_blocks`, and the cursor statement rides in the same `batch([...])` as the block. `CURSOR_TABLE`, `readCursorStatement`, `writeCursorStatement` and `clearCursorStatement` are exported like the rest of the SQL.
  - **`@etherfold/state-store-indexeddb`**: a new `cursors` object store, written inside the block's own transaction. The package's schema version moved from 1 to 2; the upgrade is additive and `contains`-guarded, so an existing database gains the store and keeps every row. A processor declaring another entity is still not a migration.
  - **`@etherfold/state-store-patch`**: an in-memory map, written after the point where anything can still refuse. Its `durability: 'memory-only'` already says what that means for the cursor: it goes with the process, exactly as the state does.
  - **`MemoryStateStore`**: the same, as the executable definition.

  `@etherfold/state-store-conformance` gains a `the sync cursor` group: the round trip, the clear, the opacity of the value, and the one that matters — a store never reports a cursor ahead of its last applied block, asserted through a refused block and through a re-applied height. The suite's own tests gain a backend that writes the cursor before the block, so the new group is proven to catch it.

  A cursor is deliberately NOT reverted by `revertTo` and not touched by `prune`: how far the caller got is not entity state.

### Patch Changes

- Updated dependencies [ff393f7]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [b61de79]
- Updated dependencies [2a4e6ed]
- Updated dependencies [879c4fe]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
  - @etherfold/state-store@0.1.0

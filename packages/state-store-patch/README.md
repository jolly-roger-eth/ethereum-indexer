# @etherfold/state-store-patch

The **light** state store: current state as a plain object, history as [immer](https://immerjs.github.io/immer/) **reverse patches**, reorg revert by replaying those patches backwards. It is the cheapest legitimate implementation of the storage seam, so a browser tab that only needs current state and reorg safety pays nothing for versioned rows, while running the **same processor** as the server.

```ts
import {PatchStateStore} from '@etherfold/state-store-patch';

const store = new PatchStateStore(processor.entities, {retention: 'revert-only', finalityDepth: 64});
await store.migrate();

// the same processor that runs on @etherfold/state-store-sqlite
await applyEventStream(store, processor, eventStream, config);

await store.getCurrent('token', {id: '1'}); // answered
await store.revertTo(1_429); // a reorg forked there: undone by backwards replay
await store.getAsOf('token', {id: '1'}, 1_429); // throws BlockNotRetainedError. Never the tip value.
```

## It advertises `revert-only`, and that is a measured result

Not a limitation to apologise for, and not a cost problem.

Backwards replay is **correct wherever the patches exist**: `work/notes/findings/sqlite-in-the-browser.md` replayed a dense stream backwards and matched the recorded state at every depth to 64, on Chromium, Firefox, WebKit and node, at a cost linear in depth (126 ms at depth 64 on a laptop, so roughly half a second on a mid-range device profile).

What removes the capability is **sparsity**. History is pruned by BLOCK-NUMBER distance from the tip (`tip - finalityDepth`, the one comparison every backend in this repo prunes on), while a real stream carries only event-bearing blocks, which on the launched stratagems game on Base are median **429 blocks apart** (max 1,226,194). At a finality of 64, exactly ONE block's reversals survive: the tip's. So on a real sparse contract there is nothing left to replay for a historical read, and no tuning returns it.

Concretely:

- **`revertTo` works, and it is the reason this backend exists.** A reorg only ever touches blocks within the finality depth of the tip BY NUMBER, which is exactly what the pruning keys on.
- **Every as-of read is a typed refusal.** `getAsOf` and `listAsOf` throw `BlockNotRetainedError` (`reason: 'no-historical-reads'`) at every depth, including the tip's own block number. They read nothing at all, which is asserted structurally as well as behaviourally in `test/historical-reads.test.ts`: answering a historical read from the tip is the single failure mode this design exists to prevent, and it is worse than an error because it is plausible.
- **The report says `revert-only`, never a window**, and asking this store for one is refused where it is configured rather than downgraded quietly.

The patch log's SIZE follows the same fact: 1,702 KB (223% of the state) on a dense synthetic stream, 4.4 KB (1% of the state) on the real one, because almost everything is pruned immediately.

## A revert it cannot perform is an error

Once a block's reverse patches have been pruned, that block cannot be undone. `revertTo` checks the whole range **before** it replays anything and throws `RevertBeyondPatchHistoryError` (naming the blocks it cannot undo, the deepest revert still available, and the declared depth) leaving the store untouched.

It does not revert as far as it can. A partly-undone reorg is the same class of answer as a historical read served from the tip: plausible, and indistinguishable downstream from a correct one, while carrying exactly the counter a reorged-out block raised. A host that sees this error re-indexes the affected range (or re-hydrates from a snapshot). See ADR-0023.

`store.retainedReversals()` reports the blocks that can still be undone, so a host can see the real depth — which on a sparse stream is one block, whatever the setting says — before it needs it.

## Memory-only

State and patches both live in the process and go with it. **A reload is an empty store**, and `capabilities.durability` says `memory-only` so a caller learns that at startup rather than from a blank tab.

That is a decision, not an omission. Serialising the whole state on every save is the incumbent `keepStateOnIndexedDB` strategy, which belongs to the `KeepState` seam ABOVE this one (and is measured as the fastest writer at today's sizes precisely because it does no history at all); row-level persistence with its own bounded cold start is `indexeddb-row-backend-browser-default`'s job. Choosing either here would fork a persistence strategy inside a store whose whole claim is that it is the cheap one. Hosts that need state to survive a reload should use a persisted backend or hydrate from a snapshot; hosts that re-index from a cached stream on load are what this store is for. Again ADR-0023.

## Retention and pruning

`retention` is accepted only as `'revert-only'`, which is what this store is; a window or `unbounded` throws at construction, naming why.

`finalityDepth` is the whole of the retention and therefore the prune floor: `store.prune()` drops the reverse patches of blocks at or below `tip - finalityDepth` and reports `{tip, floor, versionsDeleted, complete}`, where the unit counted is one BLOCK's reversals (this backend's unit of history). Declaring no depth states no floor, so nothing is pruned and the patch log grows with the stream — fine for a test, not what a long-running tab wants.

Pruning is an explicit call the host schedules and never a side effect of a write (ADR-0022), which is a deliberate difference from `@etherfold/js-processor`'s `History`, where the same block-distance pruning happens inside `setBlock`.

Two things pruning here does NOT touch:

- **The current state.** A row is a row, not a version, so dropping history cannot drop the state — the trap a versioned backend has to write an explicit predicate to avoid (a row written once at block 12,082,307 and never revisited is still the current state).
- **The block records.** They are what makes re-applying a height raise and what a revert measures against, they are three fields each, and dropping them would trade a correctness property for nothing.

## One implementation of the seam

This is a `StateStore` ([`@etherfold/state-store`](../state-store)): `migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `listCurrent` / `listAsOf` / `revertTo` / `prune`, plus the capabilities it declares. A processor written against `@etherfold/processor-entities` hands this store exactly what it would hand any other backend, and `packages/processor-entities/test/patch-backend.test.ts` asserts that one processor produces identical state here and on `@etherfold/state-store-sqlite`.

The bounded id-prefix listing is a **sorted walk** over the entity's own bucket here, rather than an indexed range scan — the answer is what the seam specifies (ascending in the declared id's order, bounded by the required limit, `truncated` reported as a fact), and the access path is this backend's own business.

What it is **not**:

- Not `MemoryStateStore`, which keeps versioned rows in a Map and can therefore answer as-of reads. That one is the executable definition of the seam; this one is the cheap deployment.
- Not the incumbent light path (`@etherfold/js-processor` plus `keepStateOnIndexedDB`), which has no concept of history at the storage layer and would answer a historical read from the tip. The free-form-object ergonomics are kept; the free-form-object blind spot is not.

## Tests

`pnpm --filter @etherfold/state-store-patch test`, vitest.

`test/conformance.test.ts` runs the shared suite, [`@etherfold/state-store-conformance`](../state-store-conformance), which reads this store's claim and tests it against exactly that. What stays in this package's own tests is what only this backend can be asked: the SPARSE stream at the measured 429-block median (where a dense conformance ladder would make this store look like a time machine), the pruned patch log, the refusals, and the guarantee that the as-of methods touch no state at all.

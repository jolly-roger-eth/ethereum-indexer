# Reorg revert via immer reverse-patches (not stream replay)

The live in-browser processor (`JSObjectEventProcessor` + `History`) handles reorgs by keeping per-block immer **reverse-patches** within the finality window and undoing them on a `removed` event, rather than replaying the event stream to rebuild state. We chose this because replay requires a copy of the state **as of the replay start block** (or a way to query it), which the current in-memory/in-browser path does not have; reverse-patches revert without needing that snapshot.

## Considered Options

- **Immer reverse-patches (chosen)** — revert is bounded to the finality window, needs no historical snapshot, cheap in-browser. Cost: per-block patch history must be maintained; the mechanism is stateful and non-obvious.
- **Stream replay from a checkpoint** — conceptually simpler, but needs a state snapshot at the checkpoint (or an as-of-block query) that the in-browser path lacks.

## Consequences

- **Revisit condition (load-bearing for the `historical-state-database` spec):** once the historical-state DB can query state as of a block height, replay becomes possible and may be preferable; alternatively, an immer-like reverse-patch mechanism could be extended to the DB case and the same approach continued. Decide this deliberately when designing that store — do not assume replay.
- The exact revert-and-reapply contract this ADR describes is pinned by `packages/ethereum-indexer-js-processor/test/reorg.test.ts` and `packages/ethereum-indexer/test/utils.test.ts` (`generateStreamToAppend`). Any DB-layer `revertTo(N)` must reproduce it.

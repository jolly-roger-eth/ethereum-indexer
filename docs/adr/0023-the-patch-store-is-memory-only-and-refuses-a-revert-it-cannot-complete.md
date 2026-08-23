# The patch store is memory-only, and a revert it cannot complete is an error

`@etherfold/state-store-patch` keeps the current state as a plain object and its history as immer reverse patches, and it persists **neither**: a reload is an empty store, reported as `capabilities.durability: 'memory-only'`. When a reorg reaches below the patches it still holds, `revertTo` throws `RevertBeyondPatchHistoryError` and leaves the state untouched, rather than reversing as far as it can. Both are refusals to produce something plausible, which is the same rule that makes every as-of read on this backend an error instead of a tip read (ADR-0019).

## Why memory-only

Persisting this store would mean picking one of two strategies that already have owners, and forking it inside the backend whose entire claim is that it is the cheap one.

Serialising the state on every save is the incumbent `keepStateOnIndexedDB`, which sits on the `KeepState` seam ABOVE storage. It is measured as the fastest writer at today's sizes (2.0 ms/block on Chromium, against IndexedDB rows at 45.6 and wasm SQLite at 74.2 in `work/notes/findings/sqlite-in-the-browser.md`) precisely because it does no history at all, and its cost is O(total state) per write. Row-level persistence, with a bounded cold start and a write cost proportional to what changed, is `indexeddb-row-backend-browser-default`'s job and is a different backend, not a mode of this one. Building either here would put a second persistence strategy in the tree, maintained by nobody, and would make this store's numbers a mixture of two designs.

The honest deployment shape is therefore: this store is for a tab that re-indexes from a cached stream (or hydrates from a snapshot) on load and wants reorg safety while it runs. That is a real cost and it is named at the capability, not in a footnote, because "the state is gone after a refresh" discovered from a blank tab is the same category of surprise as a historical read discovered to be wrong.

The report carries `durability` as this backend's OWN field rather than as a new field on `StateStoreCapabilities`. Every other backend answers the question by existing on disk, so adding it to the shared contract would make every implementation fill in a constant for one implementation's benefit; putting it on the report a caller already reads at startup is what makes it discoverable at all.

## Why a revert that cannot complete is an error

The alternative is to replay the patches that remain, land somewhere between the two branches, and report how far it got. That produces a state that is half one branch and half the other while looking exactly like a normal state, and it keeps the counter a reorged-out block raised, which is the canonical bug this whole design exists to make impossible. It is the write-path twin of answering an as-of read from the tip: plausible, and indistinguishable downstream from a correct one.

So the range is checked in full before anything is replayed, the failure is atomic, and the error names the blocks that cannot be undone, the deepest revert still available, and the declared finality depth. A host's answer is to re-index the affected range.

This is not an exotic path on a sparse contract, and the arithmetic is the same one that makes the backend `revert-only`: history is pruned by BLOCK-NUMBER distance from the tip while a real stream carries only event-bearing blocks, median **429 apart** on the launched stratagems game, so a declared depth of 64 typically keeps one block's reversals. A reorg deeper than the declared finality depth is by definition outside what the deployment said it protects against, so refusing it is reporting a broken assumption rather than inventing a new limitation.

It is deliberately not a `BlockUnavailableError`. That family is about a READ this store cannot answer, where the store is unchanged and the caller can carry on with the tip; here the caller cannot carry on at all, and a `catch` written for a refused history query must not swallow it.

## Consequences

- **A host wiring this backend must have a re-index path**, and `RevertBeyondPatchHistoryError` is the trigger for it. `store.retainedReversals()` exposes the blocks that can still be undone, so the depth can be inspected before it is needed — on a sparse stream it is one block, whatever the setting says.
- **A deployment that wants in-tab history cannot get it from this backend by tuning.** The parked alternative is measured and recorded in the finding: immer's produced states share structure, so KEEPING the last K states costs roughly 6 MB for a 64-state window (52 MB for this game's entire history) and turns an as-of read into an O(1) lookup. Its honest capability would be "as-of within the last K updates, in memory, reset on reload", which is a different claim in a different unit, and it stays parked until a consumer needs it.
- **Pruning is the host's call here as it is everywhere** (ADR-0022), which is a deliberate difference from `@etherfold/js-processor`'s `History`, where the same block-distance pruning is a side effect of `setBlock`. A host that never prunes keeps every reversal and can revert to genesis; that is a legitimate configuration for a short-lived tab and an unbounded one for a long-lived indexer.

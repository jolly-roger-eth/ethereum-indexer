---
title: '`EthereumIndexer` could be a wiring of the two ADR-0003 halves, leaving one engine'
slug: the-indexer-could-be-a-wiring-of-the-two-halves
---

There are TWO combined pipelines in this tree, not one, and only one of them was designed as a composition.

`EthereumIndexer` (`@etherfold/core`) fetches and processes in one object. It is what a browser tab runs and what `etherfold index` runs today. `LogFetcher` + `createDirectIngestion` + `StreamBuilder` is the same job assembled from the ADR-0003 halves with the transport taken out: the fetcher pushes, the stream-builder receives, and the wire between them is an interface rather than HTTP. Both fold logs into a processor; neither is a special case of the other; they share only `generateStreamToAppend` underneath.

**The idea is that the first becomes a thin wiring of the second**, plus the layer that is genuinely browser-only. Then there is ONE engine, and the browser is a host for it rather than a second implementation of it.

## Why it is worth doing, beyond tidiness

**Equivalence tests stop comparing two implementations.** `one-command-runs-the-whole-pipeline` asserts that `run` and `fetch` + `index` produce identical state, and the assertion is only meaningful because the transport is supposed to be the only difference between them. Any deployment that folds through a different engine turns that into a comparison of two things that happen to agree today, where a later divergence surfaces as a mysteriously red equivalence test rather than as a bug in one place.

**The browser inherits operational machinery it does not have.** The fetch cycle carries announced AND silent truncation detection (`suspectResultCount`; the silent case is the one that produced the state-deleting bug in `d24872f`), the `expectedFromBlock` correction protocol, bounded backoff, and the classification of a cycle into `progress` / `idle` / `contended` / `retry` / `fatal`. `EthereumIndexer`'s own loop has none of that.

**It upgrades a claim the project makes.** Story 2 of `one-command-runs-the-whole-pipeline` is "the processor object I run in a browser tab runs under `run` unchanged". If the wiring lands, that becomes "the same processor AND the same engine", which is a materially stronger thing to be able to say.

## What `EthereumIndexer` has that the two components do not

The honest inventory, because this is what the work actually is. None of it is an obstacle in principle; all of it has to go somewhere.

- **The kept-stream cache and its re-decode.** `fetchFrom`, then `reparse` against the ABI running now, then `feed`. `StreamBuilder` has no equivalent, and this is the machinery behind the invalidation behaviour (a renamed non-indexed parameter keeps the stream and discards the state).
- **Reconfigure**: `updateIndexer`, `updateProcessor`, `reset`, and their `stateDiscarded` outcomes.
- **The cancellable-operation machinery and the observable hooks** (`onStateUpdated`, `onLastSyncUpdated`, `onLoad`) that `IndexerState.ts` and the store layer above it are built on.
- **The genesis-hash check and chain-changed handling.**
- **`feed`'s retraction batching and `feedBatchSize`**: every retraction of one reorg is deliberately delivered in a single `process` call.

## The one real semantic difference to decide

`EthereumIndexer` holds `lastSync` in memory. `StreamBuilder` deliberately re-reads the persisted cursor on every call, because "an in-memory cursor is one serverless isolate's private opinion of a value the database owns". A browser wiring has to choose, and the answer is not obviously the server's: a tab is not an isolate, and the in-memory cursor is what the reactive layer and `checkTxInclusion` read on the hot path. Deciding this is most of the design work; the rest is moving code.

## Why an idea and not a task

It touches `@etherfold/browser`'s main class and the whole surface above it, and nothing currently planned needs it. Importantly, the decision already made elsewhere is forward-compatible with it in one direction only: `one-command-runs-the-whole-pipeline` puts `run` and `build` on `StreamBuilder`, and `index-to-a-store-from-the-cli` was rewritten onto the same halves, so if this lands the browser CONVERGES onto the engine the rest of the system already uses and nothing has to be undone. Had the CLI been left on `EthereumIndexer`, this refactor would have had to unpick that first. So the cost of waiting is low and the cost of having chosen the other way would have been real.

**The trigger to revisit**: when the CLI rewrite lands and the browser is the LAST consumer of `EthereumIndexer` as an engine, or the first time a bug has to be fixed twice because the two pipelines drifted.

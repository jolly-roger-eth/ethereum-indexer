# Findings: ethereum-indexer-browser review

**Reviewed:**
- `packages/ethereum-indexer-browser/src/IndexerState.ts` (~418 LOC) — the main observable/state layer
- `packages/ethereum-indexer-browser/src/storage/state/OnIndexedDB.ts` (~172 LOC) — `keepStateOnIndexedDB`
- skimmed: `utils/stores.ts`, `storage/state/OnLocalStorage.ts`, `storage/stream/OnIndexedDB.ts`, `index.ts`

**Status:** working and clearly the most-used package (the README example is built on it), but has at
least one real bug and several robustness gaps. No tests.

## How it works

`createIndexerState(processor, options)` builds three observable stores — `state` (processor output),
`syncing` (progress/flags), `status` (state-machine label) — wraps the core `EthereumIndexer`, and
exposes `init`, `indexMore`, `indexMoreAndCatchupIfNeeded`, `indexToLatest`, `startAutoIndexing`,
`stopAutoIndexing`, `reset`, `updateProcessor`, `updateIndexer`, and `.withHooks(react)` to expose the
stores as hooks. `init` optionally wraps the provider in a `Proxy` to count/log requests. The indexer's
`onLoad`/`onLastSyncUpdated`/`onStateUpdated` callbacks drive the stores.

## Bugs / correctness risks found

1. **`setupIndexing()` always sets a `Failed to load` error via a `finally` block — even on success.**
   ```ts
   try {
       const lastSync = await indexer.load();
       setSyncing({loading: false});
       return lastSync;
   } finally {
       setSyncing({loading: false, error: {message: 'Failed to load', id: 'FAILED_TO_LOAD'}});
   }
   ```
   The `finally` runs on **every** call, so after a *successful* load the syncing store still gets an
   `error: FAILED_TO_LOAD`. This is almost certainly meant to be a `catch`. **Highest-priority bug** —
   it means consumers reading `$syncing.error` see a failure even when indexing is fine. (Easy to test:
   call the exposed flow with a stub indexer whose `load()` resolves, assert `$syncing.error` is unset.)

2. **`init` throws hard on re-init (`already initialised`).** The "prevent re-initialization" commit
   added this guard. It's safe but unforgiving: there's no supported way to re-init after a teardown
   (e.g. SPA route change / new account) except `updateIndexer`. Worth confirming the intended
   lifecycle — a `dispose()`/re-init path may be missing.

3. **`indexToLatest` recursion on error can stack/duplicate loops.** On the first `indexMore` error it
   schedules `indexToLatest()` again via `setTimeout` and `await`s it, then *also* falls into the
   `while` loop. Combined with `_auto_index` (which calls `indexMoreAndCatchupIfNeeded` →
   `indexToLatest`) there are multiple overlapping retry paths. Risk of overlapping index loops if
   callbacks interleave; the core indexer guards against concurrent `indexMore`, but the browser layer
   can still spawn redundant timers.

4. **`stopAutoIndexing` doesn't cancel an in-flight `_auto_index`.** It clears `indexingTimeout` and
   sets `autoIndexing:false`, but if `_auto_index` is mid-`await indexMoreAndCatchupIfNeeded()`, that
   call completes and schedules the next timer (the function doesn't re-check `$syncing.autoIndexing`
   before `setTimeout`). So stopping during an active index can re-arm the loop. Needs an
   `if (!$syncing.autoIndexing) return;` guard before re-scheduling.

5. **Division by zero / NaN in `setLastSync` progress math.** `syncPercentage` divides by
   `totalToProcess = latestBlock - startingBlock` and `totalPercentage` by `latestBlock`. Before the
   first sync `latestBlock` can be 0 → `NaN`/`Infinity` percentages pushed into the store. Guard for
   zero.

6. **`console.log`/`console.error` used directly** in the request-logging Proxy and in
   `OnIndexedDB.ts` (many). For a browser package some console use is acceptable, but the package
   already imports `named-logs` (`namedLogger`) elsewhere — inconsistent. The request *logging* path
   is opt-in (`logRequests`), so lower priority.

7. **`OnIndexedDB.fetch` swallows all remote-fetch errors with `console.error` and continues.** That's
   intentional (remote state is best-effort, fall back to local), but multi-remote failure handling
   ("TODO more than 2") is incomplete and the fallback logic is intricate and untested.

8. **`bnReviver` heuristic is fragile.** It treats any string ending in `n` whose first char is a digit
   (or `-`+digit) as a bigint. A legitimate string value like `"0x...n"`? (hex won't match digit-first
   except `0`) or a user string like `"42n"` would be coerced to BigInt. Low probability but a sharp
   edge for state containing string fields.

9. **Provider `Proxy` only intercepts `request`** and returns other props un-bound
   (`(target as any)[p]`). If any consumer relies on bound methods/events off the provider, this could
   subtly break; the indexer only uses `request`, so likely fine.

## Implications for the design plans

Mostly orthogonal to the historical-state DB / trigger plans (this is the in-browser client layer).
But two relevant notes:

- The **status/progress state machine** here (`Loading`/`FetchingEventStream`/`ProcessingEventStream`/
  `CatchingUp`/`IndexingLatest`, `syncPercentage`, `catchupThreshold`) is a good reference for what a
  *server-side* processor's query/status API might also need to expose to clients.
- `keepStateOnIndexedDB` supports **remote state snapshots** (fetch precomputed state + lastSync from
  a URL/prefix, pick the most-advanced). This is conceptually the "hybrid" model from the historical
  plan (server indexes; client uses snapshot + catches up). The plan's watcher/processor design should
  consider exposing exactly such a snapshot endpoint for browser clients to bootstrap from.

## Suggested follow-ups (this package, can be done independently)

- **Fix bug #1 (`finally` → `catch`)** — highest priority; add a test with a stubbed indexer.
- Guard `_auto_index` re-scheduling against `stopAutoIndexing` (#4), and guard progress math vs.
  zero (#5).
- Review the `indexToLatest`/`_auto_index` retry topology for overlapping loops (#3).
- Decide console vs. named-logs policy for this package and apply consistently.
- Add vitest tests: store wiring + the auto-index/stop lifecycle using a fake indexer + fake timers.
  (DOM/IndexedDB paths can stay out of scope or use fake-indexeddb only if warranted.)

> Bug #1 is impactful and low-risk to fix; worth doing soon even before the broader follow-ups.

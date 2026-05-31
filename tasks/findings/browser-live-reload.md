# Findings: browser live-reload (new contracts / new event ABI / new chain)

Focused follow-up review of how `ethereum-indexer-browser` reconfigures a running indexer when the
**source changes** (new contracts deployed, new event ABIs added) or the **chain changes**, and how
that propagates through the core engine.

**Reviewed:**
- `packages/ethereum-indexer-browser/src/IndexerState.ts` — `init`, `updateIndexer`, `updateProcessor`,
  `setupIndexing`, `reset`, the auto-index loop.
- `packages/ethereum-indexer/src/indexer.ts` — `reinit`, `updateIndexer`, `updateProcessor`, `reset`,
  `disableProcessing`/`reenableProcessing`, and `indexerMatches`.

## The intended live-reload flow

1. Consumer calls `update*` on the browser API:
   - `updateIndexer({provider?, source?, streamConfig?})` — for new contracts/ABIs (new `source`),
     a new chain (new `provider` + new `source.chainId`), or stream-config changes.
   - `updateProcessor(newProcessor)` — for a new processor (e.g. new event handlers / version).
2. The browser layer just delegates to `indexer.updateIndexer(...)` / `indexer.updateProcessor(...)`.
3. Core `updateIndexer`: `disableProcessing()` → compute `resetNeeded` (does the new source/config
   hash differ from current?) → reset the internal actions → `reinit(...)` → if `resetNeeded`,
   `processor.reset()` then `load()`; always `reenableProcessing()`.

## Bugs / correctness risks (live-reload specific)

### 1. **[HIGH] The browser layer's `syncing.lastSync` is never cleared on reconfigure.**
`setupIndexing()` early-returns if `$syncing.lastSync` is already set:
```ts
async function setupIndexing() {
    if ($syncing.lastSync) { return $syncing.lastSync; }   // <-- stale after updateIndexer
    ...
    indexer.onLoad = ...; indexer.onLastSyncUpdated = ...; indexer.onStateUpdated = ...;
    ...
}
```
After `updateIndexer`/`updateProcessor`, the core indexer is re-init'd (and may have reset), but the
browser's `$syncing.lastSync` from the *previous* configuration is still set. Consequences:
- The next `indexMore`/auto-index calls `setupIndexing()`, which **early-returns** and therefore
  **never re-attaches** `indexer.onLoad` / `onLastSyncUpdated` / `onStateUpdated`. Since the core
  `reinit` is on the *same* indexer instance the callbacks are technically still attached (they're
  instance fields, not cleared by reinit) — so this part may survive — **but** the displayed
  `lastSync`/progress remains the old one until the next `onLastSyncUpdated` fires, and
  `setupIndexing` returns the **stale** `lastSync` to its caller.
- Worse: `updateIndexer` is `async` in the core (it awaits `processor.reset()` + `load()`), but the
  browser `updateIndexer` **does not await** it (see #2). A subsequent `indexMore` can run against a
  half-reinitialised indexer while `$syncing.lastSync` still shows the old chain/source progress.

→ The browser `updateIndexer`/`updateProcessor`/`reset` should clear `$syncing.lastSync` (and likely
`state`, `status`) so `setupIndexing` re-runs cleanly for the new configuration.

### 2. **[HIGH] Browser `updateIndexer`/`updateProcessor` don't `await` (or surface errors from) the core.**
```ts
updateIndexer(update) {
    if (!indexer) throw new Error(`no indexer setup, call init`);
    indexer.updateIndexer(update);   // <-- not awaited, not returned
}
```
Core `updateIndexer` is async and does real work (chainId check, `processor.reset()`, `load()`).
The browser method returns `void` synchronously, so:
- callers can't await reconfiguration completion before calling `indexMore`/`startAutoIndexing`;
- a thrown error (e.g. the chainId-mismatch throw in core, see #3) becomes an **unhandled promise
  rejection** instead of something the consumer can catch or that sets `$syncing.error`.

→ Should be `async` + `return indexer.updateIndexer(update)` and route failures into `$syncing.error`.

### 3. **[MEDIUM] New-chain path can throw confusingly when only the provider changes.**
Core `updateIndexer`: if `resetNeeded` is false (source/config hash unchanged) it does a chainId
courtesy check and **throws** if the connected chain differs from `oldSource.chainId`. For a "new
chain" reload the consumer is expected to pass a new `source` (with new `chainId`) — if they pass only
a new `provider` (pointing at a different chain) without a new `source`, they get a throw. That's
arguably correct, but combined with #2 it surfaces as an unhandled rejection. The error message also
has a typo (`conext`). Note: the maintainer's own TODO says this check is the developer's
responsibility and may be removed.

### 4. **[MEDIUM] Source change and processor change are independent, but a combined change is uncoordinated.**
Source (new contracts / new ABIs) and processor (new handler logic) are **independent axes** — either
can change without the other:
- new contract address, same handlers → `updateIndexer` only;
- new processor logic, same contracts → `updateProcessor` only;
- both → two separate calls.

The issue is only the **"both" case**: `updateIndexer` (resets based on source/config hash via
`indexerMatches`, which does **not** consider the processor version) and `updateProcessor` (resets
based on `getVersionHash`) are two separate, each-async, each-resetting calls with **no coordinated
ordering**. Calling them back-to-back (the natural thing when a consumer ships new contracts *and* new
handlers together) can race: two resets/loads interleave. Note this is a *coordination* problem when
both change — not a claim that one implies the other.

### 5. **[MEDIUM] `updateProcessor` (core) doesn't `disableProcessing()` first.**
Unlike `updateIndexer`, `updateProcessor` cancels `_index`/`_feed` and resets `_load` only *inside*
the version-changed branch, and does not `block()` the index action. An in-flight auto-index tick
could interleave with the processor swap. Also it swaps `this.processor` **before** checking the
version hash, so even the "no version change" path has replaced the instance mid-flight.

### 6. **[MEDIUM] Auto-indexing keeps running across reconfiguration.**
If `startAutoIndexing()` is active and the consumer calls `updateIndexer`, the `_auto_index` timer is
not paused. A tick can fire `indexMoreAndCatchupIfNeeded()` → `setupIndexing()` (stale early-return,
#1) → `indexer.indexMore()` while core `updateIndexer` is mid-reinit. The core `disableProcessing()`
blocks the `_index` action, so the tick's `indexMore` may throw `Blocked` → caught by `_auto_index`'s
retry → re-armed. Net: noisy retries during reconfigure, and the loop races the reconfigure.

→ Browser should `stopAutoIndexing()` (or pause) around reconfiguration and resume after it resolves.

### 7. **[LOW] `reinit` recomputes `defaultFromBlock`; browser progress math uses it live.**
`setLastSync` reads `indexer.defaultFromBlock` for progress %. After `reinit` with a new source,
`defaultFromBlock` changes, but a stale `$syncing.lastSync` (#1) computed against the old start block
can show nonsensical percentages until the next update.

### 8. **[LOW] No `dispose()` / re-init path.**
`init` throws `already initialised`. There is no way to fully tear down (clear callbacks, stop timers,
drop the indexer) and start fresh — `updateIndexer` is the only reconfiguration path. For SPA
navigation / switching dapps this may be insufficient (also noted in the general browser findings #2).

## Summary

The live-reload mechanism **exists** (core `updateIndexer`/`updateProcessor` + `reinit` do the heavy
lifting and the reset-vs-keep decision via `indexerMatches`), but the **browser wrapper is the weak
layer**:
- it doesn't `await` the async core reconfigure (#2),
- it doesn't clear its own `$syncing.lastSync`/state so `setupIndexing` re-runs (#1),
- it doesn't pause auto-indexing during reconfigure (#6),
- and "new contracts + new processor" needs two uncoordinated calls (#4).

Highest-value fixes: **#1 + #2 + #6** in the browser layer (make `updateIndexer`/`updateProcessor`
async, clear syncing state, pause/resume auto-indexing). These are testable with the same
fake-provider + fake-indexer approach as `test/setupIndexing.test.ts`.

## Suggested follow-ups (TDD, browser layer)

- Make `updateIndexer`/`updateProcessor` `async` and `return`/await the core call; route errors to
  `$syncing.error` (test: stub indexer whose `updateIndexer` rejects → error surfaced, not unhandled).
- Clear `$syncing.lastSync` (+ status) on reconfigure so `setupIndexing` re-attaches/re-runs
  (test: updateIndexer with a new source → subsequent indexMore re-runs setup, progress reflects new
  start block).
- Pause auto-indexing during reconfigure and resume after (test with fake timers).
- Consider a combined `reconfigure({source, processor, provider, streamConfig})` that coordinates the
  source + processor change in one ordered, awaited operation (addresses #4).
- Core: `updateProcessor` should `disableProcessing()`/`reenableProcessing()` like `updateIndexer`,
  and not swap `this.processor` before deciding (addresses #5).

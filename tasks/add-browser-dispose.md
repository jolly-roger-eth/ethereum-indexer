# Add a `dispose()` / safe teardown + re-init path to `ethereum-indexer-browser`

**Area:** `packages/ethereum-indexer-browser` (`src/IndexerState.ts`)
**Type:** Implementation (TDD)
**Status:** todo

## Context

`createIndexerState(...)` returns an indexer-state object created via `init(...)`. Today there is no
way to fully tear it down: `init()` throws `already initialised` if an indexer is already set, and no
method clears the indexer, detaches its callbacks, or stops the auto-index timer. The only
reconfiguration path is `updateIndexer` / `updateProcessor` (which keep the **same** `EthereumIndexer`
instance, processor wiring, and stores).

This was the LOW item #6 ("no `dispose()` / re-init path") in
[`findings/browser-live-reload.md`](./findings/browser-live-reload.md), deliberately deferred out of
scope while the HIGH/MEDIUM live-reload fixes were done (those are complete and archived/committed:
async + error routing, clearing stale syncing state, pausing auto-indexing during reconfigure,
serializing overlapping reconfigures, and aligning core `updateProcessor`).

## Why it matters (consequences of NOT having it)

1. **No full context switch / fresh start.** For SPA navigation between different dapps/indexers, or
   switching to a genuinely different processor + state shape + stores, `updateIndexer` cannot express
   it (same instance) and `init` refuses to run again.
2. **Leaked auto-index timer on teardown.** `startAutoIndexing` arms `setTimeout(_auto_index, ...)`
   which re-arms itself. If the consumer drops all references to the indexer-state object (e.g. a
   component unmounts) **without** calling `stopAutoIndexing()`, the loop keeps firing forever,
   holding the closure (indexer, provider, processor, stores) alive — a real memory/CPU leak plus
   stray network requests after the UI is gone.
3. **Dangling callbacks.** `indexer.onLoad` / `onLastSyncUpdated` / `onStateUpdated` are set in
   `setupIndexing()` and never cleared; they close over `setSyncing` / `setState` / `setStatus`,
   keeping the stores reachable.

Severity is LOW for the common case (single long-lived indexer per page, `stopAutoIndexing()` on
unmount). It bites for SPA navigation between indexers, dev hot-reload (loops accumulate), and any
flow that drops the indexer-state object without explicitly stopping auto-indexing.

## Suggested scope (smallest valuable slice first)

A minimal `dispose()` that makes teardown safe:

1. `stopAutoIndexing()` (clear the timer).
2. Detach `indexer.onLoad` / `onLastSyncUpdated` / `onStateUpdated`.
3. Drop the `indexer` reference and reset relevant `$syncing` / `status` / `state` flags.
4. Optionally allow `init(...)` to run again afterwards (re-init path) — decide and document the
   semantics (does it reuse the processor's `createInitialState`? reset the stores?).

Consider whether `dispose()` should also be idempotent (safe to call twice) and whether
`reconfigure`-style operations should reject after `dispose()`.

## Workflow

- **TDD with confirmation gates**, same as the live-reload task: write a failing test first (vitest,
  `packages/ethereum-indexer-browser/test/`), show it RED, confirm with the maintainer, then
  implement and show GREEN. The `createIndexer` factory option on `createIndexerState` (added during
  the live-reload work) is useful for injecting a spy/fake indexer to assert callbacks are detached
  and timers cleared.
- Run state-dependent commands sequentially (this repo has hit races with parallel edit+test batches).
- Adding `dispose()` is a new public method on a published package → **changeset**
  (`ethereum-indexer-browser` patch/minor as appropriate).
- Do **not** auto-commit; present diffs and let the maintainer commit.

## Prompt (paste into a fresh context)

> Add a `dispose()` / safe teardown path to `packages/ethereum-indexer-browser`
> (`src/IndexerState.ts`). Read `tasks/add-browser-dispose.md` and
> `tasks/findings/browser-live-reload.md` (item #6) first. The problem: there is no way to fully tear
> down a `createIndexerState(...)` instance — `init()` throws `already initialised`, the auto-index
> `setTimeout` loop leaks if references are dropped without `stopAutoIndexing()`, and the
> `onLoad`/`onLastSyncUpdated`/`onStateUpdated` callbacks are never detached. Implement a minimal
> `dispose()` that stops auto-indexing, detaches those callbacks, drops the indexer reference, and
> resets the stores, and decide/document whether `init()` may run again afterwards. Use strict TDD
> with confirmation gates: write a failing test first (vitest in
> `packages/ethereum-indexer-browser/test/`; the `createIndexer` factory option is handy for
> injecting a spy), show it RED, STOP and ask me to confirm, then implement and show GREEN. Add a
> changeset (`ethereum-indexer-browser`). Do not commit without my confirmation.

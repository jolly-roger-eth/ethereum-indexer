# Review: ethereum-indexer-browser

**Area:** `packages/ethereum-indexer-browser`
**Type:** Code review
**Status:** done (initial review) — see `tasks/findings/ethereum-indexer-browser.md`

> An initial review has been completed. Findings are in `tasks/findings/ethereum-indexer-browser.md`.
> Notable: a real bug where `setupIndexing()` sets a `FAILED_TO_LOAD` error in a `finally` block on
> every call (should be `catch`), plus auto-index stop/retry robustness gaps. Remaining work = the
> follow-ups listed there (fix bug #1 first).

## Context

`ethereum-indexer-browser` is the observable / framework-hooks layer that most consumers actually use
(the core README's usage example is built on `createIndexerState(...).withHooks(react)` from this
package). It wraps the core `EthereumIndexer` and exposes subscribable state + syncing status, auto
indexing, and state persistence (IndexedDB).

This area has had recent churn (e.g. a "prevent re-initialization" fix), which is a hint that the
lifecycle/subscription logic is worth a careful read.

Relevant files:
- `packages/ethereum-indexer-browser/src/IndexerState.ts` (main logic)
- `packages/ethereum-indexer-browser/src/storage/` (state persistence, e.g. OnIndexedDB)
- `packages/ethereum-indexer-browser/src/utils/`
- `packages/ethereum-indexer-browser/src/index.ts` (public exports)
- Core engine it wraps: `packages/ethereum-indexer/src/indexer.ts`

## Goal

1. Summarise the observable/state model and the lifecycle (init, auto-indexing, re-init, reset,
   provider/chain changes).
2. Identify correctness risks: subscription leaks, double-init / re-init races, missed updates,
   error handling in the auto-indexing loop, and IndexedDB persistence edge cases (quota, version
   changes, source-hash mismatches).
3. Check the `console.*` usages here — decide which should route through `named-logs` and which are
   acceptable for a browser package.
4. Add tests where feasible. Note: this is browser-oriented; prefer testing pure state/reducer-like
   logic. DOM/IndexedDB-heavy paths may need a jsdom or fake-indexeddb setup — only add that if the
   value justifies it.

## Constraints / conventions

- vitest in the package's `test/` folder. A browser-ish environment may require configuring vitest
  `environment: 'jsdom'` and/or `fake-indexeddb` — add only if needed.
- Do not auto-commit; present diffs. Small commits.

## Prompt (paste into a fresh context)

> Review `packages/ethereum-indexer-browser` — the observable/hooks state layer that wraps the core
> `EthereumIndexer` (`packages/ethereum-indexer/src/indexer.ts`) and is the main public entry point
> for consumers (see the core README usage example). Focus on `src/IndexerState.ts` and `src/storage/`.
> Summarise the state model and lifecycle (init/auto-index/re-init/reset/provider+chain changes), then
> identify correctness risks (subscription leaks, double-init/re-init races, missed updates,
> auto-indexing error handling, IndexedDB persistence edge cases). Decide which `console.*` calls
> should move to named-logs. Add vitest tests for the testable (pure) logic; only introduce
> jsdom/fake-indexeddb if the value justifies it. Use a TDD approach for any bug found, follow repo
> conventions, and do not commit without my confirmation.

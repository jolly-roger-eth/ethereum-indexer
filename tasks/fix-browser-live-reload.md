# Fix: browser live-reload (new contracts / event ABIs / chain)

**Area:** `packages/ethereum-indexer-browser` (and possibly core `packages/ethereum-indexer`)
**Type:** Implementation (TDD)
**Status:** todo

## Context

A focused review of how `ethereum-indexer-browser` reconfigures a running indexer
(`updateIndexer` / `updateProcessor`) when the source changes (new contracts / new event ABIs), the
processor changes (new handler logic), or the chain changes is written up in
**`tasks/findings/browser-live-reload.md`** — read it first. It contains the full analysis; this task
is to fix the issues it lists.

The core engine (`EthereumIndexer.updateIndexer` / `updateProcessor` / `reinit`) does the heavy
lifting reasonably well; the **browser wrapper is the weak layer**.

Note on independence: source changes and processor changes are **independent axes** — a new processor
does NOT imply a new source and vice-versa. They can happen around the same time, but one does not
imply the other. Do not collapse them into a single mandatory operation; the only real problem is
*coordination* when a consumer changes both at once.

## Issues to fix (priority order; see findings for detail)

1. **[HIGH] `updateIndexer`/`updateProcessor` (browser) don't `await` / return the async core call.**
   Make them `async`, return/await `indexer.updateIndexer(...)` / `indexer.updateProcessor(...)`, and
   route failures into `$syncing.error` instead of leaving an unhandled promise rejection.
2. **[HIGH] `$syncing.lastSync` is not cleared on reconfigure**, so `setupIndexing()` early-returns
   with stale data and progress is computed against the old start block. Clear the relevant syncing
   state (and status) on reconfigure so `setupIndexing` re-runs cleanly.
3. **[MEDIUM] Auto-indexing is not paused during reconfigure** — a timer tick races the reinit
   (`Blocked` throw → retry → re-arm). Pause/stop auto-indexing during reconfigure and resume after it
   resolves.
4. **[MEDIUM] Combined source+processor change is uncoordinated/racy.** Consider an optional combined,
   ordered, awaited path (e.g. `reconfigure({source?, processor?, provider?, streamConfig?})`) — but
   keep `updateIndexer`/`updateProcessor` usable independently. Decide whether to add this or just
   document the ordering; confirm with the maintainer before adding new public API (needs a changeset).
5. **[MEDIUM] Core `updateProcessor` doesn't `disableProcessing()` first** and swaps `this.processor`
   before checking the version hash. Align it with `updateIndexer` (disable → swap/decide → reinit →
   reenable). This is a *core* change — separate commit + changeset.
6. **[LOW] Typo `conext`** in the core chainId-mismatch error message; **[LOW]** stale progress math
   after `defaultFromBlock` changes (falls out of fix #2); **[LOW]** no `dispose()`/re-init path
   (decide whether in scope).

## Required workflow (IMPORTANT)

- **TDD with explicit confirmation gates.** For each issue:
  1. Write a **failing test first** that demonstrates the issue, and **run it to show it is RED**.
  2. **Stop and ask the maintainer to confirm** before writing the fix.
  3. Only after confirmation, implement the fix and show it GREEN.
- Run tool calls that depend on file state **sequentially** (this repo has hit races when batching
  edit+test+commit in one parallel batch).
- Tests: vitest in `packages/ethereum-indexer-browser/test/` (already set up — see
  `test/setupIndexing.test.ts` for the fake-provider + minimal-processor + fake-indexer pattern).
- Any change to a published package's behaviour/API needs a **changeset** (`.changeset/*.md`).
  Browser fixes → `ethereum-indexer-browser` patch; core `updateProcessor` change → `ethereum-indexer`.
- Do **not** auto-commit; present diffs and let the maintainer commit.

## Prompt (paste into a fresh context)

> Work on fixing the live-reload / reconfiguration issues in `ethereum-indexer-browser` (when new
> contracts / event ABIs / a new processor / a new chain are introduced at runtime). The full review
> is in `tasks/findings/browser-live-reload.md` and the task (priority-ordered issues) is in
> `tasks/fix-browser-live-reload.md` — read both first.
>
> Key facts: the core `EthereumIndexer.updateIndexer`/`updateProcessor`/`reinit` are mostly fine; the
> browser wrapper (`packages/ethereum-indexer-browser/src/IndexerState.ts`) is the weak layer. Source
> changes and processor changes are INDEPENDENT axes — do not assume one implies the other.
>
> Use strict TDD WITH CONFIRMATION GATES: for each issue, FIRST write a failing test that demonstrates
> it and run it to show it RED, then STOP and ask me to confirm before you write the fix; only after I
> confirm, implement it and show it GREEN. Start with the two HIGH issues: (1) make the browser
> `updateIndexer`/`updateProcessor` async + awaited + route errors to `$syncing.error`; (2) clear
> `$syncing.lastSync`/status on reconfigure so `setupIndexing` re-runs. Then the MEDIUM ones (pause
> auto-indexing during reconfigure; the uncoordinated combined source+processor change; aligning core
> `updateProcessor` with `updateIndexer`). Tests use vitest in
> `packages/ethereum-indexer-browser/test/` (see `test/setupIndexing.test.ts` for the harness pattern).
> Run state-dependent commands sequentially (this repo has hit races with parallel edit+test batches).
> Add changesets for published-package changes. Do not commit without my confirmation.

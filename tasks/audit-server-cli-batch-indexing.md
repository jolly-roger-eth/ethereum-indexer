# Audit the server / CLI batch-indexing path (one-shot + long-running)

**Area:** `packages/ethereum-indexer-server`, `packages/ethereum-indexer-cli` (and the `keepState` /
`keepStream` persistence they rely on)
**Type:** Review (then TDD fixes if issues are found)
**Status:** todo

## Context

The browser live-reload work fixed reconfiguration bugs in `ethereum-indexer-browser`. The
server and CLI packages are **different**: they were verified to **not** be designed for live
reconfiguration —

- **CLI** (`packages/ethereum-indexer-cli/src/index.ts`): constructs an `EthereumIndexer` once,
  `load()`s, loops `indexMore()` to completion, writes the state file, exits. **One-shot batch.** No
  `updateIndexer` / `updateProcessor` / `startAutoIndexing`. Reconfiguration = re-run the process
  (e.g. after `src/contracts.ts` regenerates from a new deploy).
- **Server** (`packages/ethereum-indexer-server/src/server/simple.ts`): constructs the indexer once,
  `load()`s, and drives `indexMore()` via an HTTP `/indexMore` route + an internal loop.
  **Long-running, fixed source/processor.** Also no runtime reconfigure.

So the live-reload class of bugs does **not** apply here. This audit is about the **correctness of the
batch / long-running path itself**, which has not been touched since 2024 and underpins real usage:

- `wighawag/stratagems` `indexer/` uses the `ei` CLI (`index` script) and the `eis` server
  (`serve` script).
- `wighawag/stratagems-snapshots` runs the `ei` CLI in CI on a schedule to generate state snapshots
  that are committed and served statically, then loaded by the browser app (snapshot-seeding via
  `keepState` / `keepStream`).

## What to review (not live-reload)

1. **`keepState` / `keepStream` seeding correctness** — the snapshots CI depends on writing a state
   file and later resuming from it. Check: round-trip integrity (save then fetch), version/context
   matching (does a changed source/processor correctly invalidate or migrate a stale snapshot?),
   and what happens when the persisted state is from an incompatible version.
2. **Completion / exit semantics (CLI)** — does the `indexMore()` loop terminate correctly at chain
   tip? Exit codes on success vs. error? Partial-write / atomicity of the output file if interrupted
   mid-write (a half-written snapshot committed by CI would be bad).
3. **Error handling & retries** — both packages retry on errors; confirm there are no infinite/tight
   retry loops, and that genuine failures surface (non-zero exit for CLI; error response for server).
4. **Reorg handling in the long-running server** — across many `indexMore()` calls, are unconfirmed
   blocks / finality handled the same as the core engine expects?
5. **Server HTTP surface** — the `/indexMore` and query routes in `simple.ts`: auth, concurrent
   `/indexMore` calls (can two overlap?), response shaping. (Some of this overlaps notes in
   `tasks/findings/todo-triage.md` under "Server / streams packages".)

Explicitly **out of scope:** adding `updateIndexer` / `updateProcessor` / auto-reconfigure to server
or CLI. They are intentionally restart-to-reconfigure.

## Workflow

- Start with a **read-only review**, writing findings to `tasks/findings/server-cli-batch.md`
  (mirroring the other findings docs). Prioritise issues HIGH/MEDIUM/LOW.
- For anything actionable, follow the repo's **TDD-with-confirmation-gates** approach: failing test
  first (vitest in the package's `test/` dir), confirm, then fix. The core test harness pattern
  (`packages/ethereum-indexer/test/*.test.ts`, fake EIP-1193 provider) applies.
- Published-package behaviour changes need a **changeset**.
- Do not auto-commit.

## Prompt (paste into a fresh context)

---

Review the batch-indexing path of `ethereum-indexer-cli` and `ethereum-indexer-server` in this
monorepo (read `tasks/audit-server-cli-batch-indexing.md` first). These are NOT live-reconfigurable
(the CLI is one-shot: construct once, load, loop indexMore to tip, write state file, exit; the
server is long-running with a fixed source/processor driven via `/indexMore`) — so the browser
live-reload fixes do not apply. Focus on the correctness of the batch/long-running path itself:
`keepState`/`keepStream` snapshot round-trip + version/context invalidation (the
`wighawag/stratagems-snapshots` CI depends on this), CLI completion/exit semantics and atomic file
writes, error/retry loops, reorg handling across many indexMore calls, and the server's HTTP routes
(auth, overlapping `/indexMore`, response shaping). Produce a findings doc at
`tasks/findings/server-cli-batch.md` with prioritised issues; do not implement yet. For any fix,
use TDD with confirmation gates and add changesets. Do not commit without my confirmation.

---

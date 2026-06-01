# Fix: server / CLI batch-indexing issues (from the audit)

**Area:** `packages/ethereum-indexer-cli`, `packages/ethereum-indexer-server` (and the `keepState`
snapshot format they rely on)
**Type:** Implementation (TDD)
**Status:** done

> Completed. All HIGH/MEDIUM issues and LOW-1/LOW-2 implemented via TDD (characterization tests
> first, then a failing test, then the fix), each with a changeset:
> HIGH-3 server `/feed` body; HIGH-1 CLI atomic state write (temp+rename); MEDIUM-1 CLI exit codes;
> HIGH-2/MEDIUM-3 backward-compatible snapshot envelope + don't-swallow-corrupt; MEDIUM-4/5 server
> backoff + `lastError` in status + serialized indexing entrypoints; MEDIUM-2 CLI bounded retry +
> dropped redundant `eth_blockNumber` (`indexToTip`); LOW-1 constant-time api-key compare; LOW-2
> shaped 503s. Vitest stood up in both packages (cli 18 tests, server 12). Deferred: LOW-3
> (`bnReviver` heuristic, documented), LOW-4 (cli↔server duplication — own refactor task), LOW-5
> (orphaned snapshot pruning). See `tasks/findings/server-cli-batch.md` for the per-item status.

## Context

The audit of the batch / long-running indexing path is **done** and its findings are in
**`tasks/findings/server-cli-batch.md`** (read it first — it has the full analysis, code references,
and fix directions). This task is to **implement the fixes**. The original audit task
(`tasks/archive/audit-server-cli-batch-indexing.md`) was review-only; fixes were split out here so
each task stays self-contained.

Key framing (do NOT re-derive): these packages are **not** live-reconfigurable and that is
intentional — adding `updateIndexer`/`updateProcessor`/auto-reconfigure to server or CLI is **out of
scope**. The CLI is one-shot (construct → load → loop `indexMore()` to tip → write state → exit); the
server is long-running with a fixed source/processor. The fixes below are about correctness of that
batch path, especially the `wighawag/stratagems-snapshots` CI (which runs the `ei` CLI on a schedule
and commits the resulting snapshot files).

**No tests exist** in either package today (the server's `test` script is a placeholder). Part of
this task is standing up a vitest setup in each package's `test/` folder, reusing the core engine's
fake-EIP-1193-provider harness pattern (`packages/ethereum-indexer/test/*.test.ts`).

## Issues to fix (priority order; see findings for full detail)

1. **[HIGH-3] Server `/feed` reads the wrong body.** `server/simple.ts` uses `ctx.body.events`
   (response body) instead of `ctx.request.body` like every other route → throws on every real call.
   Tiny, isolated, clearly wrong. Start here. (`ethereum-indexer-server`)
2. **[HIGH-1] CLI state file is written non-atomically.** `keepState.save` does `writeFileSync`
   directly over the destination on every `indexMore()`; a mid-write kill leaves truncated JSON that
   CI can commit/publish. Write to a temp file in the same dir + `fs.renameSync` into place (both
   `state` and `lastSync` files); consider writing on an interval / at the end instead of every
   block. (`ethereum-indexer-cli`)
3. **[MEDIUM-1] CLI always exits 0.** `cli.ts` has no `.catch` / `process.exit`. A failed index looks
   like CI success, and the process may not exit promptly on success. Add
   `.then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1)})`. (`ethereum-indexer-cli`)
4. **[HIGH-2 / MEDIUM-3] Snapshot integrity/version envelope.** `{lastSync, state, history}` has no
   schema/version/checksum; `fetch`'s `try/catch` swallows all parse errors as "no snapshot". A
   processor that changes its state shape but keeps the same `getVersionHash()` ⇒ silent corruption.
   Design a small envelope (`{format, processor, savedAt, ...}`), validate it in `fetch`, and at
   least log (don't silently swallow) parse failures. Coordinate with the core `context.processor`
   check so it isn't duplicated. **Design/confirm with maintainer before changing the on-disk format**
   (it affects existing committed snapshots). (`ethereum-indexer-cli`, maybe core)
5. **[MEDIUM-4 / MEDIUM-5] Server indexing robustness.** Auto-index `index()` retries every 1s
   forever with no backoff, logs at `info`, and `/` still reports `indexing:true` while stuck; manual
   `/indexMore` doesn't set `this.indexing` so two concurrent calls race. Add exponential backoff +
   error escalation + surface last-error in the `/` status, and a single in-flight guard covering all
   indexing entrypoints (auto loop + `/indexMore` + `/feed` + `/replay`). (`ethereum-indexer-server`)
6. **[MEDIUM-2] CLI loop termination contract.** Decide with the maintainer: index up to the
   block observed at start, or follow the live tip? Drop the redundant startup `eth_blockNumber` (or
   use it as a fixed target) and add **bounded** retry around `indexMore()` for transient RPC errors.
   (`ethereum-indexer-cli`)
7. **[LOW] Opportunistic / document:** unauthenticated read routes + non-constant-time key compare
   (LOW-1); routes that `throw` → 500s instead of shaped `{error:{code}}` (LOW-2); heuristic
   `bnReviver` can mis-parse strings ending in `n` (LOW-3 — may fold into the envelope work);
   CLI↔server duplication of processor/source setup (LOW-4 — extract to `ethereum-indexer-utils`);
   orphaned content-hashed snapshot files never pruned (LOW-5).

**Explicitly out of scope:** adding live reconfiguration (`updateIndexer`/`updateProcessor`/
auto-reconfigure) to server or CLI. Restart-to-reconfigure is intentional.

## Required workflow (IMPORTANT)

- **TDD with confirmation gates.** For each issue: write a **failing test first** and run it to show
  it RED; then **stop and ask the maintainer to confirm** before writing the fix; only after
  confirmation, implement and show GREEN. (See `tasks/archive/add-browser-dispose.md` /
  `fix-browser-live-reload.md` for the established pattern.)
- **Stand up vitest** in `packages/ethereum-indexer-cli/test/` and
  `packages/ethereum-indexer-server/test/` (add the `test` script + devDeps), reusing the fake
  EIP-1193 provider harness from `packages/ethereum-indexer/test/`.
- Run state-dependent commands **sequentially** (this repo has hit races with parallel
  edit+test+commit batches).
- Any change to a published package's behaviour/API needs a **changeset** (`.changeset/*.md`):
  server fixes → `ethereum-indexer-server`; CLI fixes → `ethereum-indexer-cli`; snapshot-format /
  core changes → also `ethereum-indexer`.
- The snapshot-format change (#4) and the CLI termination contract (#6) need **maintainer sign-off
  before coding** because they affect on-disk format / observable behaviour the CI depends on.
- Do **not** auto-commit; present diffs and let the maintainer commit.

## Prompt (paste into a fresh context)

---

Implement the fixes from the server/CLI batch-indexing audit. Read
`tasks/findings/server-cli-batch.md` (the full review) and `tasks/fix-server-cli-batch.md` (this
task, priority-ordered issues) first. These packages are NOT live-reconfigurable and must stay that
way (no `updateIndexer`/`updateProcessor` on server/CLI — out of scope). Neither package has tests
yet, so stand up vitest in their `test/` folders reusing the fake EIP-1193 provider harness from
`packages/ethereum-indexer/test/`. Use strict TDD with confirmation gates: for each issue write a
failing test first, run it RED, STOP and ask me to confirm, then implement and show GREEN. Start with
HIGH-3 (server `/feed` uses `ctx.body.events` instead of `ctx.request.body`), then HIGH-1 (CLI atomic
state write via temp-file + rename), then MEDIUM-1 (CLI exit codes). The snapshot-format envelope
(HIGH-2/MEDIUM-3) and the CLI loop termination contract (MEDIUM-2) change on-disk format / observable
behaviour the stratagems-snapshots CI depends on — design and get my sign-off BEFORE coding those.
Add changesets for published-package changes (`ethereum-indexer-server` / `ethereum-indexer-cli` /
`ethereum-indexer`). Run state-dependent commands sequentially. Do not commit without my
confirmation.

---

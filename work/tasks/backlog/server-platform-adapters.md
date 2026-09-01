---
title: "D1's statement and size limits reach the store's chunk bound"
slug: server-platform-adapters
spec: historical-state-database
blockedBy: [index-to-a-store-from-the-cli]
needsAnswers: true
covers: [6]
---

<!-- open-questions -->
<!--
  TRANSIENT BLOCK. This task is a REMNANT: six of its seven criteria were delivered by
  `agnostic-server-skeleton` and are pre-ticked below, which makes it a backward artifact
  (WORK-CONTRACT.md: "a task with pre-ticked acceptance criteria is a changelog wearing a
  spec's shape"). Its one live criterion was, by its own STATUS note, NOT DOABLE when written.
  Resolve the question below, then either re-cut this as a clean forward task for that one
  criterion or cancel it and mint one.
-->

## Open questions

1. Does the enabling seam exist yet? The remaining criterion needs the server to reach a store's
   chunk bound, and `agnostic-server-skeleton` deliberately gave the server NO store dependency.
   `work/specs/ready/one-command-runs-the-whole-pipeline.md` says `run` "is the first thing that
   wires a store into a server process, so that criterion becomes reachable here; it is not this
   spec's to deliver" — so this task is blocked on the `run` work, and the `blockedBy` above names
   its prerequisite (`index-to-a-store-from-the-cli`, which that spec's own tasks are blocked on)
   as the nearest real edge. Confirm the seam is actually there before building; if it is not,
   this bounces.
2. Should this task be re-cut or cancelled? It carries six delivered criteria and one live one.
   Cancelling it (`tasks/cancelled/`, reason: superseded, six criteria delivered by
   `agnostic-server-skeleton`) and minting a forward task named for the one remaining piece is the
   honest shape. Kept as-is only because someone must confirm nothing else in it is outstanding.
3. It shares `platforms/nodejs/src` with `one-command-runs-the-whole-pipeline`'s
   "`startServer` takes a `RemoteSQL`" exception. That overlap is FLAGGED in that spec and
   serialised by nothing. Whichever is tasked second must carry the `blockedBy`.

<!-- /open-questions -->

## What to build

> **STATUS, 2026-08-22: mostly BUILT already, under `agnostic-server-skeleton`.** Both adapters exist and are verified: `platforms/nodejs` (`@etherfold/platform-nodejs`, libSQL, 3 tests over real HTTP) and `platforms/cf-worker` (`@etherfold/platform-cf-worker`, D1, 2 tests under `@cloudflare/vitest-pool-workers`, and `wrangler deploy --dry-run` passes). `platforms/*` is in the workspace and in the root build/test scripts. The server's runtime-agnosticism is now ASSERTED by `packages/server/test/platformAgnostic.test.ts`.
>
> **What remains is exactly one criterion**: D1's per-request statement and size limits expressed as adapter configuration feeding the store's chunk bound. That is NOT doable yet. The bound lives in `@etherfold/state-store-sqlite` (`BatchBounds`, `DEFAULT_BATCH_BOUNDS` in `src/batching.ts`, already parameterised), but the server has no store dependency: `agnostic-server-skeleton` deliberately excluded one, so there is no seam yet through which an adapter's limits could reach it. Do this when the store is wired into the server, and do not rebuild the adapters.
>
> Note for whoever picks this up: `@cloudflare/vitest-pool-workers` v0.22 removed the `./config` entry point and `defineWorkersConfig`; the pool is now a Vite plugin, `cloudflareTest(...)`. The house template still shows the old form because it is pinned to an older vitest.

Two thin host adapters under `platforms/`, each supplying the `{getDB, getEnv}` the agnostic server expects, following `~/dev/github/wighawag/template-agnositic-server`:

- **Node**: a real process, a libSQL/SQLite-backed `RemoteSQL`, environment from the process environment. This one is fully runnable and testable locally, which makes it the reference host.
- **Cloudflare Worker**: a D1-backed `RemoteSQL`, environment from bindings, with the `wrangler` configuration and the platform-local test setup the template uses.

The adapters are the **only** place a runtime is named. If anything platform-specific leaks back into the server package, that is a bug in this task, not a compromise to accept.

Writing these is ordinary work. **Deploying** them, which needs an account, D1 provisioning and secrets, is an operational step and deliberately not part of this task.

## Acceptance criteria

- [x] The server runs under both adapters, serving the same routes with identical behaviour.
- [x] The Node adapter runs locally against libSQL/SQLite with no cloud account, and its tests exercise the real routes.
- [x] The Worker adapter builds under `wrangler` and passes its platform-local tests.
- [x] Neither adapter contains business logic: the diff between them is database and environment wiring only.
- [x] The server package still imports nothing platform-specific after this task, and that is asserted rather than assumed.
- [ ] D1's per-request statement and size limits are expressed as adapter configuration feeding the store's existing chunk bound, not as constants inside shared code.
- [x] The repo installs, builds and tests cleanly with `platforms/*` in the workspace.

## Blocked by

- `agnostic-server-skeleton` (the app being hosted, and the `platforms/*` workspace glob) — DONE.
- `index-to-a-store-from-the-cli`, as the nearest real edge onto the work that creates the seam the
  one remaining criterion needs (a store wired into a server process). Added because this task sat
  claimable with a criterion its own STATUS note calls not-doable, so an agent claiming it stalls.

## Prompt

> Build the two host adapters for the indexer-server in the `etherfold` monorepo, under `platforms/`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED, and this one is a REMNANT — read the open-questions block at the top before anything else). Six of its seven criteria are already delivered; only the D1-limits one is live, and its own STATUS note says it was not doable when written. Confirm the store-into-server seam now EXISTS before building; if it does not, do NOT build around it — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal"). Confirm also that `agnostic-server-skeleton` landed and that `pnpm-workspace.yaml` already globs `platforms/*`. Read `docs/adr/0003`.
>
> Follow `~/dev/github/wighawag/template-agnositic-server` exactly: each adapter supplies `{getDB, getEnv}` and nothing else. `~/dev/github/wighawag/push-notification/platforms/cf-worker` is a working second reference. Build a Node adapter (libSQL/SQLite, environment from the process) and a Cloudflare Worker adapter (D1 binding, `wrangler` config, platform-local tests).
>
> The point of the exercise is that **D1 is one backend among several, not the target**. Treat the Node adapter as the reference host, since it runs with no cloud account and makes the whole server testable locally. If you find yourself wanting to reach back into the server package for something platform-specific, that is the signal the seam is wrong: fix the seam, do not widen the exception.
>
> D1's per-request statement and size caps belong here, as adapter configuration feeding the chunk bound the store already exposes. Do not put provider constants in shared code.
>
> Deployment (account, D1 provisioning, secrets) is NOT part of this task; stop at "builds and passes tests". Add a changeset, and do not commit without confirmation.

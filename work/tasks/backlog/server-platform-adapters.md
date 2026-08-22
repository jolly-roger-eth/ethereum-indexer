---
title: Host adapters for the indexer-server (Node and Cloudflare Worker)
slug: server-platform-adapters
spec: historical-state-database
blockedBy: [agnostic-server-skeleton]
covers: [6]
---

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

- `agnostic-server-skeleton` (the app being hosted, and the `platforms/*` workspace glob).

## Prompt

> Build the two host adapters for the indexer-server in the `etherfold` monorepo, under `platforms/`.
>
> FIRST, check this task against current reality: confirm `agnostic-server-skeleton` landed and that `pnpm-workspace.yaml` already globs `platforms/*`. Read `docs/adr/0003`.
>
> Follow `~/dev/github/wighawag/template-agnositic-server` exactly: each adapter supplies `{getDB, getEnv}` and nothing else. `~/dev/github/wighawag/push-notification/platforms/cf-worker` is a working second reference. Build a Node adapter (libSQL/SQLite, environment from the process) and a Cloudflare Worker adapter (D1 binding, `wrangler` config, platform-local tests).
>
> The point of the exercise is that **D1 is one backend among several, not the target**. Treat the Node adapter as the reference host, since it runs with no cloud account and makes the whole server testable locally. If you find yourself wanting to reach back into the server package for something platform-specific, that is the signal the seam is wrong: fix the seam, do not widen the exception.
>
> D1's per-request statement and size caps belong here, as adapter configuration feeding the chunk bound the store already exposes. Do not put provider constants in shared code.
>
> Deployment (account, D1 provisioning, secrets) is NOT part of this task; stop at "builds and passes tests". Add a changeset, and do not commit without confirmation.

---
title: Platform-agnostic indexer-server skeleton
slug: agnostic-server-skeleton
spec: historical-state-database
needsAnswers: true
blockedBy: []
covers: [6]
---

<!-- open-questions -->
<!--
  TRANSIENT BLOCK. One naming decision a human should make, since it concerns a
  published package name and a deprecation path.
-->

## Open questions

1. **What is the new server package called?** `ethereum-indexer-server` is taken by the existing Koa/PouchDB long-running server, which is on a retirement path with `ethereum-indexer-db-utils` (ADR-0010) but is still published and still works. Options: (a) a new name now and rename later, which means two renames; (b) a new name permanently, leaving the old name deprecated; (c) take the name now and move the old one aside, which breaks existing consumers immediately. This is an expand/migrate/contract sequencing choice on a public package, so a human should pick.

<!-- /open-questions -->

## What to build

The HTTP surface for the indexer-server, following the house model in `~/dev/github/wighawag/template-agnositic-server`: **core server logic is platform-agnostic and receives its database and environment by injection**, while host adapters live separately.

Concretely, a Hono app whose options are `{getDB, getEnv}`, depending on `remote-sql` and never on a runtime. No Cloudflare imports, no Node built-ins, no D1 references. `wighawag/push-notification` follows the same model and is a working second reference.

Scope is the skeleton only: the app, the injection shape, the static schema convention (`.sql` files with the codegen step the template uses, for the **fixed** tables only, since entity tables are created dynamically by the store), a health/status route, and the workspace change that lets `platforms/*` exist (`pnpm-workspace.yaml` currently globs only `packages/*` and `examples/*`).

No chain logic and no store dependency: this task is deliberately buildable in parallel with the store work.

## Acceptance criteria

- [ ] A server package exports a factory taking `{getDB, getEnv}` and returning a Hono app.
- [ ] The package imports no platform-specific API: no Cloudflare types, no Node built-ins, no D1. A reviewer can verify this by reading its dependencies.
- [ ] Fixed-table schema follows the template's `.sql` plus codegen convention; the dynamic-DDL exception for entity tables is documented at the seam where it applies.
- [ ] A status route reports enough to tell a healthy server from a stuck one (at minimum: reachable, schema applied, and the last error if any).
- [ ] `pnpm-workspace.yaml` includes `platforms/*` and the repo still installs, builds and tests cleanly.
- [ ] The app is exercised by tests without any platform adapter, against local libSQL.
- [ ] A changeset accompanies the new package.

## Blocked by

- None, can start immediately. Deliberately independent of the store tasks.

## Prompt

> Build the platform-agnostic indexer-server skeleton in the `ethereum-indexer` monorepo.
>
> FIRST, check this task against current reality, and note it carries an open question about the package name that must be answered before you start (see the task body). Read `docs/adr/0003` (the log-fetcher / stream-builder / processor split, and why "processor" stays reserved for the existing reducer) and `docs/adr/0010` (the old server's retirement path).
>
> Follow the house model in `~/dev/github/wighawag/template-agnositic-server`: `packages/server` holds a Hono app that knows only `RemoteSQL` and receives `{getDB, getEnv}` by injection; `platforms/*` holds thin host adapters that supply them. `~/dev/github/wighawag/push-notification` is a second working reference of the same shape. The point is that the server runs on Node, Bun, Workers or anything else, so **D1 is one backend among several, never the target**: no Cloudflare imports, no Node built-ins, no D1 references anywhere in this package.
>
> Scope is the skeleton: the app factory, the injection shape, the static `.sql` schema convention with its codegen step, a status route, and adding `platforms/*` to `pnpm-workspace.yaml`. One deviation from the template to document at the seam: entity tables cannot be static schema, because the versioned-row store creates them from whatever entities a processor declares, so static schema covers only the fixed tables.
>
> Do not add chain logic or depend on the store; this task is meant to run in parallel with the store work. Test the app without any platform adapter, against local libSQL. Add a changeset, and do not commit without confirmation.

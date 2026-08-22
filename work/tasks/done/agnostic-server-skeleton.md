---
title: Platform-agnostic indexer-server skeleton
slug: agnostic-server-skeleton
spec: historical-state-database
blockedBy: []
covers: [6]
---

## What to build

The HTTP surface for the indexer-server, following the house model in `~/dev/github/wighawag/template-agnositic-server`: **core server logic is platform-agnostic and receives its database and environment by injection**, while host adapters live separately.

The package is **`@etherfold/server`**, in `packages/server/`. The naming question this task used to carry (that `ethereum-indexer-server` is taken by the retiring Koa/PouchDB server) is answered by ADR-0014 and ADR-0017: packages move to the `@etherfold` scope, which is a fresh namespace, so the new server takes the obvious name while the old unscoped package keeps working until it is deprecated. Set `publishConfig.access: "public"`, which is mandatory rather than decorative for a scoped package.

Concretely, a Hono app whose options are `{getDB, getEnv}`, depending on `remote-sql` and never on a runtime. No Cloudflare imports, no Node built-ins, no D1 references. `wighawag/push-notification` follows the same model and is a working second reference.

Scope is the skeleton only: the app, the injection shape, the static schema convention (`.sql` files with the codegen step the template uses, for the **fixed** tables only, since entity tables are created dynamically by the store), a health/status route, and the workspace change that lets `platforms/*` exist (`pnpm-workspace.yaml` currently globs only `packages/*` and `examples/*`).

No chain logic and no store dependency: this task is deliberately buildable in parallel with the store work.

## Acceptance criteria

- [x] A server package exports a factory taking `{getDB, getEnv}` and returning a Hono app.
- [x] The package imports no platform-specific API: no Cloudflare types, no Node built-ins, no D1. A reviewer can verify this by reading its dependencies.
- [x] Fixed-table schema follows the template's `.sql` plus codegen convention; the dynamic-DDL exception for entity tables is documented at the seam where it applies.
- [x] A status route reports enough to tell a healthy server from a stuck one (at minimum: reachable, schema applied, and the last error if any).
- [x] `pnpm-workspace.yaml` includes `platforms/*` and the repo still installs, builds and tests cleanly.
- [x] The app is exercised by tests without any platform adapter, against local libSQL.
- [x] A changeset accompanies the new package.

## Blocked by

- None, can start immediately. Deliberately independent of the store tasks.

## Prompt

> Build the platform-agnostic indexer-server skeleton in the `etherfold` monorepo.
>
> FIRST, check this task against current reality. Read `docs/adr/0003` (the log-fetcher / stream-builder / processor split, and why "processor" stays reserved for the existing reducer), `docs/adr/0010` (the old server's retirement path) and `docs/adr/0014` plus `docs/adr/0017` (the `@etherfold` scope, which settles that this package is `@etherfold/server` in `packages/server/`).
>
> Follow the house model in `~/dev/github/wighawag/template-agnositic-server`: `packages/server` holds a Hono app that knows only `RemoteSQL` and receives `{getDB, getEnv}` by injection; `platforms/*` holds thin host adapters that supply them. `~/dev/github/wighawag/push-notification` is a second working reference of the same shape. The point is that the server runs on Node, Bun, Workers or anything else, so **D1 is one backend among several, never the target**: no Cloudflare imports, no Node built-ins, no D1 references anywhere in this package.
>
> Scope is the skeleton: the app factory, the injection shape, the static `.sql` schema convention with its codegen step, a status route, and adding `platforms/*` to `pnpm-workspace.yaml`. One deviation from the template to document at the seam: entity tables cannot be static schema, because the versioned-row store creates them from whatever entities a processor declares, so static schema covers only the fixed tables.
>
> Do not add chain logic or depend on the store; this task is meant to run in parallel with the store work. Test the app without any platform adapter, against local libSQL. Add a changeset, and do not commit without confirmation.

## Decisions

Recorded at build time, per the prompt.

- **The schema version row lives in the SQL, not in the code that applies it.** `applySchema` now only executes `db.sql`. It was writing the version row itself, which meant a database migrated by wrangler (D1 migrations execute the `.sql` files and nothing else) came up with the table present, no version row, and a permanent unhealthy status. The Worker host's test caught it. A test now asserts `SCHEMA_VERSION` matches the row the SQL inserts, so the constant cannot drift from the file.
- **Statement splitting strips comments first.** A semicolon inside a `--` comment was cutting the following statement in half and failing at runtime with a syntax error quoting a word of English prose. The house template never hit this because its schema is one statement with no comments.
- **`sql2ts.cjs` escapes backticks, `${` and backslashes; the house template's copy does not.** A backtick in a SQL comment otherwise emits TypeScript that does not parse. This is a deliberate divergence from `~/dev/github/wighawag/template-agnositic-server` and a candidate to push upstream.
- **The database is resolved per request, not once at construction.** Node could bind once, but on Workers the D1 binding only exists on the request's `env`. A test pins the property by serving two requests against two different databases.
- **Auto-setup is a Node-host default, not a server behaviour.** One process owning one file may migrate on boot; several Worker isolates racing to migrate one D1 may not, so the Worker host does not.
- **The status route returns 503 when the schema version is not the one this build expects**, rather than 200 with a warning field. A version mismatch means someone else's migration owns tables this build reads, which is not a healthy server.

# Add descriptions + READMEs to the published `ethereum-indexer` packages

**Area:** all published packages under `packages/*`
**Type:** Documentation
**Status:** todo

## Context

Every published package in this monorepo currently has **no `description` field** in its
`package.json` (they all report `desc: (none)`) and most have **no `README.md`**. This hurts
discoverability on npm (no summary, no readme shown) and makes it hard for newcomers to understand
what each package is for and how the pieces fit together.

Note: `ethereum-indexer-db-processors` already received a status README (it is marked as a
prototype superseded by `tasks/plan-historical-state-database.md`) and
`ethereum-indexer-streams` has been removed — so neither needs work here beyond consistency.

## Packages to document (current, kept set)

| Package | One-line role (suggested starting point — verify against source) |
|---|---|
| `ethereum-indexer` | Core indexing engine: fetch logs, detect reorgs, drive a processor. |
| `ethereum-indexer-browser` | Browser wrapper with reactive stores, IndexedDB persistence, auto-indexing, live reconfigure. |
| `ethereum-indexer-js-processor` | Author processors as in-memory (immer) state reducers over events. |
| `ethereum-indexer-cli` | `ei` CLI: run a processor over a source and write the computed state to a file (one-shot). |
| `ethereum-indexer-server` | `eis` HTTP server: run an indexer as a long-running backend with a query API. |
| `ethereum-indexer-utils` | Shared helpers (context/source hashing, filenames, JS utils). |
| `ethereum-indexer-fs` | Node filesystem persistence adapters (`keepState` / `keepStream` on disk). |
| `ethereum-indexer-fs-cache` | Filesystem-backed event-log cache (used by the server). |
| `ethereum-indexer-db-utils` | Database abstractions (PouchDB-backed) + cached event stream used by DB processors. |
| `ethereum-indexer-db-processors` | (Already has a status README — prototype, superseded.) Keep consistent only. |

## What to do

1. For each package, add a concise, accurate `description` to its `package.json` (one sentence).
2. Add a short `README.md` per package: what it is, when to use it (vs. the alternatives — esp.
   browser+js-processor for client indexing vs. server/cli for backend/snapshots), a minimal usage
   snippet, and links to related packages.
3. **Verify each summary against the actual source** before writing it — do not guess the API. The
   real consumers are good references for intended usage:
   - `wighawag/stratagems` (`indexer/` uses `js-processor` + `cli` + `server`; `web/` uses `browser`),
   - `wighawag/stratagems-snapshots` (CI runs the `ei` CLI to generate state snapshots served
     statically).
4. Consider a short top-level section in the root `README.md` / docs mapping the package graph
   (engine -> processor authoring -> run client (browser) / run backend (server/cli) / persist (fs,
   db-utils)).
5. `description` changes touch published `package.json`s -> add a **changeset** (a `patch` for each
   package whose `package.json` changes). README-only additions may not strictly need one, but a
   single changeset covering the doc pass is fine.

## Constraints / conventions

- Do not change any runtime behaviour; this is docs + metadata only.
- Keep summaries truthful about status (e.g. `db-processors` is a prototype; `cli`/`server` are
  one-shot/long-running batch indexers, NOT live-reconfigurable).
- Do not auto-commit; present diffs for review.

## Prompt (paste into a fresh context)

---

Add a one-sentence `description` to every published package's `package.json` under `packages/*` in
the `ethereum-indexer` monorepo, and a short, accurate `README.md` per package, following
`tasks/add-package-readmes-and-descriptions.md`. Verify each summary against the actual source
(and against the real consumers `wighawag/stratagems` and `wighawag/stratagems-snapshots`) before
writing it — do not guess. `ethereum-indexer-db-processors` already has a status README (prototype,
superseded) and `ethereum-indexer-streams` was removed, so skip those except for consistency. Add a
changeset for the `package.json` description changes. Docs/metadata only — no behaviour changes; do
not commit without my confirmation.

---

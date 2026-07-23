---
title: Add descriptions + READMEs to the published ethereum-indexer packages
slug: add-package-readmes-and-descriptions
covers: []
blockedBy: []
---

## What to build

Add a one-sentence `description` to every published package's `package.json` under `packages/*`, and a short, accurate `README.md` per package (what it is, when to use it vs. the alternatives, a minimal usage snippet, links to related packages). Verify each summary against the actual source and the real consumers (`wighawag/stratagems`, `wighawag/stratagems-snapshots`) before writing — do not guess the API. Docs + metadata only; no runtime behaviour changes. `ethereum-indexer-db-processors` already has a status README (prototype, superseded); `ethereum-indexer-streams` was removed — skip both except for consistency.

## Acceptance criteria

- [ ] Every published package under `packages/*` has a truthful one-sentence `description` in `package.json`.
- [ ] Every kept package has a `README.md` (role, when-to-use, minimal snippet, related links).
- [ ] Summaries verified against source + the real consumers (not guessed); status stated truthfully (db-processors = prototype; cli/server = one-shot / long-running, NOT live-reconfigurable).
- [ ] A changeset covers the `package.json` `description` changes (a `patch` per changed package).
- [ ] Optional: a top-level README/docs section mapping the package graph (engine → processor authoring → run client / backend / persist).

## Blocked by

- None — can start immediately.

## Prompt

> Add a one-sentence `description` to every published package's `package.json` under `packages/*` in the `ethereum-indexer` monorepo, and a short, accurate `README.md` per package. Verify each summary against the actual source (and against the real consumers `wighawag/stratagems` and `wighawag/stratagems-snapshots`) before writing it — do not guess. `ethereum-indexer-db-processors` already has a status README (prototype, superseded) and `ethereum-indexer-streams` was removed, so skip those except for consistency. Add a changeset for the `package.json` description changes. Docs/metadata only — no behaviour changes; do not commit without confirmation.
>
> Package roles (verify against source): `ethereum-indexer` = core engine (fetch logs, detect reorgs, drive a processor); `ethereum-indexer-browser` = browser wrapper (reactive stores, IndexedDB persistence, auto-indexing, live reconfigure); `ethereum-indexer-js-processor` = author processors as in-memory (immer) state reducers; `ethereum-indexer-cli` (`ei`) = run a processor over a source and write state to a file (one-shot); `ethereum-indexer-server` (`eis`) = long-running HTTP backend with a query API; `ethereum-indexer-utils` = shared helpers (context/source hashing, filenames); `ethereum-indexer-fs` = node fs persistence adapters; `ethereum-indexer-fs-cache` = fs-backed event-log cache; `ethereum-indexer-db-utils` = PouchDB-backed DB abstractions + cached event stream.

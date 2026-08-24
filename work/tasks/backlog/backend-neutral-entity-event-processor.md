---
title: An EventProcessor that runs an entity processor against ANY StateStore, not just SQLite
slug: backend-neutral-entity-event-processor
spec: one-processor-everywhere
blockedBy: []
covers: [1, 12]
---

## What to build

The runtime the spec's first user story promises and that nothing currently provides: a component that takes an entity processor plus a `StateStore` and indexes with it, whatever the store is.

Everything underneath this exists and is tested. What is missing is the shell. Today the ONLY `EventProcessor` implementation over the seam is `VersionedStateEventProcessor` (`packages/processor-sqlite/src/VersionedStateEventProcessor.ts`), and it is SQLite-bound by construction: it takes a `RemoteSQL` and builds its own store (`this.store = new VersionedStateStore(db, processor.entities, options)`). So "one processor, several backends" is true in the test suite (`processor-entities/test/two-backends.test.ts`, `patch-backend.test.ts`, the stratagems workload on memory/sqlite/patch) and reachable through no shipped path. `@etherfold/processor-sqlite` is depended on by nobody.

**This is mostly an EXTRACTION, not a build**, and it is worth knowing that before you start. The per-block engine is ALREADY backend-neutral: `runBlockHandlers(store: StateStore, ...)` and `applyEventStream(store: StateStore, ...)` live in `packages/processor-entities/src/apply.ts` and are written against the seam, with a doc comment saying so. Revert-then-apply, read-your-writes, the block grouping and the fork point are all there.

Three things bind the shell to SQLite, and only the second is a real design question.

**1. The store is constructed rather than injected.** Invert it: take a `StateStore`. Mechanical.

**2. The sync cursor is persisted in SQL.** `packages/processor-sqlite/src/sync.ts` keeps `LastSync` in a `_sync` table: `SYNC_SCHEMA_DDL`, a `SELECT`, and an `INSERT ... ON CONFLICT` upsert, reached through `this.db` directly in `load`, `process` and `reset`. A browser deployment on IndexedDB has no SQL to write a cursor into, so this is the thing that actually has to move.

The good news is that the hard half is already neutral: `serializeLastSync` / `deserializeLastSync` are plain JSON with a bigint replacer/reviver and know nothing about SQL. Only the STORAGE is SQL-shaped, and what it stores is one string under one key.

**Where the cursor lives is yours to decide, and it is the decision this task turns on.** Options, none obviously right:

- Widen `StateStore` with a small cursor port (read/write an opaque string under a key). One seam, every backend implements it, nothing extra to wire. Cost: it grows the contract with something that is not entity state, and every future backend inherits the obligation.
- A separate small port the deployment supplies (a `SyncStore` / keeper). Keeps `StateStore` about entity state only, and the browser already has keeper idioms to follow (`packages/browser/src/storage/state/OnIndexedDB.ts`, `OnLocalStorage.ts`, `stream/OnIndexedDB.ts`). Cost: a second thing every deployment must wire, and one more way to misconfigure.
- Store the cursor as a reserved entity through the seam you already have. No new API at all. Cost: the cursor becomes versioned, revertible entity state, which it is not — and it would be pruned by retention.

Pick deliberately and record the reasoning. Whatever you choose, it must be implementable by the memory, patch, IndexedDB and SQLite stores alike, and it must not break the property ADR-0018 records and `packages/state-store-sqlite/test/no-platform-leakage.test.ts` pins: `@etherfold/state-store` declares NO dependencies, so a storage primitive that depends on the seam inherits nothing.

**3. The read handle cannot be the same handle.** `VersionedStateView` forwards `queryCurrent` / `queryAsOf`, which take caller-supplied SQL and exist only on the SQLite store. A neutral processor's handle can offer the seam tier — `getCurrent`, `getAsOf`, `listCurrent`, `listAsOf` — and must NOT pretend to offer the predicate tier. Do not stub it to throw; leave it off the type, so a consumer that needs SQL predicates is told at compile time that it is asking a backend-neutral handle for a backend-specific thing.

**What happens to `VersionedStateEventProcessor`.** It is published, and the honest end state is that it becomes a thin SQLite-flavoured convenience over the neutral one (construct the store from a `RemoteSQL`, keep the SQL-tier view, delegate the rest) rather than a second implementation of the same logic. Migrating existing consumers is explicitly not a constraint (the spec's Out of Scope), but two copies of revert-then-apply would be exactly the drift this spec exists to prevent.

## Acceptance criteria

- [ ] One processor definition, written once, runs under this component against the SQLite, memory, IndexedDB and patch stores, and produces the same state from the same input on all four.
- [ ] The sync cursor round-trips on every one of those backends: index, stop, reload from persisted state, continue, and land where a single uninterrupted run lands.
- [ ] Where the cursor lives is an explicit decision with its reasoning recorded, and it is implementable by all four backends. If it widened `StateStore`, the seam still declares no dependencies and `no-platform-leakage.test.ts` still passes.
- [ ] The backend-neutral read handle exposes the seam tier only. Asking it for `queryCurrent` / `queryAsOf` is a COMPILE error, not a runtime throw.
- [ ] `VersionedStateEventProcessor` still works and its existing tests still pass unchanged in meaning, and revert-then-apply exists ONCE rather than twice.
- [ ] Reorg is exercised on at least two backends through this component, including a counter that decreases.
- [ ] The stratagems conformance workload can be driven through this component (it currently drives the stores directly). If that turns out to be a bigger change than it looks, say so rather than forcing it.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset for every package whose public surface changed.

## Blocked by

- None. Everything it composes has landed.

## Prompt

> Build the backend-neutral `EventProcessor` for the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`): one component that indexes with an entity processor against ANY `StateStore`.
>
> FIRST read `work/specs/tasked/one-processor-everywhere.md` (user stories 1 and 12 are what this closes), then `packages/processor-sqlite/src/VersionedStateEventProcessor.ts`, `packages/processor-sqlite/src/sync.ts`, `packages/processor-sqlite/src/view.ts`, `packages/processor-entities/src/apply.ts` and ADR-0018.
>
> Know before you start that this is mostly an EXTRACTION. `runBlockHandlers` and `applyEventStream` in `processor-entities/src/apply.ts` already take a `StateStore` and already do revert-then-apply, read-your-writes and block grouping. What is SQLite-bound is the shell around them.
>
> Three bindings. The store is CONSTRUCTED from a `RemoteSQL` instead of injected: invert that, it is mechanical. The read handle forwards `queryCurrent` / `queryAsOf`, which are SQL-only: the neutral handle offers the seam tier and simply does not have those methods, so asking for them is a compile error rather than a runtime throw.
>
> The third is the real decision: the sync cursor is persisted in a SQL `_sync` table (`SYNC_SCHEMA_DDL`, a SELECT, an upsert, all through `this.db`). A browser on IndexedDB has no SQL to write it to. `serializeLastSync` / `deserializeLastSync` are already backend-neutral, so what has to move is the storage of one string under one key. Choose between widening `StateStore` with a small cursor port, a separate keeper the deployment supplies (the browser already has keeper idioms), or a reserved entity through the existing seam — and note that the last one makes the cursor versioned, revertible and prunable, which it is not. Record why you chose what you chose.
>
> Whatever you add must be implementable by memory, patch, IndexedDB and SQLite alike, and must keep `@etherfold/state-store` free of dependencies (ADR-0018, pinned by `no-platform-leakage.test.ts`).
>
> `VersionedStateEventProcessor` is published and must keep working, but it should become a thin SQLite-flavoured wrapper rather than a second copy of revert-then-apply. Two copies of that logic is the drift this whole spec exists to prevent.
>
> Done means: the same processor definition indexes to SQLite on a server and to IndexedDB in a browser, the cursor survives a reload on both, and nothing about the processor names a backend.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular where the sync cursor lives and what became of `VersionedStateEventProcessor`.

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

**The cursor goes behind the storage seam, as an OPAQUE STRING. That is decided; what follows is why, so you can push back if building it reveals something this cannot see.**

The seam gains a small cursor port: read, write and clear an opaque string under a context key. Every backend implements it, and on all four that is a handful of lines, because it is one key and one value.

**It must be an opaque string, never a typed `LastSync`.** `LastSync<ABI>` is a `@etherfold/core` type carrying `EventBlock<ABI>`, so typing the port with it would make `@etherfold/state-store` depend on core, invert ADR-0016's dependency direction and drag viem into every storage primitive — exactly what ADR-0018 records and `packages/state-store-sqlite/test/no-platform-leakage.test.ts` pins. This costs nothing, because `serializeLastSync` / `deserializeLastSync` in `packages/processor-sqlite/src/sync.ts` are already plain JSON with a bigint replacer and already backend-neutral. The store persists a string; only the processor knows what it means.

**The reason it is the seam and not a keeper is atomicity, and it fixes a live defect.** Only the store holds the transaction the block write happens in, so only the store can write the cursor in the SAME transaction as the block it describes. Today they are two round trips (`applyEventStream`, then a separate `this.db.batch` for the cursor), and `work/notes/observations/sync-cursor-write-is-not-atomic-with-the-block-it-describes.md` records what that costs: a crash in the window leaves state ahead of the cursor, restart replays an already-applied block, `applyBlock` refuses it as a caller bug, and the indexer wedges until a human intervenes. **So write the cursor in the same transaction as the block, and close that.** A backend that genuinely cannot do so (nothing here is known to be in that position) must say so rather than quietly reintroducing the gap.

The two rejected alternatives, recorded so they are not re-proposed:

- **A separate cursor keeper the deployment supplies.** Note this would NOT be the existing `KeepState`: that persists `AllData = {state, lastSync}`, state and cursor together, which is the free-form `JSObjectEventProcessor` model and wrong here, since the versioned store already owns the state and would end up storing it twice. It would therefore be a NEW narrower interface, costing a second thing to wire per deployment, a new way to misconfigure (a store pointed at one database and a cursor keeper at another, diverging in silence), and no atomicity.
- **A reserved entity through the existing seam.** No new API, but the cursor would become versioned, revertible and prunable entity state — and it must survive exactly the operations that would destroy it.

The honest cost of the chosen route is that the contract gains something that is not entity state, and every future backend inherits the obligation. The defence is that the store already records which blocks it holds, so "how far has this deployment got" is a question it half-answers already.

The conformance suite is where this becomes an obligation rather than a convention: a cursor round-trip, a clear, and — the one that matters — that the cursor a store reports after a block is the block it just applied, never one ahead of it.

**3. The read handle cannot be the same handle.** `VersionedStateView` forwards `queryCurrent` / `queryAsOf`, which take caller-supplied SQL and exist only on the SQLite store. A neutral processor's handle can offer the seam tier — `getCurrent`, `getAsOf`, `listCurrent`, `listAsOf` — and must NOT pretend to offer the predicate tier. Do not stub it to throw; leave it off the type, so a consumer that needs SQL predicates is told at compile time that it is asking a backend-neutral handle for a backend-specific thing.

**What happens to `VersionedStateEventProcessor`.** It is published, and the honest end state is that it becomes a thin SQLite-flavoured convenience over the neutral one (construct the store from a `RemoteSQL`, keep the SQL-tier view, delegate the rest) rather than a second implementation of the same logic. Migrating existing consumers is explicitly not a constraint (the spec's Out of Scope), but two copies of revert-then-apply would be exactly the drift this spec exists to prevent.

## Acceptance criteria

- [ ] One processor definition, written once, runs under this component against the SQLite, memory, IndexedDB and patch stores, and produces the same state from the same input on all four.
- [ ] The sync cursor round-trips on every one of those backends: index, stop, reload from persisted state, continue, and land where a single uninterrupted run lands.
- [ ] The cursor lives behind the seam as an opaque string; `@etherfold/state-store` still declares NO dependencies and `no-platform-leakage.test.ts` still passes. If you concluded during the build that this is the wrong home, route to needs-attention with what you found rather than silently choosing another.
- [ ] The cursor is written in the SAME transaction as the block it describes, on every backend that has transactions, and the conformance suite asserts a store never reports a cursor ahead of its last applied block.
- [ ] The crash window in `work/notes/observations/sync-cursor-write-is-not-atomic-with-the-block-it-describes.md` is closed on the SQLite path, and that observation is DELETED in the same change, because it will no longer be true.
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
> The third is the cursor, and its home is DECIDED: it goes behind the storage seam as a small port over an OPAQUE STRING (read / write / clear under a context key). It must be a string and never a typed `LastSync`, because `LastSync<ABI>` is a core type and typing the port with it would make `@etherfold/state-store` depend on core, invert ADR-0016 and pull viem into every storage primitive. `serializeLastSync` / `deserializeLastSync` already exist and are already neutral, so this costs nothing.
>
> Write the cursor in the SAME transaction as the block it describes. That is the reason it is the seam rather than a keeper: only the store holds that transaction. It also closes a live defect — read `work/notes/observations/sync-cursor-write-is-not-atomic-with-the-block-it-describes.md`, which records how the current two-round-trip ordering can wedge an indexer after a crash. Delete that note as part of this task, since it stops being true.
>
> A keeper and a reserved entity were both considered and rejected; the task body says why. If building it convinces you the seam is the wrong home, route to needs-attention with your reasoning rather than quietly picking another.
>
> `VersionedStateEventProcessor` is published and must keep working, but it should become a thin SQLite-flavoured wrapper rather than a second copy of revert-then-apply. Two copies of that logic is the drift this whole spec exists to prevent.
>
> Done means: the same processor definition indexes to SQLite on a server and to IndexedDB in a browser, the cursor survives a reload on both, and nothing about the processor names a backend.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular where the sync cursor lives and what became of `VersionedStateEventProcessor`.

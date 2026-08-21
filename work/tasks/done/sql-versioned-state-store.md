---
title: Versioned-row state store on remote-sql, with revertTo
slug: sql-versioned-state-store
spec: historical-state-database
blockedBy: []
covers: [4]
---

> Completed in `2a0cb96` (package) and `9d1daa8` (the naming ADR it forced), landed as `@ethereum-indexer/state-store-sqlite` in `packages/state-store-sqlite/`. `VersionedStateStore` exposes `migrate`, `applyBlock`, `applyBlocks`, `revertTo`, `getAsOf`, `queryAsOf`, `getCurrent`, `queryCurrent`, over `remote-sql` only. 6 vitest files, 47 tests, against real in-memory libSQL. Changeset `.changeset/sql-versioned-state-store.md` (minor, new package).

## What to build

The storage layer the whole server-side design rests on: entity state kept as **versioned rows with a half-open validity range**, on the `remote-sql` interface and nothing else, so it runs on local SQLite, libSQL/Turso and D1 alike.

An entity is declared as `{name, id, fields}` and the store owns everything else: it issues the DDL (entity tables are **dynamic**, since they come from what a processor declares, unlike the fixed tables which follow the repo's static-schema convention), writes versions, answers as-of reads, and reverts.

- **Write** is close-then-insert: close the live version by setting its upper bound to the current block, then insert the new one. A delete is just the close.
- **Read as of block N** is one predicate on the range columns; current state is the open-row special case, kept fast by a partial unique index that also enforces "exactly one live version per business key".
- **`revertTo(N)`** is DELETE versions opened above the fork, **then** re-open versions closed above it. The order is not interchangeable and must be covered by a test that fails in the other order.
- **One block is one `batch([...])`**: applying a block is a single atomic unit, since `remote-sql` exposes transactions only as `batch`.

Backend limits (D1 has per-request statement and size caps) are a **configurable chunk bound with a conservative default**, not a hardcoded assumption about one provider.

The design, including the rejected alternatives and the measured performance shapes, is `docs/design/historical-state-database.md`. A verified prototype exists outside this repo at `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db` (`example/src/historical-store.ts`); this task ports that model into a package with this repo's conventions rather than inventing it.

## Acceptance criteria

- [x] An entity declared as `{name, id, fields}` produces its table, its partial unique index on open rows, and the indexes the as-of and revert paths need, with no hand-written DDL from the caller. (`test/schema.test.ts`)
- [x] Reading as of a block returns the value that was live at that block, for a key with several versions, including at exact boundaries (the block a version opened, and the block it closed). (`test/as-of.test.ts`)
- [x] Two live versions of the same business key are impossible (the partial unique index rejects it). (`test/as-of.test.ts`, by hand-inserting a second open row)
- [x] `revertTo(N)` restores exactly the state as of N, and history strictly below the fork is untouched and still queryable afterwards. (`test/revert.test.ts`)
- [x] A test pins the DELETE-before-re-open ordering: performing it in the other order raises a unique-constraint violation. Both directions are asserted, so the ordering cannot be silently "cleaned up" later. (`test/revert-order.test.ts`; verified load-bearing by swapping the two statements in `src/statements.ts`, which turns 12 tests red)
- [x] Applying a block is one `batch` call, and a failure inside it leaves no partial block applied. (`test/batch.test.ts`, counting batches through a recording wrapper over the real DB and arming a failing statement at the tail)
- [x] The batch chunk bound is configurable, with a documented conservative default, and nothing in the package references D1 specifically. (`test/batch.test.ts`, `test/no-platform-leakage.test.ts`)
- [x] Tests run against real local SQLite/libSQL (not a mock), in the repo's vitest style. (in-memory libSQL via `remote-sql-libsql`)

## Blocked by

- None, can start immediately.

## Prompt

> Build the versioned-row state store for the `ethereum-indexer` monorepo, as a new package depending only on the `remote-sql` interface.
>
> FIRST, check this task against current reality: read `docs/design/historical-state-database.md` (the full design, with rationale and rejected alternatives) and `docs/adr/0003`, `0006`, `0010`. If something has landed that contradicts the premise here, route to needs-attention rather than building on it.
>
> The model: every entity version is a row with `_lower` (valid from, inclusive) and `_upper` (valid until, exclusive; `NULL` means live). Writes are close-then-insert. Reading as of block N is `_lower <= N AND (_upper IS NULL OR N < _upper)`. Current state is `_upper IS NULL`, made fast by a **partial unique index on open rows**, which also enforces the one-live-version-per-key invariant that SQLite cannot express as a real constraint. Entity tables are created dynamically from `{name, id, fields}` declarations, because they come from whatever the processor declares; the repo's static `.sql` schema convention applies only to fixed tables.
>
> `revertTo(N)`: DELETE versions with `_lower > N`, THEN re-open versions with `_upper > N`. This order is mandatory and non-obvious: SQLite enforces the partial unique index per statement with no deferred mode, so re-opening first collides with the dead-branch row that is still present. The reference prototype caught this by running it. Pin both directions in tests so a future refactor cannot silently swap them.
>
> Use `remote-sql` only. Applying a block must be exactly one `batch([...])`, which is the atomicity boundary and the round-trip boundary (on remote backends, latency dominates, not SQLite work). Backend statement and size limits must be a configurable chunking bound with a conservative default; do not hardcode D1's numbers or name D1 in the package.
>
> A verified prototype of this model, with benchmarks, is at `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db` (see `example/src/historical-store.ts` and the topic README). Port it to this repo's conventions (vitest in `test/`, named-logs for logging, a changeset for the new package) rather than redesigning. Test against real local SQLite/libSQL, never a mock. Do not commit without confirmation.

## Decisions

Non-obvious choices the task did not specify, transcribed from the builder's final report.

1. **Package `@ethereum-indexer/state-store-sqlite`, directory `packages/state-store-sqlite/`.** Escalated to ADR-0014, since it sets a scheme for every future package, not just this one. The two sub-decisions that ADR pins: the backend is named rather than abstracted as `sql` (a Postgres store would be a sibling package, per design §8, so claiming `sql` would force a rename later), and `state` stays in the name because ADR-0006 commits the server to two stores.
2. **A block that alone exceeds the batch bound is still sent as one batch, with a warning.** Splitting would trade atomicity, a correctness property, for a throughput knob, and leave a half-applied block on failure. Noted in `src/batching.ts` and the README.
3. **`migrate()` is chunked but not atomic.** All DDL is `IF NOT EXISTS`, so re-running converges; noted on `migrationStatements`.
4. **The block row is a plain `INSERT`, not an upsert.** Applying the same block twice is a caller bug, and a primary-key violation says so immediately instead of silently double-writing versions. Noted on `applyBlockStatements`.
5. **Entity declarations are validated at declaration time** (identifier regex, `_` reserved for the store). Deviation from the prototype, which interpolated names it wrote itself; here they arrive from a processor and SQL cannot bind an identifier as a parameter.
6. **Block addressing by hash and timestamp is deliberately absent.** It belongs to `block-addressing-hash-height-time`, which is blocked on this. This package writes and prunes `_blocks` and reads by number, so that task widens a parameter rather than rewriting anything.

# @ethereum-indexer/state-store-sqlite

Entity state kept as **versioned rows with a half-open block-validity range**, on the [`remote-sql`](https://github.com/wighawag/remote-sql) interface and nothing else, so the same code runs on a local SQLite file, on libSQL/Turso, and on hosted SQLite reached over HTTP.

The design, with the rejected alternatives and the measured performance shapes, is `docs/design/historical-state-database.md` in this repo. This package is the storage layer that design rests on.

## The model

Every version of every entity is a row carrying `_lower` (valid from, inclusive) and `_upper` (valid until, exclusive; `NULL` means live). The current value is never stored on its own.

- **Write** is close-then-insert: `UPDATE ... SET _upper = N` on the live version, then `INSERT ... (_lower = N)`. A delete is just the close.
- **Read as of block N** is one predicate: `_lower <= N AND (_upper IS NULL OR N < _upper)`.
- **Current state** is the open-row special case `_upper IS NULL`, kept fast by a partial unique index that also enforces "exactly one live version per business key" — the invariant SQLite cannot express as a real constraint.
- **`revertTo(N)`** is `DELETE` versions opened above the fork, **then** re-open versions closed above it.

An author declares only `{name, id, fields}`; the store owns the DDL, the version columns, the as-of rewrite and the revert. History falls out of a declaration instead of being re-implemented by every processor.

## Usage

```ts
import {VersionedStateStore} from '@ethereum-indexer/state-store-sqlite';

const store = new VersionedStateStore(db /* a RemoteSQL */, [
	{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}},
]);

await store.migrate();

// one block is one atomic batch
await store.applyBlock({number: 100, hash: '0xaa', parentHash: '0x99', timestamp: 1_700_000_000}, [
	{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xAlice', transferCount: 1}},
]);

await store.getAsOf('token', {id: '1'}, 100); // who owned it at block 100
await store.getCurrent('token', {id: '1'}); // who owns it at the tip
await store.revertTo(99); // a reorg forked at 99
```

Reading state as of a block **hash** or a **timestamp** resolves to a block number through the canonical `_blocks` table this package writes, and is layered on top of these reads rather than being part of them.

## Things that are load-bearing

**`revertTo` deletes before it re-opens, and the order is not interchangeable.** SQLite enforces the partial unique index per statement, with no deferred mode. Re-opening first makes the re-opened row and the still-present dead-branch row both open for the same business key, which is a `SQLITE_CONSTRAINT_UNIQUE`. `test/revert-order.test.ts` asserts both directions, against a real SQLite engine, so that the failing order stays documented by an executable test rather than by a comment someone can delete.

**Applying a block is exactly one `batch([...])`.** `remote-sql` exposes a transaction only as a batch, so that one call is both the atomicity boundary (a failure anywhere leaves no part of the block applied) and the round-trip boundary (on a remote backend, latency dominates, not SQLite work). `applyBlocks` packs several blocks into one batch for backfill, and never splits a block across two.

**Backend limits are configuration, not constants.** Backends reached over the network cap statements and payload size per request, differently per backend and per plan. `DEFAULT_BATCH_BOUNDS` is deliberately conservative (100 statements, ~90 KB) so the default is safe everywhere; raise it via `{bounds}` on a local database. A single block that alone exceeds the bound is still sent as one batch, with a warning: splitting it would trade a correctness property for a tuning parameter.

**Fixed schema vs dynamic schema.** The repo's convention is static `.sql` schema files. That holds for fixed tables, and `_blocks` is one. It cannot hold for entity tables, whose columns are whatever a processor declares at run time, so their DDL is generated. The exception is contained in `src/ddl.ts`, which is the only module that emits DDL, and every interpolated identifier is validated first (`src/internal/identifiers.ts`), since SQL cannot bind an identifier as a parameter.

## Deviations from the reference prototype

This package ports a verified prototype (`~/dev/github/wighawag/research/ethereum-indexer-historical-state-db`, `example/src/historical-store.ts`) rather than inventing a model. The model is unchanged; these are the deliberate differences.

- **Named `VersionedStateStore`, not `HistoricalStore`.** "Versioned state" is the vocabulary the ADRs and `CONTEXT.md` use for the thing this stores; "historical state" names the whole feature, spec and design.
- **Declarations are validated.** The prototype interpolated table and field names straight into SQL, which was safe for its own hand-written declaration. Here they arrive from whatever a processor declares, so identifiers are checked once, at declaration time, and the `_` namespace is reserved for the store.
- **Statements are built as data, then prepared.** The prototype prepared statements as it went. Building `{sql, args}` first is what lets the batch bound count and size a batch before sending it, and lets a test assert the ordering inside `revertTo` instead of trusting a comment.
- **The batch bound and `applyBlocks` are new.** The prototype was one block per batch with no limits; the design calls for packing many blocks per batch under a configurable bound.
- **Block addressing is not here.** The prototype's `resolveBlock` (hash and timestamp to a block number) belongs to the block-addressing work, which layers on top of the range predicate. This package writes the canonical `_blocks` rows and prunes them on revert, and reads by block number.
- **`id` may be a single string.** `{id: 'id'}` and `{id: ['id']}` both work; composite keys behave as in the prototype.

## Tests

`pnpm --filter @ethereum-indexer/state-store-sqlite test`, vitest, against a real in-memory libSQL database. Never a mock: the ordering rule above is a property of how SQLite enforces a partial index, and a fake would accept the broken order happily.

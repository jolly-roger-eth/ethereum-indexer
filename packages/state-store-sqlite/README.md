# @etherfold/state-store-sqlite

Entity state kept as **versioned rows with a half-open block-validity range**, on the [`remote-sql`](https://github.com/wighawag/remote-sql) interface and nothing else, so the same code runs on a local SQLite file, on libSQL/Turso, and on hosted SQLite reached over HTTP.

The design, with the rejected alternatives and the measured performance shapes, is `docs/design/historical-state-database.md` in this repo. This package is the storage layer that design rests on.

## The model

Every version of every entity is a row carrying `_lower` (valid from, inclusive) and `_upper` (valid until, exclusive; `NULL` means live). The current value is never stored on its own.

- **Write** is close-then-insert: `UPDATE ... SET _upper = N` on the live version, then `INSERT ... (_lower = N)`. A delete is just the close.
- **Read as of block N** is one predicate: `_lower <= N AND (_upper IS NULL OR N < _upper)`.
- **Current state** is the open-row special case `_upper IS NULL`, kept fast by a partial unique index that also enforces "exactly one live version per business key" — the invariant SQLite cannot express as a real constraint.
- **`revertTo(N)`** is `DELETE` versions opened above the fork, **then** re-open versions closed above it.

An author declares only `{name, id, fields}`; the store owns the DDL, the version columns, the as-of rewrite and the revert. History falls out of a declaration instead of being re-implemented by every processor.

## One implementation of the seam

This is a `StateStore` ([`@etherfold/state-store`](../state-store)), which is the backend-neutral contract a processor is written against: `migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`, plus the capabilities it declares. The declaration, mutation and block-pointer types are the seam's and are re-exported here, so a processor hands this store exactly what it would hand any other backend.

Everything below those five verbs is this backend's own and deliberately NOT at the seam: block addressing by hash and by time, and the `queryCurrent` / `queryAsOf` surface that takes caller-supplied SQL. A server has a query planner; a handler, running once per event on every backend, does not.

`store.capabilities` reports `{retention: {kind: 'unbounded'}, asOf: true}`, and `unbounded` is the honest report rather than an aspiration: this package has no pruning, so every version ever written is still here. It takes no retention option on purpose, because a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

## Usage

```ts
import {VersionedStateStore} from '@etherfold/state-store-sqlite';

const store = new VersionedStateStore(db /* a RemoteSQL */, [
	{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}},
]);

await store.migrate();

// one block is one atomic batch
await store.applyBlock({number: 100, hash: '0xaa', timestamp: 1_700_000_000}, [
	{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xAlice', transferCount: 1}},
]);

await store.getAsOf('token', {id: '1'}, 100); // who owned it at block 100
await store.getAsOf('token', {id: '1'}, {hash: '0xaa'}); // ...at that block hash
await store.getAsOf('token', {id: '1'}, {timestamp: 1_700_000_000}); // ...at that instant
await store.getCurrent('token', {id: '1'}); // who owns it at the tip
await store.revertTo(99); // a reorg forked at 99
```

## Addressing state: hash, height, or time

All three axes resolve to a block number through the canonical `_blocks` table, and then run the one as-of predicate, so they answer identically when they identify the same block. There is one addressing mechanism, not three.

- **hash** is the reorg-proof identifier, and **the one consumers should store**. Pin a *height* and a reorg silently changes what "state at 18,000,123" means: the read still succeeds and quietly answers about a different chain. Pin the *hash* and the same reorg answers "no such block", which is itself the signal that whatever was derived from it is invalid.
- **height** resolves to itself, with no lookup.
- **timestamp** is the latest recorded block with `timestamp <= T`; before the first recorded block it resolves to nothing, never to the first block.

**"No such block" is a distinct answer from "block known, entity absent."** `undefined` keeps its ordinary meaning (the block is known, the entity was not there), and an address that identifies no block throws `NoSuchBlockError` carrying a `reason`. `resolveBlockNumber(address)` is the soft form for callers that want to branch instead of catch, and `getBlock(address)` hands back the recorded row so a consumer can turn a time or a height into the hash it should pin. The reasoning and the rejected alternatives are `docs/adr/0015`.

**`_blocks` holds rows only for blocks that carry our logs**, not every chain header: state only changes at blocks where our events occur, so the latest recorded block at or before T holds exactly the state the true block at T held, and a consumer only ever pins a hash it saw on a log we delivered. Storing every header would be tens of millions of rows for no additional answer. Which blocks those are is **the caller's judgement**: every block handed to `applyBlock` gets a row, including one with no mutations, because "carries our logs" is not "produces a state mutation" and the hash of a log that changed nothing is still pinnable.

`blockTimestamp` comes off the log itself (standardised in `execution-apis#639`), so time addressing needs no extra round-trip. It arrives 0x-prefixed hex from most clients and decimal from at least one, so ingestion normalises it once with `normalizeBlockTimestamp`; the prefix is the only signal, since `'1705375936'` is a valid hex string too and the two readings are millennia apart.

## Things that are load-bearing

**`revertTo` deletes before it re-opens, and the order is not interchangeable.** SQLite enforces the partial unique index per statement, with no deferred mode. Re-opening first makes the re-opened row and the still-present dead-branch row both open for the same business key, which is a `SQLITE_CONSTRAINT_UNIQUE`. `test/revert-order.test.ts` asserts both directions, against a real SQLite engine, so that the failing order stays documented by an executable test rather than by a comment someone can delete.

**Applying a block is exactly one `batch([...])`.** `remote-sql` exposes a transaction only as a batch, so that one call is both the atomicity boundary (a failure anywhere leaves no part of the block applied) and the round-trip boundary (on a remote backend, latency dominates, not SQLite work). `applyBlocks` packs several blocks into one batch for backfill, and never splits a block across two.

**Backend limits are configuration, not constants.** Backends reached over the network cap statements and payload size per request, differently per backend and per plan. `DEFAULT_BATCH_BOUNDS` is deliberately conservative (100 statements, ~90 KB) so the default is safe everywhere; raise it via `{bounds}` on a local database. A single block that alone exceeds the bound is still sent as one batch, with a warning: splitting it would trade a correctness property for a tuning parameter.

**Fixed schema vs dynamic schema.** The repo's convention is static `.sql` schema files. That holds for fixed tables, and `_blocks` is one. It cannot hold for entity tables, whose columns are whatever a processor declares at run time, so their DDL is generated. The exception is contained in `src/ddl.ts`, which is the only module that emits DDL, and every interpolated identifier is validated first, since SQL cannot bind an identifier as a parameter. That validation now lives at the seam (`normalizeEntity` in `@etherfold/state-store`) and applies to every backend, so "this declaration is valid" is a fact about the declaration rather than about the deployment.

## Deviations from the reference prototype

This package ports a verified prototype (`~/dev/github/wighawag/research/ethereum-indexer-historical-state-db`, `example/src/historical-store.ts`) rather than inventing a model. The model is unchanged; these are the deliberate differences.

- **Named `VersionedStateStore`, not `HistoricalStore`.** "Versioned state" is the vocabulary the ADRs and `CONTEXT.md` use for the thing this stores; "historical state" names the whole feature, spec and design.
- **Declarations are validated.** The prototype interpolated table and field names straight into SQL, which was safe for its own hand-written declaration. Here they arrive from whatever a processor declares, so identifiers are checked once, at declaration time (at the seam, for every backend), and the `_` namespace is reserved for the store.
- **Statements are built as data, then prepared.** The prototype prepared statements as it went. Building `{sql, args}` first is what lets the batch bound count and size a batch before sending it, and lets a test assert the ordering inside `revertTo` instead of trusting a comment.
- **The batch bound and `applyBlocks` are new.** The prototype was one block per batch with no limits; the design calls for packing many blocks per batch under a configurable bound.
- **An unresolvable address throws, and hashes are case-folded.** The prototype's `resolveBlock` returned a number or nothing, and the caller decided what that meant. Here "no such block" is a `NoSuchBlockError` on the read path so it cannot be mistaken for an absent entity (`docs/adr/0015`), and block hashes are stored and looked up lower-cased so an echoed-back upper-case hash cannot masquerade as a reorg.
- **`id` may be a single string.** `{id: 'id'}` and `{id: ['id']}` both work; composite keys behave as in the prototype.

## Tests

`pnpm --filter @etherfold/state-store-sqlite test`, vitest, against a real in-memory libSQL database. Never a mock: the ordering rule above is a property of how SQLite enforces a partial index, and a fake would accept the broken order happily.

The cases that are the SEAM's rather than this backend's (versioned reads, as-of reads against the declared capabilities, reorg revert with a counter that must go back down, read-your-writes, block atomicity) are not written here: `test/conformance.test.ts` runs the shared suite, [`@etherfold/state-store-conformance`](../state-store-conformance), against this store under three retention claims. What stays in this package's own tests is what only a versioned-row backend can be asked: the partial unique index, the batch, the `revertTo` ordering, the DDL, the block addressing, and the SQL query surface.

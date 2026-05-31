# Plan: Historical-state database (query state at block hash / height / time)

**Area:** new server-side indexer architecture (log-watcher + log-processor) / design
**Type:** Planning (produce a design document, not an implementation)
**Status:** todo

## Context

Today the indexer computes a single "current" state. The maintainer wants a proper database
implementation that **keeps track of historical state**, so that the state can be queried as of:

- a specific **block hash**, and/or
- a specific **block height**, and/or
- a specific **time** (timestamp)

…depending on how feasible each is to implement. Time-based querying in particular depends on having
block timestamps available (note the core indexer can optionally fetch timestamps via
`alwaysFetchTimestamps`, but the README documents that timestamps are NOT generally available from
`eth_getLogs`, which constrains the design — call this out).

This builds on existing pieces worth studying first:
- The reorg model in `packages/ethereum-indexer/src/internal/engine/utils.ts` (`generateStreamToAppend`,
  unconfirmed blocks, finality).
- `RevertableDatabase` in `packages/ethereum-indexer-db-processors` (server-side revert/replay) — the
  closest existing thing to versioned/historical writes.
- The `LastSync` / `EventBlock` / `LogEvent` types in `packages/ethereum-indexer/src/types.ts`.
- `EventCache` / `keepStream` in `packages/ethereum-indexer-db-utils` (cached event stream).

## Architecture direction (maintainer decision)

For the **database-based** (server) indexer — as opposed to the in-browser one — the maintainer wants
to split it into two cooperating components:

1. **log-watcher**
   - Watches the chain and produces the log/event stream (this is the fetch + reorg-detection side,
     i.e. what the core `EthereumIndexer` engine already does for fetching).
   - **Not public-facing**; can run anywhere (its own box, a container, a long-running process).
   - Pushes the log stream to the log-processor over an **authenticated HTTP API**.
   - Must convey enough for the processor to handle reorgs (e.g. `removed`/reorged events,
     block hashes, the `LastSync`/unconfirmed-block info, finality) — the design must specify the
     exact wire contract and how reorgs are signalled across the HTTP boundary.

2. **log-processor**
   - Receives the stream from the watcher (authenticated), runs the processor logic, and **owns the
     database** (including the historical state).
   - Provides the **query API** (state at block hash / height / time) to external consumers.
   - Intended to be deployable as a **serverless worker** (e.g. a Cloudflare Worker) — so the design
     must respect serverless constraints: statelessness between requests, execution time/size limits,
     no long-lived in-memory state, idempotent/at-least-once delivery from the watcher, etc.

**Database / storage:** use the **`remote-sql`** npm package, which targets **Cloudflare D1** or
**SQLite** (it expects SQLite semantics). So the data model and queries must be expressible in SQLite
/ D1 (mind D1's constraints: SQLite dialect, statement/size limits, no extensions, batching). This
makes range-query-friendly schemas (e.g. per-key validity ranges `[fromBlock, toBlock)`) attractive
vs. replay-on-read.

The design doc must treat this watcher/processor split + serverless + `remote-sql`/D1/SQLite as the
target architecture (while still noting trade-offs/alternatives where relevant).

## Goal of this task

Produce a **design document** (e.g. `docs/design/historical-state-database.md` or similar) — NOT an
implementation. The plan should cover:

1. **Requirements & scope** — which query axes (hash / height / time) are in scope for a first version,
   and which are deferred. Justify based on feasibility (esp. time, given timestamp availability).
2. **Data model options** — compare approaches for storing history, e.g.:
   - append-only event log + on-demand replay to a target block,
   - per-key versioned rows (validity ranges: `[fromBlock, toBlock)`),
   - copy-on-write snapshots / checkpoints, or a hybrid.
   Discuss storage cost, write amplification, and query complexity for each.
3. **Reorg handling** — how historical rows are invalidated/rewritten when an unconfirmed block is
   reorged out; interaction with the finality window; how "confirmed" history differs from
   "unconfirmed/speculative" history.
4. **Query semantics** — exact meaning of "state at block N / hash H / time T", behaviour for
   not-yet-indexed or reorged targets, and consistency guarantees.
5. **API sketch** — proposed query interface and how it fits the existing processor / `KeepState` /
   `ExistingStream` abstractions in the core package.
6. **Backend & schema (SQLite / D1 via `remote-sql`)** — concrete SQLite/D1 schema for historical
   state and sync metadata, working within D1 constraints (SQLite dialect, statement/size/time limits,
   batching, no extensions). Favour range-query-friendly designs (per-key validity ranges) given the
   query axes. Show example queries for "state at height N" and "state at hash H".
7. **Watcher ↔ processor protocol** — the authenticated HTTP API contract: endpoints, payload shape
   for the event stream, how reorgs/`removed` events and `LastSync`/unconfirmed-block info are
   transmitted, auth mechanism, delivery semantics (at-least-once?), idempotency/dedup on the
   processor side, and backpressure/resumption after the processor was unavailable.
8. **Serverless considerations (log-processor)** — how to run the processor as a Cloudflare Worker:
   handling execution-time/size limits, no long-lived memory, transactional/batched writes to D1,
   and how the (stateless) worker reconstructs context per request.
9. **Component boundaries & reuse** — what the log-watcher reuses from the existing core
   `EthereumIndexer` (fetching + reorg detection) vs. what is new; whether watcher and processor are
   new packages.
10. **Migration / compatibility** — relationship to existing `EventProcessorOnDatabase` /
    `RevertableDatabase` and the `KeepState`/`ExistingStream` abstractions; new package vs. evolution.
11. **Phased implementation plan** — milestones with the smallest useful first version, plus the test
    strategy (mirroring the vitest approach used in `packages/ethereum-indexer/test`; consider how to
    test against SQLite locally vs. D1).

## Constraints / conventions

- This task is **planning only** — deliver a markdown design doc and discuss trade-offs; do not start
  implementing.
- Should be done in a **fresh context**.

## Prompt (paste into a fresh context)

> I want to plan (design only — no implementation yet) a proper **server-side** database
> implementation for the `ethereum-indexer` monorepo that keeps **historical state**, so consumers can
> query the computed state as of a specific block hash, block height, or timestamp (whichever are
> feasible — note timestamps are not generally available from `eth_getLogs`, see the core README, so
> call out that constraint).
>
> Target architecture (my decision): split the server indexer into a **log-watcher** and a
> **log-processor**. The log-watcher watches the chain and produces the log/event stream (reusing the
> core engine's fetch + reorg detection), is NOT public-facing, can run anywhere, and pushes the
> stream to the processor over an **authenticated HTTP API**. The log-processor receives that stream,
> owns the database (including historical state), and serves the query API; it should be deployable as
> a **serverless worker (e.g. Cloudflare Worker)**. For storage use the **`remote-sql`** npm package,
> which targets **Cloudflare D1 or SQLite** (SQLite semantics), so the schema/queries must fit
> SQLite/D1 constraints.
>
> Study the existing reorg model in `packages/ethereum-indexer/src/internal/engine/utils.ts`, the
> `LastSync`/`EventBlock`/`LogEvent` types in `packages/ethereum-indexer/src/types.ts`,
> `RevertableDatabase` in `packages/ethereum-indexer-db-processors`, and the `EventCache`/`keepStream`
> mechanism in `packages/ethereum-indexer-db-utils`. Then produce a design document covering:
> requirements & scope (query axes for v1); data-model options (append-only replay vs. per-key
> validity ranges vs. snapshots/checkpoints vs. hybrid) with trade-offs, expressed in SQLite/D1;
> reorg handling and finality interaction; exact query semantics; the watcher↔processor authenticated
> HTTP protocol (payload shape, how reorgs/`removed`+`LastSync` are transmitted, auth, delivery
> semantics, idempotency, resumption/backpressure); serverless constraints for the processor on
> Cloudflare Workers + D1; component boundaries/reuse (what the watcher reuses from the core engine);
> migration/compatibility with existing processors and the `KeepState`/`ExistingStream` abstractions;
> and a phased implementation plan with a test strategy (testing against local SQLite vs. D1). Deliver
> it as a markdown file under `docs/design/` and do not start implementing.

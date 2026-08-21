---
title: Historical-state database (query state at block hash / height / time)
slug: historical-state-database
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked — they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

> **PARTLY SUPERSEDED. Read `docs/adr/0003` through `docs/adr/0008` first.** A design session revisited this spec's architecture. Three deltas, so the text below is not current truth:
>
> - **Component split (ADR-0003).** The watcher is now a *stateless* **log-fetcher** (chain calls only). Reorg detection and the event stream move to a **stream-builder** hosted with the processor in the **indexer-server**. "Processor" stays reserved for the existing `EventProcessor` reducer.
> - **User story 5 is reversed (ADR-0004).** The fetcher does **not** push `removed` markers or `unconfirmedBlocks`. The wire carries raw logs plus `{context, fromBlock, toBlock, latestBlock}`; the receiver derives all reorg information and is authoritative about the cursor. Open question 4 is answered there.
> - **Scope grew (ADR-0006).** The indexer-server also stores the emission stream and serves it as a feed, not only state queries. This is what lets trigger consumers live outside it (ADR-0005).
>
> Unchanged: state conditions are still read **as of the triggering log's block** by block hash, which is why this spec still lands first.
>
> **The design this spec asked for now exists: `docs/design/historical-state-database.md`.** All six open questions are answered (1, 2, 3 and 5 in the design doc; 4 in ADR-0004; 6 in ADR-0010), so the `needsAnswers` gate is cleared and the transient block is stripped. Next step is tasking the build, not more design.

## Problem Statement

Today the indexer computes a single "current" state. The maintainer wants a proper database implementation that keeps **historical state**, so a separate service can query the computed state as of a specific **block hash**, **block height**, and/or **time** — with correct reorg handling — while running on the `remote-sql` interface (Cloudflare D1 / Turso/libSQL / local SQLite).

## Solution

A server-side indexer split into two cooperating components, storing state in a versioned-rows / valid-block-range model so time-travel queries fall out of a single indexed range predicate:

- **log-watcher** — watches the chain, produces the log/event stream (reusing the core engine's fetch + reorg detection), not public-facing, pushes the stream to the processor over an authenticated HTTP API.
- **log-processor** — receives the stream, owns the database (including historical state), serves the query API (state at hash/height/time), deployable as a serverless worker (e.g. Cloudflare Worker).

Reorg at the DB layer = `revertTo(blockNumber)` then re-apply — the DB-level mirror of the indexer's existing revert-and-reapply. The revert-and-reapply contract this MUST mirror is pinned by `packages/ethereum-indexer-js-processor/test/reorg.test.ts` (live path) and `packages/ethereum-indexer/test/utils.test.ts` (`generateStreamToAppend`).

## User Stories

1. As a downstream service, I want to query the indexed state as of a block **hash**, so that a reorged-out block correctly returns "no such block" rather than silently changed data.
2. As a downstream service, I want to query state as of a block **height**, so that I can read finalized history ergonomically.
3. As a downstream service, I want to query state as of a **timestamp** (latest block ≤ T), so that I can answer "state around time T".
4. As the indexer, I want a `revertTo(N)` that reverts versioned rows on reorg and re-applies the canonical branch, so that historical state stays correct through reorgs.
5. As an operator, I want the log-watcher to push the stream (incl. reorg/`removed` + `LastSync`/unconfirmed-block info) to the processor over an authenticated HTTP API with at-least-once + idempotency, so that delivery is reliable and resumable.
6. As an operator, I want the log-processor to run as a serverless worker against `remote-sql`/D1, so that it deploys on the edge within D1 constraints.
7. ~~As a maintainer, I want the design to state whether `ethereum-indexer-db-processors` is deleted or evolved, so that the old prototype does not linger as a second source of truth.~~ **DONE:** deleted, see `docs/adr/0010`.

## Implementation Decisions

- Target architecture (maintainer decision): the **log-watcher / log-processor split**; storage via `remote-sql` (D1 / Turso / SQLite); versioned-rows data model favoured over replay-on-read.
- Prior art to study first (already reviewed in `docs/reviews/`): `RevertableDatabase` (the closest existing prototype of validity-range history — see `docs/reviews/revertable-database.md`), `EventCache`/`keepStream` (`docs/reviews/event-cache.md`), and the existing TODOs (`docs/reviews/todo-triage.md`).
- Runnable, verified research example lives outside this repo at `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db/` (versioned-rows + reorg proof on real libSQL).

> Trimmed at tasking-time: this detail moves into the tasks (what to build) and, where it's a durable rationale, into an ADR (`docs/adr/`).

## Testing Decisions

- The new SQLite `revertTo(N)` MUST be checked against the revert contract pinned in `packages/ethereum-indexer-js-processor/test/reorg.test.ts` and `packages/ethereum-indexer/test/utils.test.ts` (single-block reorg restores end-of-prior-block state; below-finality events are not revertable).
- Test the store against local SQLite/libSQL (the dialect D1/Turso run), including a reorg-then-replay assertion that pre-fork history stays intact.

## Out of Scope

- Implementation. This spec's first output is the DESIGN DOCUMENT (`docs/design/historical-state-database.md`); building follows once tasked.
- The trigger system that consumes this (separate spec `trigger-system`, `taskedAfter` this one).

## Further Notes

- This spec supersedes the old ad-hoc plan `tasks/plan-historical-state-database.md`.
- Related deferred architecture deepenings (from the architecture review) are NOT part of this spec: splitting the `EthereumIndexer` god class, a processor-lifecycle base, unifying storage adapters. Consider them only once this store's interface needs are known.

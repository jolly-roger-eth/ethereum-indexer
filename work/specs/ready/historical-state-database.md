---
title: Historical-state database (query state at block hash / height / time)
slug: historical-state-database
needsAnswers: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked — they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
  This spec is a DESIGN task (produce the design doc), so its open questions ARE the
  design decisions to make. It is flagged needsAnswers so it is not auto-tasked before
  the design lands. Clear the flag + delete this block once the design doc exists.
-->

## Open questions

1. Which query axes (block hash / height / time) are in scope for v1, and which are deferred (justify by feasibility — esp. time, given block-timestamp availability)?
2. Data model: versioned-rows / valid-block-range (`_lower/_upper`) vs. append-only replay vs. snapshots vs. hybrid — confirm the versioned-rows choice and its retention policy.
3. Reorg semantics at the DB layer: confirm `revertTo(N)` (DELETE opened-above-fork, re-open closed-above-fork) and the DELETE-before-re-open ordering; how it mirrors the indexer's existing revert-and-reapply.
4. Watcher ↔ processor wire contract: how `removed`/reorg + `LastSync`/unconfirmed-block info cross the authenticated HTTP boundary; delivery semantics (at-least-once?), idempotency, resumption.
5. Serverless (Cloudflare Worker) constraints for the log-processor; `remote-sql` / D1 / SQLite schema within D1 limits.
6. Migration: is `ethereum-indexer-db-processors` (`EventProcessorOnDatabase` / `RevertableDatabase`) DELETED or EVOLVED once this lands? (This spec's design owns that decision.)

<!-- /open-questions -->

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
7. As a maintainer, I want the design to state whether `ethereum-indexer-db-processors` is deleted or evolved, so that the old prototype does not linger as a second source of truth.

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

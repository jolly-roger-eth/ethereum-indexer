---
title: Indexer-server log feed (stored stream, two views, rebuilds)
slug: indexer-server-feed
taskedAfter: [historical-state-database]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> Split out of `historical-state-database` at tasking time. That spec's user stories cover state queries, the ingestion wire and running serverlessly. The scope here (storing the log stream and serving it as a feed, and rebuilding state on a processor upgrade) arrived later, via `docs/adr/0006` and `docs/adr/0008`, and is not covered by any of its stories. Tasking is atomic per spec, so this scope becomes its own spec rather than being smuggled into that one.

## Problem Statement

Consumers that react to chain events (notification services, reward systems, third-party integrations) need an ordered, resumable log feed they can follow without running their own chain infrastructure, and without the indexer-server knowing anything about them. Separately, when a processor's logic changes, its derived state must be rebuilt from scratch while the old state keeps being served, and re-fetching the entire history from the chain to do so is unacceptable.

Both needs are met by the same thing: the indexer-server keeping the log stream it already receives.

## Solution

The indexer-server stores the **emission stream** (append-only, retractions included, superseded rows flagged) and serves two views over it: the full `seq`-ordered stream for retraction-aware real-time consumers, and a canonical gated view (`alive`, bounded by a caller-supplied block gate, ordered by block and log index) for consumers that never want to handle a reorg.

Because the stream is stored locally and keyed independently of the processor version, a processor-logic upgrade rebuilds state by replaying that local stream into a new namespace, blue-green, while the old namespace keeps serving until a pointer flip.

## User Stories

1. As a consumer, I want to follow an ordered log feed from a cursor I control, so that I can resume after downtime without re-reading everything.
2. As a real-time consumer, I want the retraction-aware stream (including `removed` entries) with a monotonic `seq` cursor, so that I can act optimistically and cancel a pending action when a reorg retracts it.
3. As a simple consumer, I want a canonical view bounded by my own gate, with no retractions in it, so that my entire sync state is one advancing position and I never implement reorg handling.
4. As a consumer of the canonical view, I want my cursor validated against the block hash I last saw, so that a reorg tells me to rewind instead of silently skipping the events I never received.
5. As a consumer, I want cursor semantics that permit holes in `seq`, so that enabling stream compaction later cannot break me.
6. As an operator, I want the stream stored append-only with superseded rows flagged, so that no retraction information is ever destroyed and the canonical view stays a cheap derived read.
7. As an operator, I want optional pair-compaction (dropping a retracted entry together with its retraction, far below finality) as an off-by-default config, so that noise can be reclaimed deliberately and never by accident.
8. As an operator, I want the log table's `address` and `topic0..topic3` stored as indexed columns, so that a node-compatible `eth_getLogs` API is possible later without migrating the whole table.
9. As a maintainer, I want a processor-logic upgrade to rebuild state from the locally stored stream rather than from the chain, so that upgrades cost a local scan instead of a full re-index.
10. As a maintainer, I want the rebuild to run in bounded chunks against a durable checkpoint, so that it completes on a serverless host that cannot hold a long-running loop.
11. As an operator, I want the old state served throughout a rebuild and switched atomically at the end, so that readers never observe partial state and a rollback before the switch is free.

## Out of Scope

- The state store, the ingestion wire and the host adapters, all covered by `historical-state-database`.
- The `eth_getLogs` API itself (`work/specs/proposed/node-log-api.md`); this spec only owes it the schema it depends on.
- Trigger evaluation and delivery, which live entirely outside the indexer-server (`docs/adr/0005`).

## Further Notes

- The decisions are already made and recorded: `docs/adr/0006` (store emissions, derive the canonical view, cursor semantics, compaction) and `docs/adr/0008` (blue-green rebuild, chunked replay, why `getVersionHash` became load-bearing).
- Story 4's rewind response has a proof worth keeping in mind while building: a reorg invalidates a contiguous suffix, so validating the single block at the cursor certifies the whole prefix behind it.
- Related and already tasked: `work/tasks/ready/processor-version-hash-cannot-silently-lie.md`, which protects the trigger for story 9. If that hash lies, the rebuild never runs.

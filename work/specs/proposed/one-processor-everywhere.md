---
title: 'One processor, everywhere: a storage seam with explicit retention'
slug: one-processor-everywhere
humanOnly: true
needsAnswers: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

1. **Which backend is the recommended browser default?** Blocked on measurement, not on judgement: `spike-sqlite-in-the-browser` decides it. The seam in this spec is deliberately written so that either answer is a configuration choice rather than a redesign, but the DEFAULT that the docs and the browser package recommend cannot be picked without the numbers (payload, cold start, write throughput, and whether Safari behaves).
2. **Does the light backend answer as-of reads at all, or only revert?** Reverse patches can serve an as-of read by replaying backwards, at a cost linear in the distance. If that is fast enough within the finality window, the light backend advertises `asOf` and the query layer is uniform. If it is not, the light backend advertises revert-only and the query layer must refuse historical queries against it rather than silently answering from the tip. Decide once the spike has replay numbers.
3. **Can the entity model express a processor someone really wrote?** The model below commits to scalars plus id-reference relations, with aggregations and interfaces parked. The stratagems processor is the honest test: nested keyed maps, an ordered array, a singleton, per-account submaps and derived values. `spike-sqlite-in-the-browser` ports it and reports every contortion the model forces. If the contortions are severe the model is wrong, and this is the cheapest moment to learn that, since nothing is built on it yet.

<!-- /open-questions -->

## Problem Statement

A processor written for the in-browser path cannot run on the server, and vice versa. The two authoring APIs already look almost identical on purpose (`on<EventName>(state, event, config)` in both), but the state argument differs: `@etherfold/js-processor` hands the author an immer draft of a free-form object, while `@etherfold/processor-sqlite` hands them a `MutationContext` over declared entities. A handler body is therefore not portable, so the same indexing logic gets written twice, and the two copies drift.

That split also blocks the query layer. A generic query surface (and the GraphQL frontend already researched and measured) can only be generated from a declared schema. The free-form object path has no schema to generate from, so any query capability built on entity declarations would be available on the server and absent in the browser, which is the opposite of what this project claims: indexing anywhere.

Underneath both is an unstated assumption worth making explicit: how much history the state keeps. Reorg revert already forces a floor, because undoing a reorg means reopening entity versions closed at the fork point, so a store must retain superseded versions back to the finality depth whether or not anyone calls it history. Today that retention is implicit and differs by backend, which means "can I query this at block N" has no answer a caller can rely on.

## Solution

One authoring API, several storage backends behind one seam, with retention as an explicit, declared capability rather than an emergent property of whichever backend happened to be wired in.

An author writes a processor once: entity declarations plus `on<EventName>` handlers that read and write through a `MutationContext`. Where that state physically lives (SQLite on a server, SQLite compiled to wasm in a browser, or a patch-based light store) is a deployment choice that the processor does not see and does not encode.

Retention becomes a number the deployment sets and the backend reports: the finality depth as the floor (which costs nothing extra, since reorg safety already demands it), some window of N blocks, or unbounded for full time travel. A consumer asking for state as of an old block gets either an answer or an explicit refusal, never a tip read dressed up as a historical one.

## User Stories

1. As a processor author, I want to write my indexing logic once, so that the same processor runs in a browser tab and on a server without a second implementation.
2. As a processor author, I want to declare my entities as `{name, id, fields}`, so that the storage layer owns the DDL, the versioning and the reorg revert rather than each processor reimplementing them.
3. As a processor author, I want to write a whole row with `set` and a partial change with `update`, so that the common counter-increment case is one line while the storage model (a version is a complete row) stays visible.
4. As a processor author, I want my handlers to be uniformly async, so that one signature works whether a read hits memory or a database.
5. As a processor author, I want read-your-writes within the block being processed, so that two events in the same block that touch one counter compose correctly.
6. As an application developer, I want to choose a storage backend for the browser, so that I can trade payload size against query capability for my own app rather than accepting one project-wide answer.
7. As an application developer, I want the backend to tell me what retention it provides, so that I can discover at startup whether historical queries are available instead of discovering it from a wrong answer in production.
8. As an application developer, I want a query surface generated from the same entity declarations that drive storage, so that I do not hand-write and hand-maintain a second description of my data.
9. As an application developer, I want historical queries to be refused explicitly when the backend cannot serve them, so that a missing capability is a clear error rather than a silently-wrong number.
10. As an operator, I want to set the retention window, so that a server can keep full history while a browser keeps only what reorg safety requires.
11. As an operator, I want retention to be enforced by pruning, so that storage does not grow without bound on a long-running server that does not need time travel.
12. As an operator, I want the same processor and the same entity declarations whether I run the single-process CLI or a split watcher and indexer-server, so that scaling out is a deployment change and not a rewrite.
13. As a maintainer, I want the subtle code (versioned rows, as-of reads, revert) to exist once per backend and be covered by one shared conformance suite, so that two backends cannot drift into answering the same question differently.
14. As a maintainer, I want a backend's declared capabilities to be tested, so that a backend claiming `asOf` and failing to deliver it fails a test rather than a user.

### Autonomy notes

- **`humanOnly: true`**: the tasking of this spec must be human-driven. It changes the public authoring API of two published packages and picks a storage strategy, and question 1 is settled by evidence that does not exist yet.
- **`needsAnswers: true`**: both open questions above block tasking. Neither is a matter of opinion; both are answered by `spike-sqlite-in-the-browser`.

## Implementation Decisions

Settled in discussion, recorded here to seed tasking.

- **The authoring API is the `SQLProcessor` shape, generalised.** `MutationContext` (`get` / `set` / `delete`, plus `update` sugar) becomes the single write surface, and the name stops implying SQL. The direction is forced: `MutationContext` is the more constrained API, so a freer substrate can implement it, whereas backing arbitrary nested object mutation with versioned rows requires materialising the store, which `sql-backed-event-processor` already rejected.
- **Handlers are uniformly async.** The alternative, typing reads as `T | Promise<T>`, is infectious at every call site for the benefit of saving a microtask on the path where the work is dominated by log fetching.
- **`set` writes a whole row; `update(entity, id, partial)` is sugar over get-then-spread-then-set.** The primitive mirrors the store's close-then-insert honestly; the sugar keeps the counter case readable.
- **Entities carry scalars and explicit id-reference relations.** Interfaces, declarative aggregations, timeseries, full-text search and grafting are parked, not abandoned: revisit when a real consumer needs one, and record the trigger rather than the wish.
- **Retention is a declared capability, not an implementation detail.** A backend reports what it can serve (`revert-only`, a window of N blocks, or unbounded) and the floor is the finality depth, because reorg revert already requires retaining superseded versions that far back. Pruning drops versions whose upper bound is older than the window.
- **The light path is a legitimate implementation of the seam, not a special case.** Immer reverse patches are already a bounded history kept to exactly the finality depth, represented as a patch log rather than as versioned rows. The backends therefore differ in representation and in as-of cost, not in how much they retain.
- **A captured, replayable stream fixture is the shared input.** The `ExistingStream` seam already exists, with a filesystem implementation (`keepStreamOnFile`) and a browser one over IndexedDB; what is missing is a fixture format a browser harness can load and a replay mode that bypasses fetching. That is worth building properly rather than as spike scaffolding, because deterministic replay is also what makes processor tests reproducible, what lets two processor versions be compared on identical input, and what ADR-0008's blue-green rebuild reads from.
- **One conformance suite runs against every backend.** Versioned reads, as-of reads within the declared window, reorg revert including a counter that must decrease, and read-your-writes within a block. This is the mechanism that keeps two implementations honest, and it is worth more than either implementation.
- **The query layer is generated from the entity declarations**, and the example ships hand-written routes rather than GraphQL. The GraphQL stack is already decided on measured evidence (Hono, then Yoga, then Pothos, built programmatically from the same model, no SDL and no deploy-time codegen; see `~/dev/github/wighawag/research/graphql-frontend-for-indexer-state`, researched 2026-06-02). Adding it later is an addition; failing to design entity declarations as the schema source now would make it a refactor.
- **The single-process CLI must not close the split seam.** `etherfold serve` runs fetching, processing and serving in one process, and that is the intended shape for the CLI case, but the log-fetcher / stream-builder / indexer-server boundary of ADR-0003 through ADR-0006 stays intact so a watcher and an indexer-server can be pulled apart without touching processors.

## Testing Decisions

- **The conformance suite is the centrepiece**: one suite, parameterised by backend, asserting external behaviour (what a read returns after a write, after a revert, as of a block) and never implementation shape. A new backend earns its place by passing it.
- **Reorg is the load-bearing case.** A stored counter that does not decrease when its block is reverted is the canonical bug this design is meant to make impossible, so it gets an explicit test on every backend rather than one shared happy-path test.
- **Capability claims are tested against behaviour**: a backend declaring an as-of window must answer within it and refuse outside it.
- Prior art to mirror: `packages/state-store-sqlite/test/`, and the reorg tests in `packages/processor-sqlite/test/reorg.test.ts` and `packages/js-processor/test/reorg.test.ts`.

## Out of Scope

- **Subgraph parity beyond the entity model**: interfaces, aggregations, timeseries, FTS5 and grafting. Parked with intent to revisit, per the decision above.
- **The GraphQL frontend itself.** Researched and decided elsewhere; this spec only guarantees the schema source it will consume.
- **A `remote-sql` adapter for browsers.** If the spike favours wasm SQLite, that adapter is a package in another repo (`remote-sql` currently ships libSQL, D1 and Durable Objects adapters and nothing for browsers), and it is that repo's work, not this one's.
- **Migrating existing processors.** Live consumers and published package names are explicitly not a constraint on this design.

## Further Notes

The browser story has a second, independent problem this spec does not solve but should not be confused with: state is persisted today by serialising the entire state blob to IndexedDB on every save, which is O(total state) per write regardless of backend. Row-level writes make persistence proportional to what changed. Whichever backend wins, that is the change that makes in-browser indexing scale, and the spike should baseline against it so the comparison is against the real incumbent.

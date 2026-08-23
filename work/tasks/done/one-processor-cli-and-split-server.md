---
title: The same processor and declarations run under the single-process CLI and the split watcher/server
slug: one-processor-cli-and-split-server
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam]
covers: [12]
---

## What to build

Prove, with a test rather than an assurance, that one processor plus one set of entity declarations runs unchanged under `etherfold serve` (fetching, processing and serving in one process) and under the split log-fetcher / stream-builder / indexer-server deployment, so scaling out is a deployment change and not a rewrite.

The risk this task exists to close is specific: the single-process CLI is the intended shape for the CLI case, and it is exactly the shape that quietly CLOSES the split seam if nobody is watching. A convenience that reaches across the log-fetcher / stream-builder / indexer-server boundary of ADR-0003 through ADR-0006 will not fail any test today, and will be discovered only when someone tries to pull the halves apart.

So the deliverable is a test that runs the same processor both ways on the same input and asserts the same resulting state, plus whatever wiring is needed to make the portable seam reachable from both paths. Deterministic replay makes this cheap and it already exists: `@etherfold/core`'s stream fixture gives one captured input that both paths can consume, so the comparison is against identical bytes rather than two chain reads.

Where the state lives is the deployment's choice on both paths, and the point is that the processor does not see it and does not encode it. ADR-0016 already says a processor package names where its state lives; check that the portable seam did not contradict it and, if it did, that is a needs-attention signal rather than something to paper over.

## Acceptance criteria

- [ ] One processor and one set of entity declarations, defined once in a test, run under the single-process CLI path and under the split path, and produce the same state from the same captured input.
- [ ] The comparison uses a replayed fixture, so both runs see identical bytes.
- [ ] Switching a path's storage backend is a configuration change that touches no processor code, demonstrated rather than asserted.
- [ ] The seam boundary is still real: a test or a check fails if the single-process path grows a dependency that the split path cannot satisfy. State how you encoded that, since "the boundary is intact" is not otherwise checkable.
- [ ] Reorg behaves the same on both paths for the same input, including a counter that decreases.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset if any public surface changed.

## Blocked by

- `portable-mutation-context-seam`: there is no "same processor" to run both ways until the authoring API is backend-neutral.

## Prompt

> Prove that one processor runs unchanged under the single-process CLI and under the split watcher/indexer-server deployment in the `etherfold` monorepo, and keep the split seam from silently closing.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), confirm `portable-mutation-context-seam` landed as assumed, and read ADR-0003 through ADR-0006 (the log-fetcher / stream-builder / indexer-server split, and the wire contract where the RECEIVER is authoritative about the cursor and derives all reorg information) plus ADR-0016.
>
> The vocabulary: the LOG-FETCHER is stateless and makes chain calls only; the STREAM-BUILDER derives the event stream and the reorg information and is hosted with the processor in the INDEXER-SERVER; `etherfold serve` runs all of it in one process, which is the intended CLI shape and not a violation.
>
> The failure this task prevents is silent: a convenience in the single-process path that reaches across the component boundary breaks no test today and is discovered only when someone tries to split the halves. So the deliverable is a check, not a claim. Decide how you encode "the boundary is intact" and say so.
>
> Use deterministic replay for the comparison: `@etherfold/core`'s stream fixture (`parseStreamFixture`, `replayStream`) gives one captured input both paths can consume, so the two runs see identical bytes instead of two chain reads.
>
> Done means: the same processor definition, run two ways on one fixture, lands on the same state, including through a reorg, and a future convenience that closes the seam goes red.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular how you made the seam boundary checkable.

## Decisions

**1. `EthereumIndexer.expectedFromBlock` is new public surface on `@etherfold/core`.** ADR-0004 makes the receiver authoritative about where the next batch starts, and `generateStreamToAppend` already *enforces* it internally (it throws naming the value) — but there was no way to **ask**. Without it the split shape cannot exist at all: the stateless fetcher would have to compute the cursor itself, which is exactly the state ADR-0004 says it must not hold, and my test would have had to duplicate the `getFromBlock` formula (which `feed.test.ts` already does inline three times, and which would then silently drift). Alternatives considered: exporting the internal `getFromBlock` (worse — it hands out a free function that needs a `LastSync` the caller does not own), or duplicating the formula in the test (rejected: a duplicated formula cannot detect the seam closing). Named with ADR-0004's own word, so it does not fork a concept. **Touches** `ingest-wire-receiving-side` (backlog), which will need exactly this number for its `409` payload — I have added the getter, not the endpoint or its status semantics.

**2. The wire in this test carries DECODED `LogEvent`s, not raw logs.** ADR-0004 says `logs[]` without settling which. `EthereumIndexer.feed` — the receiving primitive the ADRs point at — takes decoded events, and `LogEventFetcher` is internal to `@etherfold/core`, so a receiver has no public way to decode. `captureStream` already decodes at fetch time for the same reason. Alternative: carry raw logs and decode server-side (would need a new public decoder, which is not this task's to add). **Touches** `ingest-wire-receiving-side`, which owns the real envelope; my `WireBatch` type is deliberately test-local and says so, so it does not pre-empt that decision.

**3. The generic `EventProcessor` over an arbitrary `StateStore` is a TEST-LOCAL harness, deliberately not published.** The backend-swap criterion needs the same processor driven by the core over a non-SQL store, and the only published bridge is `VersionedStateEventProcessor`, which is bound to `RemoteSQL`. Publishing a general one requires deciding **where a backend-neutral processor keeps its `LastSync` cursor**, and ADR-0016 makes that a property of where its state lives — a load-bearing, hard-to-reverse decision that belongs to the task wiring a browser deployment, not to this one. So the harness is `applyEventStream` plus the lifecycle calls, persists no cursor, and is documented as such at the definition site. **Coherence note:** it is a third thing implementing `EventProcessor` over entity declarations; it stays in `test/` precisely so the vocabulary does not gain a second published meaning. The published `VersionedStateEventProcessor` is still run on both shapes and compared on its own, so the equality is not only between harnesses.

**4. `replayStream` is not used, although the task's prompt names it.** It builds an `ExistingStream` — the kept-stream cache that sits in *front* of a fetch — and only the single-process shape has one; the split shape's fetcher needs a chain to fetch *from*, and routing both shapes through `feed()` would have made them the same code path and proved nothing. So the fixture is replayed one level lower, as the provider the chain-facing half talks to: `captureStream` once, `serializeStreamFixture` once, `parseStreamFixture` per run. The criterion ("both runs see identical bytes") is met; the named function is not the right seam for it.

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

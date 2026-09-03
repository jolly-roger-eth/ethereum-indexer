---
'@etherfold/core': minor
'@etherfold/browser': minor
---

The invalidation verdict is PUBLISHED instead of computed and thrown away.

`updateIndexer` has always asked `sourceInvalidationOf` whether the stored data still describes the source being run now, and has always dropped the answer: the two halves and the block each of them names reached a log line and nothing else. What the caller got was `stateDiscarded`, that verdict collapsed into one bit -- and one bit cannot say WHICH half died or FROM WHICH block.

`ReconfigureOutcome` now carries `sourceInvalidation`, and `SourceInvalidation` / `InvalidationVerdict` / `InvalidationReason` are exported from `@etherfold/core`, so a consumer across the package boundary can read the verdict and act on it:

```ts
const outcome = await indexer.updateIndexer({source});
outcome.sourceInvalidation;
// {state: {valid: false, invalidFromBlock: 780, reason: 'entry-added'}, stream: {valid: true}}
```

Two halves because the fetch and the fold do not depend on the same thing (ADR-0034): an invalid STREAM half means the filter moved and the logs have to come from the node again, while a stream that stands under an invalid STATE half is a new fold over logs already on disk. Each half names the block it stopped being valid from, which is the point a rebuild can start at rather than block 0.

It is `undefined` on `updateProcessor` and on `reset`, which ask no source question. A processor swap moves neither the fetch filter nor the decoding shape; `reset` is a discard by fiat that also CLEARS the cached stream, so reporting "both halves valid" there would be true of the source and read as "the stream stands" about a stream it has just deleted.

THE VERBS STILL DISCARD EXACTLY AS THEY DID. This is additive on purpose: the verdict is published now, and the consumer that acts on it instead of discarding is the generation container, which lands separately. Nothing about what a reconfigure DOES changed, and the existing `stateDiscarded` branch in `@etherfold/browser` is untouched.

Note what the verdict is NOT: a digest comparison. `streamDigestOf` MOVES when an event is appended above the cursor, because that append adds a `streamHash` to the filter set -- and that append is FREE (ADR-0034). The verdict decides WHETHER a reconfigure invalidates anything; the stream digest decides WHICH stream a result belongs to. `packages/browser/test/eventRanges.test.ts` pins exactly that: the digest moves, the verdict says both halves valid, and not one block below the cursor is re-fetched.

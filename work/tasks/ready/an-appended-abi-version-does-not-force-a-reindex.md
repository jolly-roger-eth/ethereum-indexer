---
title: 'An ABI version appended above the cursor does not force a re-index'
slug: an-appended-abi-version-does-not-force-a-reindex
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: []
covers: [1, 2, 9, 10, 11, 12]
---

## What to build

Let a developer say **from which block a version of the ABI applies**, so that appending one keeps the indexed state instead of throwing it away.

Today the whole `IndexingSource` is hashed into the sync context, so adding an event to an ABI moves the hash and forces a full re-index. That is the conservative branch, and it is CORRECT by default, because the indexer cannot know whether the new event could have been emitted in the blocks already indexed: if it could, those logs were never fetched (the topic was not in the filter) and the state is missing them.

Only the developer knows. A declared boundary block is that knowledge, and it licenses skipping the re-scan.

**The rule is already written**, in `indexerMatches`: a source version the stored context does not have forces a reset only when its start block is at or below the cursor; above the cursor, keep the state and index forward. `ContextIdentifier.source` is already `{startBlock, hash}[]`. What is missing is the PRODUCER: `reinit` collapses it to `[{startBlock: 0, hash: simple_hash(source)}]`, marked `// TODO handle history (in reverse order)` at both call sites. Build the producer and the source shape that feeds it.

Three things to get right:

- **Do not reuse `startBlock`.** Per-contract `startBlock` already means "do not look before here", and `defaultFromBlockOf` takes the MINIMUM across entries (a two-entry source with 0 and 500 yields 0). A version boundary is a different concept and needs its own field.
- **Per-version hashing.** Appending a version must not change the hash of the versions below it, or nothing is saved. Editing a version that is already below the cursor must still invalidate.
- **No per-range topic filtering.** Union every version's topics across the whole scan. The early range contains none of the new ones, which is exactly what the developer asserted. Range-narrowing is efficiency only and is out of scope.

**Document the asymmetry, prominently**, because one direction is unrecoverable. A boundary declared EARLIER than the real upgrade costs at most an unnecessary re-index and some redundant topics. A boundary declared LATER means the logs between the real upgrade and the declared block are never fetched, and that is **undetectable afterwards**, because the topic was not in the filter to begin with. So: declare at or before the upgrade. For a proxy deployment, the implementation's own deploy block is naturally safe, since an implementation cannot emit before it exists.

This is an OPTIMISATION carrying a claim the indexer cannot verify, not a new capability. An additive upgrade already indexes correctly from block 0 without it (two entries at one address already union their events); what this buys is not paying for a re-index. Its value scales with history length and is near zero on a local development chain. Keep the conservative behaviour as the default for a source that declares no boundary.

## Acceptance criteria

- [ ] A source can express more than one ABI version for one address, each with the block from which it applies, in a field that is NOT `startBlock`.
- [ ] Appending a version whose boundary is ABOVE the cursor keeps the state: `updateIndexer` reports `{stateDiscarded: false}` and indexing continues from the cursor rather than the start block.
- [ ] Appending a version whose boundary is AT or BELOW the cursor discards and re-indexes: `{stateDiscarded: true}`, and the next fetch asks from the start block.
- [ ] Editing a version already below the cursor discards, even though the list length did not change.
- [ ] A source declaring no boundary behaves exactly as it does today (any ABI change re-indexes). No existing deployment changes behaviour by upgrading.
- [ ] Events from every declared version are in the fetch filter across the whole scan, so a boundary declared early is harmless.
- [ ] `defaultFromBlock` is unaffected by a version boundary and still derives from `startBlock` alone.
- [ ] The direction asymmetry (early is safe, late loses logs undetectably) is documented where a developer choosing the number will read it — at minimum on the source type, and in the browser guide's axis-two section.
- [ ] Tests cover the new behaviour in the repo's vitest style, including the `indexerMatches` rule directly and end to end through `updateIndexer`'s report.

## Blocked by

- None — can start immediately. Independent of `topic0-is-the-identity-of-an-event`: this is invalidation plumbing and works with the additive union that already exists. If both land, an upgrade that changes a signature also stops forcing a re-index, but neither needs the other.

## Prompt

> Let an `IndexingSource` carry more than one ABI version per address, each with the block it applies from, so that appending one does not force a full re-index, in the `etherfold` monorepo.
>
> FIRST, check this task against current reality. It rests on three readings that were taken during a design conversation: that `ContextIdentifier.source` is already `{startBlock, hash}[]`, that `indexerMatches` already implements "a version the stored context lacks forces a reset only if its start block is at or below the cursor", and that `reinit` collapses the list to a single entry behind a `// TODO handle history (in reverse order)`. Verify all three before building; if the rule has changed, route to needs-attention rather than building on the stale premise.
>
> Context and vocabulary. `CONTEXT.md` is the glossary; **IndexingSource**, **LastSync** and **ContextIdentifier** are the terms in play. The state-discard decision lives in `EthereumIndexer` (`packages/core`), and `packages/browser/test/reconfigure.test.ts` established `{stateDiscarded}` from `updateIndexer` / `updateProcessor` / `reset` as the observable a test asserts on. `work/specs/ready/an-upgraded-contract-is-indexable-from-its-first-block.md` holds the reasoning.
>
> Understand what this is before you build it. It is an OPTIMISATION, not a capability. An additive upgrade ALREADY indexes correctly from block 0, because two entries at one address already merge into a union of their events and decoding is by topic0. The only thing a boundary block buys is not paying for a re-index, and it buys that by taking the developer's word that the new event could not have been emitted earlier — a claim the indexer cannot verify. So the conservative behaviour must remain the default for any source that declares no boundary, and no existing deployment may change behaviour merely by upgrading.
>
> Three traps. (1) Do NOT reuse `startBlock` for the boundary: it already means "do not look before here" and `defaultFromBlockOf` takes the minimum across entries, so overloading it makes two meanings indistinguishable. (2) Hash per version, so appending does not disturb the hashes below it, while editing one below the cursor still invalidates. (3) Do NOT narrow topic filters per block range: union every version's topics across the whole scan, which is what makes an early boundary harmless. Range-narrowing is efficiency only and is out of scope.
>
> Document the direction asymmetry wherever a developer picks the number, because one side is unrecoverable: declaring the boundary EARLY costs at most a needless re-index, while declaring it LATE means the logs between the real upgrade and the declared block are never fetched and cannot be detected afterwards, since the topic was never in the filter. Note that for a proxy deployment the implementation's own deploy block is a naturally safe choice.
>
> Also note what a boundary CANNOT do, and do not let the design drift into it: it does not select which ABI decodes a log (the union does that by topic0), and it cannot disambiguate a topic0 that means two different things, because the upgrade transaction sits mid-block and both meanings share that block.
>
> Add a changeset for the public API change to the source type. Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do not commit without confirmation.

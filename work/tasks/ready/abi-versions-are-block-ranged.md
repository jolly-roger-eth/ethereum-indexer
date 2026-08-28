---
title: 'An ABI is block-ranged, so an upgrade appends a version instead of re-indexing'
slug: abi-versions-are-block-ranged
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: []
covers: [1, 2, 3, 4, 5, 6, 7, 10]
---

## What to build

Make an ABI a fact about a contract **over a range of blocks** rather than about the contract. A source carries a contract's ABI versions, each with the block from which it applies; the indexer keeps the earlier version valid for the range it already covered and applies the later one from its boundary.

Three things follow, and they are the whole task:

**1. Appending a version above the cursor keeps the state AND the cached stream.** The decision rule already exists in `indexerMatches`: a version the stored context lacks forces a reset only when its start block is at or below the cursor. Verified directly against it, with a cursor at 500:

| | |
| --- | --- |
| append a version at block 900 | keep state |
| append at block 400 | re-index |
| edit the version below the cursor | re-index |
| today: any ABI change, whole source rehashed | re-index |

What is missing is the PRODUCER. `reinit` collapses the list to `[{startBlock: 0, hash: simple_hash(source)}]`, marked `// TODO handle history (in reverse order)` at both call sites. Build the source shape and the producer that feeds the existing rule.

Note that `indexerMatches` gates the STREAM cache too (`promiseToLoad`'s `keepStream` branch), so getting this right means an upgrade re-fetches nothing, not merely that it re-derives nothing. That is the headline benefit and it should be the headline test.

**2. Decode by (address, block), not by address alone.** `parse()` currently selects an ABI from a per-address map. It needs a block axis, so a log at block 300 decodes with the version live at 300 and a log at block 1000 decodes with the version live at 1000.

This is what makes a CHANGED event signature work at all. `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)` are never in the same bucket, so the name collision that `deleteDuplicateEvents` throws on today never arises between versions. Do not merge versions into one list to make this easier; the whole point of the ranged model is that they stay apart.

A true topic0 collision (one topic0 meaning two things) is still refused, on every path. A boundary cannot resolve it either, because the upgrade transaction sits mid-block and both meanings share that block.

**3. Narrow the fetch to the versions a range can contain.** Conditional, and deliberately last: measured in `generateLogRequestForTopicsAndFiltersCombinations`, with no argument filters every topic goes into ONE request so narrowing saves nothing, while with argument filters there is one request per (event topic × filter) run sequentially, so a version that cannot exist in a range still costs its own round trips. The browser shape uses filters, so the saving is real there. A fetch range that CROSSES a boundary must split at it or use the union for that range; splitting is cheap because boundaries are rare.

Three traps:

- **Do not reuse `startBlock`.** It already means "do not look before here" and `defaultFromBlockOf` takes the MINIMUM across entries (measured: entries at 0 and 500 yield 0). The boundary needs its own field.
- **Hash per version**, so appending does not disturb the hashes below it while editing one below the cursor still invalidates. `indexerMatches` compares element-wise BY INDEX, so inserting in the middle shifts and invalidates; that is correct, but make it deliberate.
- **A source with no boundary must behave exactly as it does today.** No existing deployment changes behaviour by upgrading.

## Acceptance criteria

- [ ] A source can carry more than one ABI version for one address, each with the block it applies from, in a field that is NOT `startBlock`.
- [ ] Appending a version ABOVE the cursor keeps the state: `updateIndexer` reports `{stateDiscarded: false}`.
- [ ] Appending above the cursor re-fetches NOTHING: asserted on the ranges the node was asked for, since state alone cannot distinguish a resume from a re-index.
- [ ] Appending AT or BELOW the cursor discards and re-indexes from the start block.
- [ ] Editing a version already below the cursor discards, even though the list length did not change.
- [ ] A log before the boundary decodes with the version live then; a log after it decodes with the later version. Driven through a captured stream carrying both versions' logs at one address.
- [ ] An upgrade that CHANGES an event's signature is accepted, and both topic0s appear in what the fetcher requests.
- [ ] A true topic0 collision is refused at construction, naming the colliding events, identically with and without `parseAllEventsIrrespectiveOfAddresses`.
- [ ] A source declaring no boundary behaves exactly as today.
- [ ] `defaultFromBlock` is unaffected by a boundary and still derives from `startBlock` alone.
- [ ] With argument filters configured, a range below a boundary issues no request for the later version's topics.
- [ ] The direction asymmetry (early is safe, late loses logs undetectably) is documented on the source type and in the browser guide's axis-two section.
- [ ] Tests cover the new behaviour in the repo's vitest style.
- [ ] A changeset covers the public API change to the source type.

## Blocked by

- None — can start immediately. Independent of `handler-types-do-not-lie-when-one-name-covers-two-events`, which fixes the AUTHORING surface this task fixes the DECODER for; ship both before telling anyone a changed signature is supported.

## Prompt

> Make an ABI block-ranged in the `etherfold` monorepo: a source carries a contract's ABI versions, each with the block it applies from, so that an upgrade APPENDS a version instead of forcing a full re-index, and so that an event whose signature changed can be indexed across the upgrade.
>
> FIRST, check this task against current reality. It rests on readings taken during a design conversation: that `ContextIdentifier.source` is already `{startBlock, hash}[]`; that `indexerMatches` already returns keep/re-index correctly for append-above, append-below and edit-below; that `reinit` collapses the list behind a `// TODO handle history (in reverse order)`; that `defaultFromBlockOf` takes the minimum across entries; and that `generateLogRequestForTopicsAndFiltersCombinations` emits one request per (topic × filter) only when argument filters are configured. Re-run these rather than trusting them. If the rule has changed, route to needs-attention rather than building on a stale premise.
>
> Context and vocabulary. `CONTEXT.md` is the glossary; **IndexingSource**, **LastSync**, **ContextIdentifier** and **stream/keepStream** are the terms in play. The discard decision lives in `EthereumIndexer` (`packages/core`); decoding lives in `LogEventFetcher` (`internal/decoding/`); `packages/browser/test/reconfigure.test.ts` established `{stateDiscarded}` as the observable a test asserts on. The spec `work/specs/ready/an-upgraded-contract-is-indexable-from-its-first-block.md` holds the reasoning, including why the ranged model was chosen over a merged union.
>
> The headline is NOT that state survives; it is that NOTHING IS RE-FETCHED. `indexerMatches` gates the kept event stream as well as the state, so an append above the cursor should leave both intact. Assert that on the RANGES the node was asked for: a re-index and a resume land on identical rows, so the state cannot tell you which happened. The recording fake chain in `packages/browser/browser/workload.ts` is the prior art.
>
> Build it as per-range BUCKETS, not a merged union: `parse()` selects an ABI by address today and must select by address AND block. Keeping versions apart is what makes a changed event signature work without any duplicate-detection change, because v1's `Transfer` and v2's `Transfer` are never in the same list. Do not collapse them to make decoding easier. A genuine topic0 collision is still refused, on every path, including the `parseAllEventsIrrespectiveOfAddresses` one.
>
> Three traps. Do NOT reuse `startBlock` for the boundary; it already means "do not look before here" and is minimised across entries. Hash PER VERSION so appending does not disturb the versions below it while editing one below the cursor still invalidates. And a source with no boundary must behave exactly as it does today, so that no existing deployment changes behaviour merely by upgrading.
>
> Document the direction asymmetry wherever a developer picks the number, because one side is unrecoverable: EARLY costs at most a needless re-index, LATE means the logs between the real upgrade and the declared block are never fetched and cannot be detected afterwards, since the topic was never in the filter. For a proxy deployment the implementation's own deploy block is naturally safe.
>
> Do the fetch narrowing LAST and treat it as conditional: it saves request count only where argument filters are configured, and nothing at all otherwise. A range crossing a boundary may simply use the union for that range.
>
> Add a changeset for the source type change. Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do not commit without confirmation.

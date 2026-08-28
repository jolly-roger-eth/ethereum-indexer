---
title: 'An upgraded contract is indexable from its first block'
slug: an-upgraded-contract-is-indexable-from-its-first-block
---

> **SUPERSEDED ON ITS CENTRAL MECHANISM, 2026-08-28.** This spec argues for per-range ABI
> BUCKETS with a block axis in `parse()`, so that a log decodes with "the ABI live at its
> block". That model was rejected in design review. The boundary block is unknowable in
> advance, so a live indexer can never fill it in, and it is not block-granular anyway,
> because the upgrade transaction sits mid-block and logs on either side of it share a block.
> Decoding stays by topic0 with NO block axis; block ranges survive only as a FETCH-FILTER
> and invalidation concern. The current design lives in
> `work/tasks/ready/abi-versions-are-block-ranged.md` (see its re-scope note) and
> `work/tasks/ready/an-event-is-never-silently-dropped-from-the-fetch-filter.md`, which now
> BLOCKS it. Where this spec and those tasks disagree, the TASKS win; read this for background.

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.
>
> **Rewritten** after the first cut. That version treated block-ranged ABIs as an optional optimisation bolted onto a merged-union decoder, and split the work accordingly. It was wrong: the ranged model is the PRIMARY mechanism, and the union was a way of avoiding it that costs a full re-index every time and cannot express a changed signature at all.

## Problem Statement

A contract behind a proxy gets a new implementation. The address does not move; the generated ABI does. The developer wants to index that contract **from its first block**, across the upgrade, with one source, and without re-fetching the history every time the ABI changes.

An ABI is not a fact about a contract. It is a fact about a contract **over a range of blocks**. Nothing in the indexer says so, and every problem below is a consequence.

**Today, adding an event to the ABI re-indexes everything.** The whole source is hashed into the sync context, so any ABI change moves the hash. That discards the state AND clears the cached event stream, because `indexerMatches` gates both. So the cheapest possible upgrade (a new event that could not have been emitted before the upgrade block) costs a complete re-fetch of the entire history.

**Today, an upgrade that CHANGES an event's signature cannot be indexed at all.** `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)` have different topic0s and are trivially distinguishable on the wire, but the fetcher refuses to hold both: `deleteDuplicateEvents` keys on event NAME, so it throws `two events with same name but different inputs`. The developer must pick one, and either choice blinds them to half the history, because the topic0 they did not pick is never in the fetch filter.

**And the handler types would lie if that refusal were simply lifted.** `InputValues` does not distribute over a union, so one name covering two events yields ONE `onTransfer` whose `args` is the two input lists MERGED, with the v2-only field **required**. A v1 log hands the author `undefined` through a type promising a value.

## Solution

Make an ABI **block-ranged**: a source carries a contract's ABI versions, each with the block from which it applies. The indexer keeps the old version valid for the range it already covered and applies the new one from its boundary.

That one change answers all three:

- **Appending a version above the cursor keeps the state and the cached stream.** The rule is already implemented in `indexerMatches` and was verified against it: with a cursor at 500, appending a version at block 900 keeps the state, appending at 400 re-indexes, and editing a version below the cursor re-indexes. Only the producer is missing (`reinit` collapses the list to one entry, marked `// TODO handle history (in reverse order)`).
- **A changed signature stops being a conflict**, because v1 and v2 are never in the same bucket. v1's `Transfer` decodes the blocks before the boundary and v2's decodes the blocks after, so there is nothing to de-duplicate and nothing to refuse.
- **Fetching can narrow to the versions a range can actually contain.** Conditional, see below.

The developer's declared boundary is an assertion the indexer cannot verify, only act on. It is safe to declare EARLY and dangerous to declare LATE, and that asymmetry is the thing to document.

## User Stories

1. As a developer whose upgrade ADDS an event, I want to append it with the block it applies from and keep indexing, so that the upgrade does not re-fetch history I already have.
2. As a developer whose upgrade CHANGED an event's signature, I want both versions in one source, so that one processor covers the whole history.
3. As a developer, I want events before the boundary decoded by the ABI that was live then, so that pre-upgrade history means what it meant when it was written.
4. As a developer appending a version AT or BELOW the cursor, I want a full re-index, because those blocks were indexed without that event in the filter and may be missing logs.
5. As a developer editing a version already below the cursor, I want a full re-index, because what I changed describes blocks already derived.
6. As a developer, I want to be told that declaring a boundary EARLY is safe and LATE loses logs undetectably, so that I know which way to err.
7. As a developer with no upgrade, I want to write one ABI with no boundary and have nothing change, so that the common case pays nothing.
8. As a processor author handling an event whose signature changed, I want the compiler to force me to narrow before reading a field that exists in only one version, so that I cannot read `undefined` through a type that promised a value.
9. As a processor author with an ordinary single-version ABI, I want my handler types unchanged.
10. As a developer, I want a range to request only the versions it can contain, so that an upgrade does not make every earlier range more expensive: under argument filters it multiplies the requests, and in every case it widens the block set the node must screen and scan.
11. As a developer, I NEVER want an event silently dropped from the fetch filter, so that "no logs found" always means the chain had none.
12. As an operator, I want the same ABI accepted or refused identically whether or not `parseAllEventsIrrespectiveOfAddresses` is set.

### Autonomy notes

All three tasks are ordinary agent-buildable work: typed seams, existing test styles, no secrets or release surface. Neither gate flag is set.

## Implementation Decisions

**Per-range buckets, not a merged union.** The two candidate models were weighed. A merged union (all versions in one per-address list, decoded by topic0) is a smaller change but requires re-keying the duplicate check on topic0 to stop it refusing a changed signature, and it makes the boundary advisory rather than meaningful. Ranged buckets say the true thing — this ABI was valid for these blocks — and make the version conflict structurally impossible rather than permitted. The cost is a **block axis in the parser**: `parse()` currently selects an ABI by address alone and must select by address and block.

**`startBlock` is not the boundary.** Per-contract `startBlock` already means "do not look before here", and `defaultFromBlockOf` takes the MINIMUM across entries (measured: a two-entry source with 0 and 500 yields 0). The version boundary needs its own field or the two meanings will be confused.

**Per-version hashing.** Appending must not disturb the hashes of versions below it, or nothing is saved; editing a version below the cursor must still invalidate. `indexerMatches` already compares the list element-wise and by index, so inserting a version in the middle shifts and invalidates. That is correct but should be deliberate.

**Fetch narrowing is a real saving, in two separate ways, and is still not the reason to do this.**

The first is request COUNT, and it is measured here: `generateLogRequestForTopicsAndFiltersCombinations` puts every topic in ONE request when no argument filters are configured, but emits one request per (event topic × filter) when they are, run sequentially. So under filters a version that cannot exist in a range still costs its own round trips. That is the browser shape (the NFT example issues two per range for one event).

The second is the NODE's own work, and it applies even in the single-request case. **Carrying a topic that cannot match still costs the node**, because it is asked to establish that nothing matches:

- Nodes screen blocks with the header `logsBloom`, and a block passes when it COULD hold a matching log. Topics are OR'd at position 0, so each additional topic widens the set of blocks that pass and therefore the set whose receipts are loaded and scanned.
- The bloom is probabilistic, so each additional topic adds its own false-positive opportunities, and those blocks are loaded for nothing.

Magnitude depends on the address filter. With a tight address filter a block must match the address AND a topic, so the extra cost is mostly false positives: small, not zero. **Address-agnostic** (`parseAllEventsIrrespectiveOfAddresses`, which the NFT example uses) the topic is the only screen, so carrying a common topic0 such as `Transfer` widens the scan a great deal. This repo already treats `eth_getLogs` as the most constrained call it makes: `work/specs/proposed/node-log-api.md` calls provider limits on it "the single most painful constraint", and the whole truncation apparatus in `agnostic-log-fetcher` exists because of its result caps.

**This second mechanism is NOT measured here.** It is how nodes implement the method, not a fact established against this codebase, and a builder should not quote it as one. What is measured is the request-count half.

It is still not the justification, because the justification is that an append re-fetches nothing at all. It is last in build order for the same reason it is possible at all: it needs the ranges to exist first. A fetch range that CROSSES a boundary must either split at it or use the union for that range; splitting is cheap because boundaries are rare.

**The direction asymmetry.** Declaring the boundary EARLIER than the real upgrade costs at most an unnecessary re-index and some redundant topics. Declaring it LATER means the logs between the real upgrade and the declared block are never fetched, and are **undetectable afterwards**, because the topic was not in the filter to check with. For a proxy deployment the implementation's own deploy block is naturally safe, since an implementation cannot emit before it exists.

**A true topic0 collision is still refused.** One topic0 meaning two different things cannot be resolved by a boundary either, because the upgrade transaction sits mid-block and both meanings share that block. Refuse it, on every path.

**`InputValues` distributes.** Needed under either model, because the ranged buckets fix the decoder and not the authoring surface: the author still writes one `onTransfer` for two shapes. Verified as a working shape before this spec was written:

```ts
export type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;
```

Measured with an ABI carrying two `Transfer`s: the single-version case is unchanged, `event.args.memo` becomes a compile error, and `'memo' in event.args` narrows. **Both authoring packages hold their own copy** and both must change.

## Testing Decisions

External behaviour, at the seams the repo already tests at.

- The append rule is directly testable against `indexerMatches`, and end to end through `updateIndexer`'s `{stateDiscarded}` report, which `packages/browser/test/reconfigure.test.ts` established as the observable.
- **The claim that matters most is that an append re-fetches NOTHING.** Assert on the ranges the fake chain was asked for, not on the resulting state: both a re-index and a resume land on the same rows, so state cannot tell them apart. `packages/browser/browser/workload.ts`'s recording chain is the prior art, and `reconfigure.test.ts` already asserts a rebuild from a cached stream costs zero fetches.
- Decoding across a boundary wants a captured stream with both versions' logs at one address, either side of the boundary.
- "Never silently dropped" is asserted against the FETCH FILTER, because that is where the failure was invisible.
- The type claims are `pnpm typecheck` work, not vitest, which strips types without checking them. `packages/browser/test/processorKinds.test.ts` is the prior art for `@ts-expect-error` as an assertion.

## Out of Scope

- **Resolving a true topic0 collision.** Refused instead.
- **Changing what a MEANING change requires of the processor.** Settled: it is handler work, and a rebuild replays pre-upgrade blocks, so a processor spanning an upgrade branches on `event.blockNumber`. Pinned by `packages/browser/test/reconfigure.test.ts`.
- **Signature-keyed handler names** (`on['Transfer(address,address,uint256,bytes)']`). Expressible, but needs a type-level canonical signature formatter abitype does not provide. It can be added later as an alias without removing the union, so this is a deferral and not a closed door.
- **Unifying the duplicated `InputValues`.** Two packages hold their own copy; both change here. Whether the authoring surfaces should share a types package is a separate question.

## Further Notes

This came out of a design conversation while closing `example-browser-code-is-typechecked-by-nothing`. The measurements quoted (the `indexerMatches` verdicts, `defaultFromBlock` taking the minimum, the request-count behaviour with and without filters, the merged `args` field being required, the distributive fix compiling, the throw text) were run rather than read, but they are a snapshot: re-check before building.

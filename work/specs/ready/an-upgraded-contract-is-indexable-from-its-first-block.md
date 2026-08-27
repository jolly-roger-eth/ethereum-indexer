---
title: 'An upgraded contract is indexable from its first block'
slug: an-upgraded-contract-is-indexable-from-its-first-block
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

A contract behind a proxy gets a new implementation. The address does not move; the generated ABI does. The developer wants the tab (or the server) to index that contract **from its first block**, across the upgrade, with one indexing source.

Three things stand in the way today, and only one of them is what people assume.

**What is NOT in the way**, and is worth stating because it was assumed twice during the investigation: an ADDITIVE upgrade already works. Two entries at the same address merge into a union of their events, measured:

```ts
contracts: [
  {abi: [Transfer],           address: X, startBlock: 0},
  {abi: [Transfer, Approval], address: X, startBlock: 500},
]
// -> events at that address: ['Transfer', 'Approval']
```

Decoding is by topic0 (viem's `decodeEventLog` against the merged list), so old logs keep decoding and new ones decode too. No feature is needed for an upgrade that only ADDS events. Nothing documents this, which is why it keeps being re-discovered.

**What IS in the way:**

1. **A same-named event with different inputs is refused, and refused inconsistently.** `deleteDuplicateEvents` keys on event NAME, not topic0. So `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)` are treated as duplicates even though they have different topic0s and are perfectly distinguishable on the wire. The same-address merge path THROWS (`two events with same name but different inputs`); the global-list path SILENTLY DROPS the second one. The same ABI is therefore refused or quietly truncated depending on whether `parseAllEventsIrrespectiveOfAddresses` is set, and in the silent case the dropped event's topic0 never enters the fetch filter, so those logs are **never fetched and nothing says so**.

2. **The handler types would lie if the refusal were simply lifted.** `InputValues` is a mapped type over `InputNames<T>` with `T` used whole, so it does not distribute over a union. Measured against an ABI with two `Transfer`s: `ExtractAbiEventNames` collapses to one name (one `onTransfer` handler for two wire events), and the two input lists MERGE into `{from, to, id, memo}` with `memo` **required**. A v1 log would give the handler `undefined` where the type promises a hex string. Both authoring surfaces have their own copy of this type.

3. **Any ABI change forces a full re-index**, because the whole source is hashed into the sync context. For a long-lived contract that is expensive, and it is often unnecessary: if the new event could not have been emitted before the upgrade, there is nothing in the earlier blocks to go back for.

## Solution

Make **topic0 the identity of an event** everywhere it is decided, and let a developer optionally say **from which block a version of the ABI applies** so that appending one does not throw the state away.

From the developer's side:

- An upgrade that adds events: works today, and is documented so nobody builds a feature for it.
- An upgrade that changes an event's signature: accepted, because the two are distinguishable on the wire. The handler receives a UNION and must narrow, which is honest — `'memo' in event.args` is the whole ceremony.
- An upgrade where a topic0 genuinely means two different things: **refused**, loudly, on every path. Nothing can resolve that, and a block boundary cannot either (the upgrade transaction sits mid-block, so no boundary is exact). It is the processor's problem and, intra-block, nobody's.
- An upgrade whose new events could not have existed earlier: the developer declares the boundary block, and the indexer keeps its state and indexes forward instead of starting over.

## User Stories

1. As a developer upgrading a proxied contract with a NEW event, I want to add it to the ABI and keep indexing from block 0, so that the history I already have stays usable.
2. As a developer reading the docs, I want to be told that an additive upgrade already works, so that I do not build a versioning feature I do not need.
3. As a developer whose upgrade CHANGED an event's signature, I want both versions in one ABI, so that one processor covers the whole history.
4. As a processor author handling such an event, I want the compiler to force me to narrow before I read a field that only exists in one version, so that I cannot read `undefined` through a type that promised a value.
5. As a processor author with an ordinary single-version ABI, I want none of this to change my handler types, so that the common case pays nothing.
6. As a developer whose ABI has a true topic0 collision, I want to be refused at construction with a message naming the colliding events, so that I find out at startup rather than from wrong state.
7. As a developer, I NEVER want an event silently dropped from the fetch filter, so that "no logs found" always means the chain had none.
8. As an operator, I want the refusal to be the same whether or not `parseAllEventsIrrespectiveOfAddresses` is set, so that a parse-config flag cannot change which events exist.
9. As a developer appending an ABI version at a boundary block ABOVE the cursor, I want my indexed state kept and indexing to continue, so that an upgrade does not cost a full re-index.
10. As a developer appending a version at or BELOW the cursor, I want a full re-index, because blocks were already indexed without that event in the filter and may be missing logs.
11. As a developer, I want the boundary to be safe when declared EARLY and to be told that late is dangerous, so that I know which way to err.
12. As a developer on a local chain, I want to ignore all of story 9-11, because a re-index there is cheap and the conservative default is already correct.

### Autonomy notes

Both tasks are ordinary agent-buildable work: typed seams, existing test styles, no secrets or release surface. Neither gate flag is set.

## Implementation Decisions

**Topic0 is the identity.** `deleteDuplicateEvents` currently keys by `event.name`. It becomes keyed by the computed topic0. Two entries with the same topic0 and deep-equal inputs are a true duplicate and one is dropped (the ordinary "the same event appears in two contracts' ABIs" case). Two entries with the same topic0 and DIFFERENT inputs are a genuine collision and are refused. Different topic0s are never duplicates, whatever their names.

**One refusal, both paths.** The per-address merge and the global list must reach the same verdict on the same ABI. The `failOnIdenticalNameButDifferentInputs` boolean parameter goes away with the name-keying that motivated it; there is one rule.

**`InputValues` distributes.** Verified as a working shape before this spec was written:

```ts
export type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;
```

Measured with an ABI carrying two `Transfer`s: the single-version case is byte-identical in behaviour, `event.args.memo` becomes a compile error, and `'memo' in event.args` narrows correctly. **Both copies must change** — `@etherfold/js-processor` and `@etherfold/processor-entities` each define their own.

**Handler keys stay name-based.** A signature-keyed alternative (`on['Transfer(address,address,uint256,bytes)']`, applied only where a conflict exists, detected with an `IsUnion` check) is expressible, but needs a type-level CANONICAL signature formatter that abitype does not provide (`FormatAbiItem` yields `"event Transfer(address indexed from, ...)"`, not the selector form), so it would have to be written and maintained here. The union costs one line and no new syntax. Signature keys can be added later as an ALIAS without removing the union, so this is not a door being closed.

**The boundary is a developer assertion, not a decoding switch.** It does not select which ABI decodes a log; the union already does that by topic0. Its only job is to license SKIPPING a re-index. The rule is already implemented in `indexerMatches`: a source version the stored context lacks forces a reset only when its start block is at or below the cursor. What is missing is the producer — `reinit` collapses the list to a single entry, marked `// TODO handle history (in reverse order)` at both sites.

**The asymmetry, which is the thing to document.** Declaring the boundary EARLIER than the real upgrade costs only an unnecessary re-index or some redundant topics in the filter. Declaring it LATER means the logs between the real upgrade and the declared block are never fetched, and are **undetectable afterwards**, because the topic was not in the filter. So: declare at or before the upgrade. For a proxy deployment the implementation's own deploy block is a naturally correct choice, since an implementation cannot emit before it exists.

**Do not reuse `startBlock`.** Per-contract `startBlock` already means "do not look before here" and `defaultFromBlockOf` takes the minimum across entries (measured: a two-entry source with start blocks 0 and 500 yields 0). A version boundary is a different concept and needs its own field, or the two meanings will be confused.

**No per-range topic filtering.** Union every version's topics across the whole scan. The early range simply contains none of the new ones, which is exactly what the developer asserted. Range-narrowed filters are an efficiency question only and are out of scope.

## Testing Decisions

External behaviour, at the seams the repo already tests at.

- The dedup/refusal rules belong at the `LogEventFetcher` construction seam, asserted by what ends up in the per-address ABI list and the topic list, not by reading private maps where avoidable.
- The "never silently dropped" claim is best asserted through the FETCH FILTER: an event that survives construction must have its topic0 in what is requested, and the two parse-config paths must agree.
- The type claims are `pnpm typecheck` work, not vitest: `@ts-expect-error` on the un-narrowed read is what asserts the union, in the style `packages/browser/test/processorKinds.test.ts` already uses (its `@ts-expect-error` lines fail the typecheck if the guarded line starts compiling). Assert BOTH directions: the conflict case must not compile without narrowing, and the single-version case must still compile unchanged.
- Decoding across an upgrade wants a captured stream carrying both versions' logs at one address, in the style of `packages/browser/browser/workload.ts`.
- The invalidation rule is already unit-testable against `indexerMatches`, and end to end through `updateIndexer`'s `{stateDiscarded}` report, which `packages/browser/test/reconfigure.test.ts` established as the observable.

## Out of Scope

- **Range-narrowed topic filters.** Efficiency only; the union is correct.
- **Signature-keyed handler names.** Recorded above as a deliberate deferral, not a rejection.
- **Resolving a true topic0 collision.** Refused instead. A block boundary cannot fix it, because the upgrade transaction sits mid-block and both meanings share the block.
- **Changing what a MEANING change requires of the processor.** Settled already: it is handler work, and a rebuild replays pre-upgrade blocks, so a processor spanning an upgrade branches on `event.blockNumber`. Pinned by `packages/browser/test/reconfigure.test.ts`.
- **The duplicated `InputValues`.** Two packages hold their own copy. This spec changes both rather than unifying them; the unification is a separate question about whether the two authoring surfaces should share a types package at all.

## Further Notes

Both tasks came out of a design conversation while closing `example-browser-code-is-typechecked-by-nothing` and building `examples/browser-reference`. The measurements quoted above (the additive union working, the merged `memo` being required, the distributive fix compiling, `defaultFromBlock` taking the minimum, the throw text) were all run against the tree at that time rather than read off the source, but they are a snapshot: re-check before building.

Task 2's value is proportional to history length. On a local development chain a re-index is cheap and the current conservative behaviour is already correct, so task 1 is the one with value independent of deployment size.

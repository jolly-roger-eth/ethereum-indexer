---
'@etherfold/core': minor
'@etherfold/browser': patch
---

An ABI event can declare the BLOCK RANGES it is live over, so an upgrade APPENDS an entry instead of re-fetching every block ever indexed.

An event entry may now carry `firstBlock` and an optional `lastBlock`, both INCLUSIVE. Write `as const satisfies RangedAbi` (exported from `@etherfold/core`) instead of `satisfies Abi` on an ABI that declares them; an ABI that declares none needs no change at all.

```ts
const abi = [
	{...transferV1, firstBlock: 100, lastBlock: 900}, // the pre-upgrade signature
	{...transferV2, firstBlock: 900}, // the post-upgrade one
] as const satisfies RangedAbi;
```

**The same number on both sides is the CORRECT declaration for an upgrade at block 900**, because a transaction earlier in that block still fires the old event while the upgrade transaction later in it starts the new one. That one-block overlap is preserved, not normalised away. An exclusive end would make the correct declaration read `901`, and the obvious thing to type would silently drop every pre-upgrade log in block 900.

**What the ranges are for is INVALIDATION**, and the win is not that state survives — it is that nothing is re-fetched. `ContextIdentifier.source` now carries one entry per event per live range, ordered so an append lands at the END of the list, which `indexerMatches` reads as "the stored context simply did not have this yet". So, with the cursor at 500:

- append an event live from 900: the state AND the cached event stream are both kept, and the next fetch resumes rather than going back to the start block;
- append one live from 400, or edit an entry already below the cursor: discard and re-index, because those blocks were indexed without that event in the filter;
- remove an entry from below the cursor: discard, because state derived from an event we no longer index is stale.

**Entries are computed on the NORMALISED ranges**, which is what makes a naive generator cheap. Whatever produces a source usually cannot tell an upgrade from a cancellation: it appends on a proxy upgrade and appends again on a rollback, so a source legitimately reads `[A@a, B@b, A@c]`. If any occurrence of an event is open-ended it is live from the MINIMUM `firstBlock` onward and the rest are absorbed; otherwise the ranges are unioned. The redundant append therefore produces a byte-identical list and costs nothing.

A **GAP** between two ranges of one event is refused at construction, naming the event and the uncovered span, since a hole is a span nobody requests. Overlap is not a gap and is never refused.

Two things that did NOT change. **Decoding has no block axis**: a log is decoded by its `topic0` exactly as before, a true `topic0` collision is still refused on every path (ADR-0031), and the boundary was never what told two versions apart. And **a source declaring no range behaves exactly as it did**, down to the persisted context bytes — one whole-source entry at block 0 — so every stored `ContextIdentifier` stays readable and no deployment changes behaviour merely by upgrading.

`ContractData.history` is REMOVED. It was a declared-but-never-implemented placeholder (`{abi, startBlock}[]`, marked `// TODO handle history (in reverse order)` at both `reinit` call sites) for exactly this feature, and it read the block off a field named `startBlock`. Nothing consumed it, so declaring one has never done anything; block ranges on the event entries are what it was waiting to become.

Two smaller consequences. `updateIndexer` now judges an appended entry against the CURSOR rather than against block 0, which it was doing before and which answered "absorb it" for every entry; and a state that survives a source change now adopts the new entries into its persisted context, so an absorbed append is not re-judged (and re-indexed) on the next page load once the cursor has moved past it.

`@etherfold/browser` gains the behaviour through the core it drives: `createIndexerState(...).updateIndexer` now reports `{stateDiscarded: false}` for an append above the cursor and resumes instead of going back to the start block. Its shared test workload carries the ranged sources this is asserted against.

What this does NOT do yet is narrow what the fetcher REQUESTS: every range still carries every topic, which is wasteful and correct. `firstBlock`/`lastBlock` are deliberately NOT `startBlock` and never reach `defaultFromBlockOf`, which minimises across contracts and would otherwise be dragged down by a range. See `docs/adr/0033`.

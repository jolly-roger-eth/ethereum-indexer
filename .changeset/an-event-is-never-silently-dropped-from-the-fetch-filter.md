---
'@etherfold/core': minor
---

An event is never silently dropped from the fetch filter: duplicate detection is keyed on `topic0`, and the verdict no longer depends on `parseAllEventsIrrespectiveOfAddresses`.

`deleteDuplicateEvents` keyed on the event NAME and took a `failOnIdenticalNameButDifferentInputs` flag, and the two call sites passed different values for the same ABI. The per-address merge passed `true` and threw `two events with same name but different inputs`; the global list -- the one the fetch filter is built from -- passed `false` and **spliced the second event out with no error, no log and no metric**. So the same ABI was refused or quietly truncated depending on a parse-config flag, and a parse-config flag decided which events existed.

The silent branch was the dangerous one. The dropped event's `topic0` never entered the topic list, so its logs were never requested, and afterwards nothing distinguished "the chain had none" from "we never asked" -- an absence inferred from a request that was never made, the same failure class as `absence` versus `contradiction` in the reorg model and as `SuspectedTruncationError`.

There is now ONE rule, applied to every ABI list, per-address and global alike, and keyed on the canonical signature (so on `topic0`, which is its hash) rather than on the name:

- **different `topic0` -> both events are KEPT**, whatever their names, and both topics are requested. That covers two contracts declaring same-named events with different inputs, and two versions of one contract's event across an upgrade (`Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)`), which at the upgrade block can both legitimately occur, since the upgrade transaction sits mid-block and a transaction before it still fires the old event;
- **same `topic0`, identical definition -> collapsed to one**, with no error. Two contracts sharing an identical event de-duplicate exactly as before;
- **same `topic0`, different definition -> REFUSED at construction**, with a message naming both declarations and the topic they collide on. Nothing on the wire tells those apart, and no block boundary helps either.

Two smaller consequences of keying on `topic0`. An argument filter is configured by event NAME, so it now applies to EVERY `topic0` that name covers; previously one topic took the filter and any other went into the shared, unfiltered request. And the definitions are compared on what DECODING reads (parameter names, types, `indexed` flags, tuple components, `anonymous`) rather than with a whole-object comparison, so two compilations of the same event that disagree only on `internalType` still collapse instead of being refused.

Asserted against the topics the fetcher REQUESTS (`packages/core/test/fetchFilter.test.ts`), not against the ABI it accepted, because what it accepted was never the thing that was wrong.

This unblocks `abi-versions-are-block-ranged`: with no per-range ABI buckets, two versions of one event land in the same flat list, and a source carrying both could not be constructed at all until this landed.

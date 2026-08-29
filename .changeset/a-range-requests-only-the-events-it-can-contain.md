---
'@etherfold/core': minor
---

A block range now requests only the events that CAN occur in it: a fetched range carries only the topics whose declared block ranges intersect it.

```ts
const abi = [
	{...transferV1, firstBlock: 100, lastBlock: 900}, // the pre-upgrade signature
	{...transferV2, firstBlock: 900}, // the post-upgrade one
] as const satisfies RangedAbi;
```

Blocks `100..899` are now fetched without the post-upgrade `topic0`, and blocks `901..` without the pre-upgrade one. Under argument filters that is a request the range no longer makes at all, because `eth_getLogs` is issued once per (event topic × filter), run sequentially; without filters the topic simply leaves the single request's topic set. Where NO declared event can occur in a range, no `eth_getLogs` call is made for it at all, rather than one with an empty topic list, which a node reads as a wildcard.

This is the half of the ranged model that pays even on a FULL re-index, since every range below a version's `firstBlock` is fetched without its topic, and it needs no cursor relationship and no kept stream.

**Nothing is narrowed that was not DECLARED.** This is the one operation in the ranged design that removes a topic from a request, and an unrequested topic produces no error, no log and no fetch, so afterwards a chain that had none and a request nobody made look identical. Therefore:

- an event with no `lastBlock` is open-ended and is present at EVERY height at or above its `firstBlock`;
- an event that declares NO range is treated as open-ended from block 0, so it is never dropped anywhere — in particular it is NOT narrowed on its contract's `startBlock`, which means "do not look before here" per contract and is minimised across contracts by `defaultFromBlockOf`. Adding a range to one event never changes what an unrelated event fetches;
- a range that CROSSES a boundary requests the union of everything live anywhere in it, and at the upgrade block itself BOTH versions are requested, keeping the one-block overlap that an upgrade at block `b` (`A.lastBlock = b` with `B.firstBlock = b`) is declared with;
- ranges are unioned per `topic0` ACROSS contracts, because the topic filter of a request is global to the request while a range is declared per contract: one address going quiet is not a hole in another address's coverage;
- narrowing is computed on the range actually REQUESTED, which may be smaller than the one asked for when the fetcher adapts to a node's limits;
- nothing is inferred: no narrowing follows from an observed first appearance, from logs seen, or from anything but a declaration.

**A source declaring no range requests exactly what it requested before, topic for topic and request for request, at every height.**

What is measured here is the REQUEST COUNT (see `packages/core/test/fetchFilter.test.ts`). The node's own work — a topic that cannot match still widens the `logsBloom` screen, and so the set of blocks whose receipts are loaded and scanned — is how nodes implement the method and is not a measurement taken against this repository.

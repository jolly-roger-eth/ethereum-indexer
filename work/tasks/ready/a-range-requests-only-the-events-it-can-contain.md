---
title: 'A block range requests only the events that can occur in it'
slug: a-range-requests-only-the-events-it-can-contain
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: [abi-versions-are-block-ranged]
covers: [10]
---

> **SPLIT out of `abi-versions-are-block-ranged` on 2026-08-28.** That task declares the ranges and
> uses them for INVALIDATION; it deliberately leaves the fetch filter alone, so every range still
> carries every topic. This task is the other half: make the filter follow the ranges. It was
> always meant to come last, because it needs the ranges to exist first, which is not the same as
> it being marginal.

## What to build

An event is live over block ranges. Make the FETCH FILTER say so: a request for a range carries
only the events whose live ranges intersect it.

- Below `B.firstBlock`, B's topic0 is absent from the request.
- Above `A.lastBlock`, A's topic0 is absent.
- **An event with NO `lastBlock` is never dropped**, at any height at or above its `firstBlock`.
  Open-ended is the default and the safe case, and this task must not quietly narrow it.
- A range that CROSSES a boundary may simply use the union for that range. Splitting is cheap
  because boundaries are rare, but the union is correct and simpler; either is acceptable, and
  never requesting less than the union is the rule that matters.

**Where the saving actually comes from, and how much of it we can honestly claim.**

**Request count. This one is measured in this repository.**
`generateLogRequestForTopicsAndFiltersCombinations` puts every topic into ONE request when no
argument filters are configured, but emits one request per (event topic × filter), run
sequentially, when they are. So under argument filters a version that cannot occur in a range
still costs its own round trips. The browser shape uses filters, so this is the case the NFT
example actually hits.

**The node's own work. This one is NOT measured here, and must not be presented as though it
were.** A topic that cannot match still costs the node, because it is asked to establish that
nothing matches: block screening is done against the header `logsBloom`, topics are OR'd at
position 0, so each additional topic widens the set of blocks that pass the screen and therefore
the set whose receipts are loaded and scanned, and each adds its own bloom false positives. With a
tight address filter this is mostly false positives, so small but not zero; **address-agnostic**
(`parseAllEventsIrrespectiveOfAddresses`) the topic is the only screen, so carrying a common
topic0 such as `Transfer` widens the scan considerably. This is how nodes implement the method, not
a fact established against this codebase. Do not cite it as one of our measurements. If you want a
number, measure it against a real node and record it as a finding in `work/notes/findings/`.

**Why this pays even when nothing is incremental.** Narrowing needs no cursor relationship and no
kept stream. Even on a FULL re-index it applies, because every range below `B.firstBlock` is
fetched without B's topic. So it is the half of the ranged model that pays on a live upgrade,
which is exactly the case where the boundary could not be declared in advance and the stream had
to be discarded anyway.

**The trap.** Narrowing is the one operation in this whole design that can REMOVE a topic from a
request, which is the failure `an-event-is-never-silently-dropped-from-the-fetch-filter` (already
landed) exists to prevent: a topic that is not requested produces no error, no log and no fetch,
and afterwards "the chain had none" is indistinguishable from "we never asked". So every omission
here must be derived from a DECLARED range and from nothing else. Never infer a range, never
narrow on an observed first-appearance block, and never drop a topic because it has not been seen.

## Acceptance criteria

- [ ] A range below `B.firstBlock` does not carry B's topic0: with argument filters configured it issues no request for it, and without filters it is absent from the single request's topic set.
- [ ] A range above `A.lastBlock` does not carry A's topic0, on both request shapes.
- [ ] An event with no `lastBlock` is present in the requested topics at EVERY height at or above its `firstBlock`.
- [ ] A range crossing a boundary requests at least the union of the events live anywhere in it, so nothing live is ever omitted.
- [ ] At the upgrade block itself both versions are requested, preserving the one-block overlap that `abi-versions-are-block-ranged` established.
- [ ] A source declaring no ranges requests exactly what it requests today, topic for topic.
- [ ] Every omission is traceable to a declared range: no narrowing is derived from observed logs, from a first-appearance block, or from anything the indexer inferred.
- [ ] Asserted against the topics the fetcher REQUESTS, in the style `packages/core/test/fetchFilter.test.ts` established, since the request is where the failure would be invisible.
- [ ] The request-count saving is demonstrated under argument filters: a range that cannot contain an event issues strictly fewer requests than before.
- [ ] Tests cover the new behaviour in the repo's vitest style.
- [ ] A changeset covers the behaviour change.

## Blocked by

- `abi-versions-are-block-ranged`. It declares the range fields, the normalisation and the refusal
  rules this task filters on. There is nothing to narrow against until it lands.

## Prompt

> Make a block range request only the events that can occur in it, in the `etherfold` monorepo.
>
> FIRST, check this against current reality. It rests on two readings. That
> `abi-versions-are-block-ranged` has landed and a source now carries per-event live ranges with an
> inclusive `firstBlock` and an optional inclusive `lastBlock`, normalised, with gaps refused. And
> that `generateLogRequestForTopicsAndFiltersCombinations` puts every topic in ONE request when no
> argument filters are configured, but emits one request per (topic × filter), run sequentially,
> when they are. Re-run both rather than trusting them; if either has changed, route to
> needs-attention rather than building on a stale premise.
>
> Assert on the topics the fetcher REQUESTS, not on the ABI it accepted.
> `packages/core/test/fetchFilter.test.ts` is the prior art and drives a real `getLogEvents`
> through a recording provider, reading `topics[0]` off the captured `eth_getLogs` calls. That is
> the right instrument here, because a wrongly omitted topic produces no error and no fetch, and
> afterwards nothing distinguishes "the chain had none" from "we never asked".
>
> This is the ONE operation in the ranged design that removes a topic from a request, so it is the
> one that can reintroduce the exact failure
> `an-event-is-never-silently-dropped-from-the-fetch-filter` was built to eliminate. Every omission
> must follow from a DECLARED range and nothing else. Do not infer a range, do not narrow on an
> observed first-appearance block, and do not drop a topic because you have not seen it. An event
> with no `lastBlock` is open-ended and must never be dropped above its `firstBlock`.
>
> Keep the one-block overlap at an upgrade: at block `b` both the old and the new event are
> requested, because the upgrade transaction sits mid-block and a transaction before it still fires
> the old event. A range that crosses a boundary may just use the union for that range; requesting
> more than necessary is safe, requesting less is not.
>
> Be honest about the two savings. Request COUNT under argument filters IS measured in this
> repository and you should demonstrate it. The NODE's own work (a topic that cannot match still
> widens the `logsBloom` screen and so the set of blocks whose receipts are loaded and scanned) is
> how nodes implement the method and is NOT measured here; do not present it as one of our
> measurements, and if you want a number, measure it against a real node and record a finding.
>
> Add a changeset. Record any non-obvious in-scope decision in a `## Decisions` block in your final
> report, and do not commit without confirmation.

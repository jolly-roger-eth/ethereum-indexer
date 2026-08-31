---
title: Node-compatible log API (eth_getLogs over the indexed subset)
slug: node-log-api
needsAnswers: true
taskedAfter: [historical-state-database, indexer-server-feed]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK, stripped by the apply rung on full resolution.
  These are genuine policy decisions about what the API refuses, not implementation detail.
  The schema decision in "Implementation Decisions" is NOT blocked by them and must be
  honoured by the historical-state design even if this spec is never built.
-->

## Open questions

AUDITED against what landed since (the generation model, ADR-0033/0034 per-event invalidation, the
split fetcher/stream-builder). Questions 1-5 are all still genuinely open and none has been answered
elsewhere; 6-9 are NEW and three of them are load-bearing enough that building without them would
ship the silent incompleteness this spec exists to refuse.

1. A request with **no `address` filter**: reject it, or serve it as "everything I watch"? (Recommendation: reject. A node would return all contracts' logs, so answering with our subset is a silently incomplete answer.)
2. A `toBlock` **above our indexed head**: reject, or clamp and report the head? (Recommendation: reject, consistent with every other seam in this design refusing rather than truncating.)
3. Are `eth_newFilter` / `eth_getFilterChanges` / `eth_uninstallFilter` in scope, or is v1 `eth_getLogs` only? NARROWED since it was written: the retraction-aware STREAM is already owned by `indexer-server-feed` story 2 and ADR-0007's `fast` lane, so the mechanism exists and the only question left is whether to ALSO front it in node-compatible clothing.
4. Does the API require auth, or is it public? A public `eth_getLogs` is the point (it is a service to dapp frontends), but it is also an unbounded read surface.
5. Is the transport plain JSON-RPC 2.0 on a single endpoint (batch requests included), and does it need to satisfy enough of the surface for viem/ethers to treat it as a provider (`eth_chainId`, `eth_blockNumber`)?
6. **Is a JSON-RPC BATCH one read unit of work?** (The GENERATION half of this question is now
   DECIDED and only the batch half is open: `indexer-server-feed` decides that a read serves the
   CANONICAL generation and ADVERTISES the generation identity it answered from, leaving the consumer
   to decide what a change means. Answer this surface the same way rather than diverging — the open
   part is where an `eth_getLogs` response can carry that identity at all, since the JSON-RPC result
   shape is a node-compatible array and a client library will not look outside it. A header is the
   obvious candidate and it is a decision, not a detail.) `a-reconfigure-is-not-an-outage` makes reads resolve the CANONICAL POINTER once per read unit of work and hold it, so a query cannot straddle a promotion — but it pins that for the GraphQL layer, and this is a SECOND read surface that nobody has pinned. A JSON-RPC batch request (question 5) makes it sharper: one HTTP request carrying several calls has no defined unit of work at all. Note the word collision to avoid in the answer: the canonical VIEW (ADR-0006, `alive` rows under a gate) and the canonical POINTER (the generation that answers) are different objects.
7. **What carries the SOURCE DECLARATION to the tier that serves this?** The refusal predicate below needs addresses, the `topic0` set, the declared ranges and the argument filters. The server holds none of them: `WireContext` is `{source: SourceHashEntry[], config: string}` — HASHES, not values — and `StreamBuilder` deliberately keeps `@etherfold/server` free of an ABI type parameter because "the server never inspects a log". So "reuse the predicate that already exists in the engine" is not reachable from where this API is served, and something must carry the declaration there.
8. **What do `safe` and `finalized` resolve to (story 3)?** The core has a CONFIGURED `finality` DEPTH and no chain-reported finalized head anywhere, so the two tags have no referent today. Is `finalized` simply `latestBlock - finality`, is it fetched from the node, or are those tags refused?
9. **Does the indexed head go BACKWARDS under the `immediate` promotion policy, and what does this API answer while it does?** `immediate` promotes a generation that has caught up to nothing, so a request story 4 previously served starts being refused. That may be correct (it IS behind), but it must be a decision, since `immediate` is opt-in and a dapp frontend pointed at the API sees its history vanish and return.

<!-- /open-questions -->

## Problem Statement

Public RPC providers aggressively limit `eth_getLogs` (block-range caps, result caps, rate limits), which is the single most painful constraint for any dapp that needs historical logs. The indexer-server already holds exactly those logs for the contracts it watches, fully decoded and canonical, so a consumer forced to go to a provider for data we already have is paying for a worse copy of it.

## Solution

The indexer-server exposes `eth_getLogs` with node semantics, restricted to the subset it indexes, and **refuses** anything outside that subset rather than answering incompletely. A caller can point a normal EIP-1193 client at it and get logs for the watched contracts with no range or result caps beyond our own.

The refusal is the product. An `eth_getLogs` that silently returns a subset of the truth is worse than no API at all, because the caller cannot tell.

## User Stories

1. As a dapp frontend, I want to call `eth_getLogs` against the indexer-server for a watched contract, so that I am not subject to a provider's range and result caps.
2. As a dapp frontend, I want an out-of-subset request (unwatched address, unwatched event signature, filtered-out argument) to be **rejected with a clear error**, so that I never receive a silently incomplete log set.
3. As a dapp frontend, I want block tags (`latest`, `earliest`, `safe`, `finalized`) resolved against the indexer's own heads, so that "latest" means what the indexer can actually answer for.
4. As a dapp frontend, I want a request whose range extends beyond the indexed head to be refused rather than truncated, so that being behind the tip is visible instead of silent.
5. As an in-browser indexer (ADR-0002), I want to use the indexer-server as my EIP-1193 log source, so that I sync far faster than against a rate-limited public provider while keeping the option to fall back to a real node.
6. As an operator, I want the API to answer from the same canonical view the feed uses, so that it cannot disagree with the feed or with the state.
7. As an operator, I want the log store's schema to make address and topic filtering an indexed lookup, so that the API does not degrade into table scans. (A stated DEPENDENCY, not a deliverable of this spec: `indexer-server-feed` story 8 owns those columns and their index, and this spec's Implementation Decisions is where their shape was decided. It is listed as a story because the API is worthless without it, and it is why this spec is now `taskedAfter` that one.)

## Implementation Decisions

- **Serve from the canonical view** defined in ADR-0006 (`WHERE alive AND blockNumber BETWEEN ...`), never from the emission stream. `eth_getLogs` returns canonical logs only; `removed: true` belongs to the filter-changes API, not this one.
- **Schema, decided now even though the build is later** (free at design time, a migration over millions of rows afterwards): the log table stores `address` and `topic0..topic3` as **columns**, not a JSON blob, with a composite index on `(address, topic0, blockNumber)`. `topic1..topic3` stay unindexed and are filtered after the range scan, because indexing all four roughly doubles the log table's index footprint against D1's 10GB ceiling for little practical gain.
- **The subset predicate must be RANGE-AWARE, and the two-part form below is now STALE.** When this was written the indexed subset really was `address ∈ contracts AND topic0 ∈ ABI events`. ADR-0033 and ADR-0034 changed that: an **event block range** is a fetch fact, a range carries only the events whose declared ranges intersect it, and `requestableRangesPerTopic` means the fetcher issues no `eth_getLogs` call at all where no declared event can occur. So the old predicate ACCEPTS a request for blocks in which that event was never fetched, and answers it incompletely — precisely the silent incompleteness this spec exists to refuse, arriving through the check that was supposed to prevent it. The predicate is `address ∈ contracts AND topic0 ∈ ABI events AND [fromBlock, toBlock] ⊆ the declared live range of that event`. (See also open question 7: the tier that serves this cannot currently evaluate any of it.) Two further cases complicate the check and are the likeliest source of a wrong answer:
  - **All-contracts mode** (`AllContractData`: an ABI with no addresses) watches every address for those events, which inverts the check (address unconstrained, topic0 constrained).
  - **`parseConfig.filters`** (indexed-argument filters) narrow further, e.g. only `Transfer` where `from == X`. A request for all `Transfer` logs is then unanswerable even though its address and topic0 both look valid.
- **Encoding is strict**: `QUANTITY` hex with no leading zeros, fixed-width `DATA`, per the JSON-RPC spec. `blockTimestamp` should be included, since the indexer has it (ADR-0002 consequences).
- **The `logValues` conflict is still LIVE on this path, but the remedy below is no longer the repo's answer and must be reconciled.** The root `TODO.md` item ("NumberifiedLog / LogEvent could have fields removed, configuration on config.stream") still exists, and `logValues` is still applied inside `LogEventFetcher.parse` — on the FETCHER side, which in a split deployment is the SENDER, so a projection that drops `topics` or `data` reaches the server already applied and the stored logs cannot answer `eth_getLogs` at all. What changed is the shape of the fix. `the-stream-stores-only-what-the-node-said` DECIDED the same question for the client stream and decided it the other way: `logValues` is a PROCESSOR-facing projection only, and storage always keeps the raw log. It explicitly REJECTED the interlock this bullet prescribes ("refusing a projection that drops `topics`/`data` whenever a `keepStream` is configured") on the ground that it turns a storage-size knob into a constraint on what handlers can be written. So this bullet's "the config must refuse to trim while the node API is enabled" is the rejected shape, one seam over. The consistent answer is almost certainly to extend that decision across the wire — project for the processor, never for what is stored or sent — which discharges the conflict entirely rather than adding a mode interlock. Flagged rather than decided here, because the wire is explicitly out of that spec's scope and this is not the spec that owns `parse`. `docs/design/historical-state-database.md` carries the same superseded mutual-exclusion sentence and needs the same correction.

## Testing Decisions

- The **refusal matrix** is the heart of the test suite, not the happy path: unwatched address, unwatched topic0, watched event whose indexed-arg filter excludes the request, no-address request, range past the head, `blockHash` for an unknown or reorged-out block.
- Encoding conformance: quantities and data round-trip against a real node's responses for the same filter, so a client library cannot tell the two apart.
- Equivalence: for a filter fully inside the subset and a range fully below the indexed head, our answer must equal a real node's answer for the same filter, log for log and in the same order.

## Out of Scope

- Any RPC method that requires chain state (`eth_call`, `eth_getBalance`, storage proofs). This is a log API, not a node.
- `eth_getFilterChanges` and friends, pending open question 3, though ADR-0006 makes them cheap since the emission stream is exactly that API's semantics.
- Serving logs for contracts we do not index, in any form, including proxying to an upstream provider. That would make the completeness guarantee unverifiable.

## Further Notes

- Depends on the indexer-server existing, hence `taskedAfter: historical-state-database`. The **schema decision above is not deferred**: it must be honoured by that design, since retrofitting topic columns later is a migration over the whole log table.
- The value is larger than the API itself: it makes the indexer-server a drop-in log source for the in-browser indexer (ADR-0002), which keeps the decentralization story (run your own, or fall back to a node) while removing the public-provider bottleneck that makes client-side indexing slow.

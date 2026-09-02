---
title: 'Nothing bounds the SIZE of an ingest batch, on either half of the wire, and the first sync is where that lands'
slug: nothing-bounds-the-size-of-an-ingest-batch
observed: 2026-08-25
source: 'noticed while building task:agnostic-log-fetcher, and confirmed by reading: `RangeLogFetcher` targets 80% of `maxEventsPerFetch` (default 10000) per fetch; `packages/server/src/api/ingest.ts` reads `c.req.text()` with no size check and returns no 413; no body limit is configured in `platforms/nodejs` or `platforms/cf-worker`. The FAILURE is inferred from those facts plus published Worker request-size limits, and has NOT been measured against a real deployment.'
---

Both halves of the ADR-0004 wire bound the batch by BLOCK RANGE and neither bounds it by BYTES.

- The sender aims for a range holding ~8000 logs (`RangeLogFetcher` targets `percentageToReach`% of `maxEventsPerFetch`), and ships each log DECODED: `args` plus the `data` and `topics` those args were decoded from. ADR-0004 accepts that restatement deliberately, so a batch is roughly twice the size of the raw logs it carries.
- The receiver reads the whole body into memory (`await c.req.text()`, then `parseWireBatch`) before it can check anything about it, and answers no `413`.
- Neither host sets a body limit.

Steady state never approaches this: a range that spans the seconds since the last cycle holds a handful of logs. The FIRST SYNC does, because it starts at the source's `startBlock` and the fetcher will happily ask for the whole history in ranges of up to 8000 events. On a Worker, where request-body and memory limits are real and small, that is the plausible first failure of a new deployment, and it would present as an opaque platform error rather than as anything either package says.

What makes this worth writing down rather than fixing in place: the fix is NOT to deliver part of a range (that is the one thing ADR-0004 forbids, since the receiver reads a short payload as a reorg and deletes state). It is to lower `toBlock` until the payload fits, which is the same mechanism the truncation guard already uses and would need a byte estimate the fetcher does not currently compute. So it is a real design decision with an owner: probably `fetcher-platform-adapters` (a Worker knows its own limits, a Node process does not have them) or a companion task on the receiving side for the `413`.

Two related unknowns nobody has measured: what a decoded-batch byte size actually is per log for a realistic ABI, and where the receiving host's practical ceiling sits.

## Update (2026-08-26, `fetcher-platform-adapters`)

The Node host adapter landed and did NOT close this. What it did do is expose the two levers that narrow a range, `MAX_EVENTS_PER_FETCH` and `MAX_BLOCKS_PER_FETCH`, as ordinary deployment configuration. Both work the legal way, by lowering `toBlock`.

That is a mitigation and not the fix, and the difference is worth keeping straight: those knobs bound a batch by EVENT COUNT and BLOCK SPAN, which are proxies. Neither is a bound in bytes, and neither can be, because the size of a decoded batch is not known until it is built. So the guess is still a guess: an ABI with large `bytes` arguments defeats a count-based bound at any setting.

Where the real fix belongs, on the evidence of building the adapter: **not in a host**. An adapter cannot see the payload (it calls `fetchAndPush()` and is handed an outcome), so the only thing it can do is guess in advance, which is what it now does. Bounding by bytes means lowering `toBlock` after ESTIMATING the payload, and the estimate can only be computed where the payload is built, inside `LogFetcher.fetchCompleteRange`, next to the truncation guard that already lowers `toBlock` for the other reason. The receiving half of it (a `413`, so the ceiling is stated rather than discovered) belongs with the server. Two owners, neither of them a host, which is why this note stays open.

One thing DID change about where this is likely to bite, and it is worth correcting the note's own framing. There is no serverless FETCHER, of either kind: a cron cannot follow a chain, so the fetching half runs where a process can sit in a loop, and the serverless runtime hosts the RECEIVER. The first sync therefore does not blow up inside a Worker's fetch; it arrives at one, as a single enormous POST from a Node fetcher into a Worker-hosted indexer-server that reads the whole body into memory before it can check anything about it and answers no `413`. That is exactly the failure this note described, with the two halves now firmly on opposite sides of a real network, so the request-size limit is a hard one rather than a memory guess.

The other deployment worth sizing is the COMBINED one (`createDirectIngestion`, one Node process running both halves): no request, no body limit, and the bound becomes the process's own memory while a batch is held decoded.

## Update (2026-09-02, `d1-limits-reach-the-stores-batch-bounds`): the same unbounded batch also blows a QUERY budget, not only a byte one

A second, independent ceiling on the receiving Worker, on the same unbounded batch. D1 caps QUERIES PER WORKER INVOCATION (50 on Free, 1,000 on Paid), and folding one wire batch issues one query per statement per batch call: a batch of 500 blocks is ~1,500 statements, so it exceeds the Free cap however small the payload is in bytes. No BATCH BOUND can fix it, by construction — `maxStatementsPerBatch` bounds ONE `batch()` call and the fold issues as many as the work needs — which is what `DEFAULT_BATCH_BOUNDS`' docstring already says and what the D1 adapter now repeats (`platforms/cf-worker/src/d1.ts`).

The PRUNE half of it IS bounded now, because `prune` takes a `maxVersions` budget the host sets and `d1PruneBudget(plan)` sizes it from the plan's query cap. The INGEST half is not, and it has the same owner as this note's byte problem: what bounds it is how much one wire batch carries, which is decided where the payload is built. Same fix, second reason to want it.


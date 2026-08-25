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

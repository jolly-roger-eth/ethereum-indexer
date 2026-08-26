---
title: When the indexer-server gains a state read API, that read must carry its tx-inclusion verdicts
slug: a-server-read-must-carry-its-tx-verdicts
---

## The constraint to remember

`checkTxInclusion` (`@etherfold/core`) lets an app decide whether the indexed state it is rendering already accounts for its own pending transactions, so it knows whether to lay an optimistic update over them. The decision is only sound if the verdict and the ROWS come from the same snapshot: a cursor read separately can have moved past the rows it is compared against, and a verdict computed from a later cursor drops an overlay whose effect is not in those rows yet.

In-browser this holds by construction (`createIndexerState().checkTxInclusion` reads the cursor the hook is holding). Server-side there is nothing to hold it against yet: `@etherfold/server` has `/status`, `/admin/setup` and `/ingest`, and no state read API at all. So the constraint has nowhere to live and this is a note rather than a task.

## What it means for the read API when it exists

- The read takes a **witness**: the caller's own pending transaction hashes, which is a handful, and gets back a per-hash verdict beside the rows. Not the other shape (shipping the whole unconfirmed window's hash set with every read), which is bounded by the finality depth rather than by the caller's pending set and is far larger for the same answer.
- The verdicts are computed **in the same transaction or snapshot as the rows**, not from a cursor read before or after.
- `/status` alone is not a substitute, however convenient: two requests, two snapshots, and the gap between them is exactly the wrong-answer window.

## Why it is worth writing down now

The pull is toward adding it later as a second endpoint, because that is the smaller diff and it looks equivalent. It is not equivalent, and the failure it produces is silent: an optimistic update counted twice in a UI, which looks like a processor bug and will be hunted for in the processor.

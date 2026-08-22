---
title: Log ingestion endpoint, authoritative about the cursor
slug: ingest-wire-receiving-side
spec: historical-state-database
blockedBy: [sql-backed-event-processor, agnostic-server-skeleton]
covers: [5]
---

## What to build

The ingestion endpoint where raw logs enter the server, and the half of the wire contract that makes losing an event structurally difficult rather than merely unlikely.

**The server is authoritative about the cursor.** A batch is a contiguous block range, `{context: {source, config}, fromBlock, toBlock, latestBlock, logs[]}`. If its `fromBlock` is not the server's own `expectedFromBlock`, the batch is **rejected with a `409` carrying the expected value**, so the sender re-sends from there. That single rule is the resumption protocol, and it is also why no dedupe table is needed: a re-sent batch after a lost acknowledgement fails the check and is corrected instead of being applied twice, so at-least-once on the wire becomes exactly-once in effect. **The cursor is the idempotency key.**

Three further rules, each of which exists to stop a silent failure:

- **Completeness is an invariant, not a flag.** A payload contains every log in `[fromBlock, toBlock]`. A truncated fetch is expressed by lowering `toBlock`, never by delivering a partial range. Do not add a `complete: true` field: it would always be true and would therefore carry no information.
- **No reorg information crosses the wire.** No `removed` markers, no `unconfirmedBlocks`. The server derives them, so the reorg logic exists in one place.
- **`context.source` and `context.config` are validated on every batch.** A mismatch is a loud wire error, not silently corrupted state. (`context.processor` cannot be asserted by the sender, which has no idea which processor version runs here.)

The engine already enforces the cursor rule internally: `generateStreamToAppend` throws unless the batch starts at `getFromBlock(lastSync, ...)`. Build the endpoint on that existing primitive rather than adding a second, parallel mechanism.

## Acceptance criteria

- [ ] A batch starting exactly at `expectedFromBlock` is applied, advancing state and the cursor together.
- [ ] A batch starting anywhere else is rejected with `409` and the server's expected value, and **nothing is applied**.
- [ ] Re-sending an already-applied batch (the lost-acknowledgement case) does not double-apply: it is rejected and corrected.
- [ ] A batch whose `context.source` or `context.config` does not match is rejected with a distinct, loud error.
- [ ] A reorg is derived server-side from raw logs alone, with no reorg fields on the wire, and reaches the same result as the engine's own stream logic.
- [ ] An absence-derived revert is surfaced distinctly from a contradiction-derived one (the engine already reports which, via the `reorg.cause` field added in `ca6f981`), so operators can see a rate of the dangerous kind.
- [ ] The endpoint requires authentication, and an unauthenticated caller cannot advance the cursor.
- [ ] Tests cover the full sequence: apply, re-send, gap attempt, context mismatch, reorg.

## Blocked by

- `sql-backed-event-processor` (something must apply the logs).
- `agnostic-server-skeleton` (the app this route lives in).

## Prompt

> Build the log ingestion endpoint for the indexer-server in the `etherfold` monorepo.
>
> FIRST, check this task against current reality: read `docs/adr/0004` in full, since it is this task's specification, and confirm `sql-backed-event-processor` and `agnostic-server-skeleton` landed as assumed. If not, route to needs-attention.
>
> The receiver owns the cursor. Accept `{context: {source, config}, fromBlock, toBlock, latestBlock, logs[]}`; if `fromBlock` is not the server's own `expectedFromBlock`, reject with `409` and the expected value so the sender re-sends from there. Build this on the existing primitive rather than a new one: `generateStreamToAppend` in the core package already throws unless the batch starts at `getFromBlock(lastSync, ...)`. Read that function and its tests before writing anything.
>
> Understand why there is no idempotency key: the cursor IS the key. A re-sent batch after a lost acknowledgement fails the `expectedFromBlock` check and is corrected, so it cannot be applied twice. Do not add a dedupe table.
>
> Do not add a `complete: true` field to the envelope. Completeness is an invariant (the payload holds every log in the range) and truncation is expressed by lowering `toBlock`; a flag that is always true carries no information. Likewise no `removed` markers and no `unconfirmedBlocks` on the wire: the server derives reorgs itself, so that logic lives in exactly one place.
>
> Validate `context.source` and `context.config` on every batch and reject loudly on mismatch. This closes a hole that `docs/reviews/todo-triage.md` found in every existing persistence layer, where a persisted `lastSync` is reused without checking it belongs to the current source.
>
> Note the engine now reports HOW a reorg was concluded (`reorg.cause` of `contradiction` or `absence`, added in `ca6f981`). Absence is an inference and is indistinguishable from a sender that under-delivered a range, so surface it distinctly and countably rather than folding both into one log line: a rising rate of absence-driven reverts means truncation or misconfiguration, not chain activity.
>
> Test the whole sequence, add a changeset, and do not commit without confirmation.

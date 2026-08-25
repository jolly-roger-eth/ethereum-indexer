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

## Decisions

- **`StreamBuilder` lives in `@etherfold/core`, not in `@etherfold/server`.** The two primitives it must not duplicate (`generateStreamToAppend`, `getFromBlock`) plus `defaultFromBlockOf` and `indexerMatches` are engine logic; a copy in the server package would be the "second, parallel mechanism" ADR-0004 exists to avoid. Alternative considered: export the two primitives from core and write the receive loop in the server, which would have duplicated the source-hash/fresh-cursor/discard logic. Touches: `agnostic-log-fetcher` (its counterpart), `server-platform-adapters` (hosts wire it in), and `indexer-server-feed` (ADR-0006's stored emission stream belongs to this same object when it is built). I also moved `indexerMatches` and the `defaultFromBlock` derivation out of `EthereumIndexer` into `internal/engine/utils.ts` so both shapes read one implementation. `@etherfold/server` gains `@etherfold/core` as a runtime dependency; `platformAgnostic.test.ts`'s exhaustive dependency list is updated with the reason.
- **The wire carries DECODED `LogEvent`s, not the `eth_getLogs` JSON-RPC shape.** ADR-0004 says "raw logs", which I read as *raw as opposed to reorg-annotated* (no `removed`, no `unconfirmedBlocks`), not *undecoded*. The receiver's primitive takes decoded events, `captureStream` already produces them, and the landed `processor-sqlite/test/deployment-shapes.test.ts` already pins this exact shape crossing a wire. Alternative: ship undecoded logs and decode server-side, which would move `LogEventFetcher`'s decoding (currently provider-bound) to the receiver for no gain, since both halves hold the ABI anyway. Cost: `args` restates what `data`/`topics` encode, so payloads are larger; both are still carried, which ADR-0006 will need. **Touches `agnostic-log-fetcher` directly** — I documented it on the `WireBatch` type, and ADR-0004's wording is worth a one-line clarification by a human.
- **Auth fails CLOSED on a missing `INGEST_TOKEN`: every caller gets `401`.** The retired server generated a key at boot and printed it to stdout, which `docs/reviews/server-cli-batch.md` LOW-1 flagged; that is not repeated. Alternatives: `503` "misconfigured" (more accurate about *why*, but weakens the invariant "an unauthenticated caller cannot advance the cursor" into two codes) or allowing anyone when unset (rejected outright). This is a user-visible default and a new env key. The compare is a hand-written constant-time XOR loop, because `node:crypto` is forbidden in this package (a test asserts it).
- **A context mismatch is `400`, not `409`.** `409` is the one and only RESUMABLE refusal: it carries `expectedFromBlock` and the sender's whole recovery is to re-send from there. A foreign `{source, config}` is a misconfiguration no block number fixes, and a sender that treated the two alike would retry forever. Malformed envelopes join it at `400`. Touches `agnostic-log-fetcher`'s retry policy.
- **A new refusal that ADR-0004 does not name: `InvalidBatchError`.** It rejects a range that is not a range, a log outside `[fromBlock, toBlock]`, and a log already marked `removed`. The last two are the enforcement side of two ADR-0004 invariants that would otherwise be silently violated: `groupLogsPerBlock` *drops* `removed` events, so a sender shipping retractions would never learn they went nowhere. Alternative: accept and ignore, which is how a truncating fetcher stays invisible.
- **Reorg counters live in the DATABASE (`Meta`), not in process memory, and are reported on `/status`.** ADR-0004 asks for absence-driven reverts to be "logged loudly and counted"; what an operator needs is a *rate*, and a counter that resets when a Worker isolate is recycled measures the isolate. This deliberately differs from `lastError`, which is in memory for the opposite reason (it often records a failure to reach the database). It is written after the batch, best-effort, and a failure to count never fails an ingestion that succeeded. It does **not** affect `healthy`: an absence-driven revert is a signal to investigate, not a fault that should get the server restarted. `platforms/cf-worker/test/status.test.ts` pins the status shape and is updated.
- **`getIngestion` is OPTIONAL, and a server without one answers `501`.** `/status` and `/admin/setup` are useful on a processor-less server and every existing host builds one that way. Alternative: not registering the route (a `404`, which reads as "wrong URL") or making it required (breaks `platforms/*` and every existing caller). Touches `server-platform-adapters`, which owns wiring a processor into the Node and Worker hosts — I deliberately did **not** add a pass-through to `startServer`, since a pass-through without processor-module loading is half a feature and that task owns it.
- **`GET /ingest` can WRITE.** Reading `expectedFromBlock` reconciles a persisted cursor belonging to another source/config/processor version by calling `processor.clear()`, exactly as `EthereumIndexer.load()` does. Alternative: report a number derived from state the next `POST` is about to wipe, so the read and the write disagree. Nothing is lost that was not already invalid. Documented at the choice site.
- **The wire uses the TAGGED BigInt codec (`{__bigint__: "…"}`), and that codec now lives once in `@etherfold/core`.** A decoded log's `args` hold BigInts, `JSON.stringify` throws on those, and the `"123n"` suffix pair (`bnReplacer`/`bnReviver`) would revive a contract-emitted string ending in `n` as a number — a failure mode `packages/core/src/utils/bigint.ts` already documents. Rather than add a second identical tag codec, I moved `@etherfold/processor-entities`' private copy in `cursor.ts` onto the new `taggedBnReplacer`/`taggedBnReviver`. Coherence note: core now carries two BigInt JSON conventions on purpose — the suffix one describes data this repo's storage adapters have already persisted and cannot be changed without rewriting it; both are documented against each other. Touches `@etherfold/processor-entities` (internals only, no API change) and `agnostic-log-fetcher`, which must use `serializeWireBatch`.
- **Coherence: `StreamBuilder` claims the glossary's `stream-builder` name while owning only half of it.** `CONTEXT.md` defines a stream-builder as owning `expectedFromBlock`, reorg derivation *and* the stored emission stream. The stored stream is ADR-0006 / the `indexer-server-feed` spec and is not built. I took the name rather than inventing a second one, because the missing half belongs to this same object when it arrives; `CONTEXT.md` is updated to say so explicitly, along with new entries for `reorg cause` and "the cursor is the idempotency key".

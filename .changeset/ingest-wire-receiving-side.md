---
'@etherfold/processor-entities': patch
'@etherfold/core': minor
'@etherfold/server': minor
---

The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

`@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

`@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

`generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

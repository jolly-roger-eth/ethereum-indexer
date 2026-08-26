# @etherfold/server

## 0.1.0

### Minor Changes

- 086de7b: Adds the platform-agnostic indexer-server and its Node host, and a `serve` command to the CLI.

  `@etherfold/server` is a Hono app that receives its database and environment by injection (`{getDB, getEnv}`) and imports no runtime: no Node built-ins, no Cloudflare types, no concrete driver. It ships the fixed-table schema and a `/status` route reporting database reachability, whether the schema is applied and at which version, and the last error this process saw. `POST /admin/setup` applies the schema. A test asserts the package names no runtime, so the property is checked rather than trusted.

  `@etherfold/platform-nodejs` is the Node host: a libSQL-backed `RemoteSQL`, environment from the process, served over HTTP. It applies the schema at startup by default (one process owning one file), which `autoSetup: false` disables.

  The CLI gains `etherfold serve`, which runs that host, so a project can start an indexer-server without wiring anything. `etherfold index` remains the default command, so existing `etherfold -p <processor> -f <folder>` invocations are unchanged.

  A Cloudflare Worker host also exists, at `platforms/cf-worker`, and is not published: it is a deployable, not a library.

  The server is a skeleton. It serves status and schema only: no chain logic, no store wiring, no feed. Those arrive with the tasks that follow ADR-0003.

- b40298e: **Asking where the next batch starts is now `POST /ingest/expected-from-block`, not `GET /ingest`.**

  Answering that question can WRITE: it reconciles a persisted cursor belonging to a different source, config or processor version by calling `processor.clear()`, exactly as `load()` does in the single-process shape. A `GET` that writes is a trap whatever its justification — proxies, browser prefetch, link scanners and retrying clients all assume a `GET` is safe, and HTTP says it is — so the method now matches what it does.

  The token guard is registered on BOTH `/ingest` and `/ingest/*`: Hono matches `/ingest` exactly and would not have covered the new sub-path, which would have left half the fetcher-facing surface open while looking guarded. A test asserts a 401 on each.

- e0a6480: The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

  `@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

  `@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

  The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

  `generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

  A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

  Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

### Patch Changes

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [31833b6]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [33afc5b]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
  - @etherfold/core@0.7.0

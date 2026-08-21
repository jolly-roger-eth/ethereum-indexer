# The log-fetcher wire contract: the receiver owns the cursor

The log-fetcher pushes batches to the indexer-server, but the **server** is authoritative about where the next batch must start. A batch is a contiguous block range, `{context: {source, config}, fromBlock, toBlock, latestBlock, logs[]}`, and the server rejects any batch whose `fromBlock` is not its own `expectedFromBlock`, answering with the value it expects so the fetcher can re-send from there. We chose this because the core engine already enforces exactly that check (`generateStreamToAppend` throws unless `newLastFromBlock === getFromBlock(lastSync, ...)`), so the wire is built on a primitive that exists rather than a second, parallel mechanism.

## Considered Options

- **Pure push, sender owns delivery state.** Requires the fetcher to durably track a per-server cursor and to decide what a lost acknowledgement means. Rejected: it makes the stateless component stateful.
- **Pure pull.** Loss becomes impossible by construction, but a serverless server can only pull on a cron tick, so latency floors at the cron granularity. Rejected for latency.
- **Push with correction (chosen).** Push latency with pull safety.

## Consequences

- **The cursor is the idempotency key.** A re-sent batch after a lost acknowledgement is not applied twice: it fails the `expectedFromBlock` check and is corrected. At-least-once on the wire becomes exactly-once in effect, with no dedupe table and no explicit key.
- **Completeness is a contract invariant, not a flag.** A payload contains every log in `[fromBlock, toBlock]`. Truncation is expressed by lowering `toBlock`, never by delivering a partial range, and a provider truncation signal is a hard error for the fetcher. A `complete: true` field would always be true and would therefore carry no information.
- **No reorg information crosses the wire.** No `removed` markers, no `unconfirmedBlocks`. The server derives them. This reverses user story 5 of `work/specs/ready/historical-state-database.md`.
- `context.processor` cannot be asserted by the fetcher, which has no idea which processor version is running. The fetcher asserts `source` and `config` only, and the server owns the third identity.
- **The server infers a reorg partly from absence**, since logs alone cannot express "this block exists and has nothing for you". This is the inference that produced the bug fixed in `d24872f`, so a revert concluded from absence rather than from a hash contradiction must be logged loudly and counted: under normal operation it is rare, and a spike means truncation or misconfiguration. If that signal ever fires, the escalation is a `verifyBlocks` cross-check, where the server names the unconfirmed blocks it holds and the fetcher returns their headers, so that absence must be corroborated by `eth_getBlockByNumber` (a different RPC method, not subject to the `eth_getLogs` result cap) before any state is deleted. Deliberately deferred, not dropped.

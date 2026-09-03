---
'etherfold': minor
'@etherfold/platform-nodejs-fetcher': minor
---

`etherfold run` follows a chain, folds a processor into SQLite and answers HTTP, in ONE process.

The command the whole set exists for, and the default thing to reach for. One terminal invocation, no knowledge required of how the components divide:

```sh
etherfold run -p ./dist/processor.js --store sqlite --db file:./etherfold.db -n https://rpc.example --port 2000
```

**It is ASSEMBLY, and every part of it already shipped.** A log-fetcher pushing into a stream-builder through the in-process direct ingestion (the two ADR-0003 halves with the transport removed), the stream-builder folding an entity processor into a versioned state store, that store's libSQL handle handed to the server as its database, and the whole thing driven by the fetcher host's loop. It is the SAME assembly `build` uses — one `prepareIndexing`, one `driveCycles` — with one difference: `build` aborts on the first report that reached the tip, and `run` does not. No component is implemented twice, and the browser's engine is constructed nowhere in the command path.

- **It does not stop at the tip.** It backs off to the poll interval and keeps following. Stopping is a SIGNAL (exit `0`, with the cycle in flight allowed to finish), or a refusal no waiting fixes (non-zero), and nothing else. A retryable failure is retried indefinitely on the escalating, capped backoff rather than after N attempts, so a transient node outage does not leave a stopped indexer behind.
- **It serves, on the handle it folds into.** One database, built once by the command: the store writes through it and the server answers over it, rather than two connections with two views of it.
- **`/status` reports a cursor that ADVANCES**, through the `getCursorReport` seam: `{lastFromBlock, lastToBlock, latestBlock, unconfirmedBlocks}`. Four numbers and never the stored cursor itself, which is a serialized sync structure carrying a window of decoded events — `/status` reports what a host hands it verbatim (ADR-0047), so bounding it is the host's job.
- **A `run` process hosts no remote writer.** It fetches for itself, so no ingestion capability is injected into its server: an authenticated call to `/ingest` answers `501 ingestion-not-configured`, an unauthenticated one still answers `401`, and `--ingest-endpoint` / `--ingest-token` are refused because there is no wire to configure. The command that receives pushes is `index`.
- Every input resolves through the same configuration path as the other commands (flags first, environment behind them), and a missing node URL, database or processor is a refusal naming the flag AND the variable, raised before the chain is dialled, a database is opened or a port is bound.

New API on `etherfold`: **`run`** (assemble, serve and start following; returns a handle with `url`, `db`, `store`, `stopped` and `stop()`), **`runMain`** (the process shape, resolving the exit code) and **`readCursorReport`**. `PreparedIndexing` gained `db` (the one handle) and `config` (the command's resolved row), and its `index()` now follows the tip when the command is `run`.

`@etherfold/platform-nodejs-fetcher` exports **`stopOnSignals(controller)`**, the signal half of `startFetcher` on its own, so a combined process that drives its own loop stops on `SIGINT`/`SIGTERM` through the same answer rather than a second copy of it.

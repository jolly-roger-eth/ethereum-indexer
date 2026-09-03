---
'etherfold': minor
---

`etherfold fetch` runs the chain-facing half of a split deployment, and it is now the ONLY way to run a fetcher.

```sh
etherfold fetch -n https://rpc.example -d ./deployments --ingest-endpoint https://indexer.example
```

It follows the chain and pushes contiguous ranges of raw logs at an indexer-server elsewhere, so splitting a deployment stays a deployment decision rather than a rewrite: run this near your node, and the folding half anywhere.

**It is a FRONT DOOR, not a new deployable.** `@etherfold/platform-nodejs-fetcher` already shipped the loop, the signals and the exit code; what it did not have was a flag surface, because it was configured from the environment alone. So this command resolves through the same path as every other one (flags first, environment behind them, one name per input), opens the source, and hands the five inputs an operator configures to that adapter as overrides:

| flag | variable | |
| --- | --- | --- |
| `-n, --node-url` | `ETH_NODE_URI` | the chain to read |
| `-d, --deployments` | `INDEXING_SOURCE` | what to index. REQUIRED in one form or the other: there is no processor module to read contracts out of |
| `--ingest-endpoint` | `INGEST_ENDPOINT` | the indexer-server to push to |
| `--ingest-token` | `INGEST_TOKEN` | the wire's shared secret |
| `--rps` | `REQUESTS_PER_SECOND` | the rate limit on the node |

Everything else a fetcher deployment tunes (`SUSPECT_RESULT_COUNT`, the fetch bounds, the backoff, the stream identity) stays in the environment the fetcher host already publishes, rather than growing a second name here.

- **It owns no state, and says so instead of ignoring the flags that imply otherwise.** `--store` and `--db` are REFUSED (a fetcher holds no cursor and no database, ADR-0003), `-p` is refused (the chain-facing half holds no processor; whatever folds these logs lives behind `--ingest-endpoint`), and `--port` / `--host` are refused (it pushes to an HTTP surface, it does not answer one). A missing node URL, source, endpoint or token is a refusal naming the flag AND the variable, raised before the chain is dialled.
- **There is nowhere to remember a block number**: no state file, no lock file, no `--from-block`. Progress across restarts comes from the receiver's cursor and from nothing else, and the `409` on the next start is the recovery.
- **How it ends is the adapter's answer, taken whole** (`runFetcherProcess`): `SIGINT` / `SIGTERM` let the cycle in flight finish and exit `0`; a refusal no waiting fixes exits non-zero, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing; everything else is retried on the escalating, capped backoff.
- **The CLI is the process now**, so it is what hooks the `named-logs` facade to the console for a fetch run -- the job the retired `etherfold-fetch` binary used to do, and one that a library must not do for an application embedding it.

New API: **`fetch`** (resolve, open the source and start the loop; returns the adapter's handle), **`fetchMain`** (the process shape, exiting on the code the adapter resolved) and **`prepareFetching`** (this command's row of the table, in the shape `startFetcher` takes).

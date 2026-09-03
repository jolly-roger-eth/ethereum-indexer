---
'etherfold': minor
---

`etherfold index` receives a pushed stream, owns the database, and completes the five-name command set.

```sh
etherfold index -p ./dist/processor.js --store sqlite --db file:./etherfold.db -d ./deployments
```

The half a split deployment was missing. The chain-facing half has been runnable all along (`etherfold fetch`); what nothing assembled was a server that HOLDS a processor, so a pushed batch met a `501` and a split deployment had a sender and no receiver. This is that receiver: it folds batches another process pushed to it, through the same stream-builder, the same entity processor and the same versioned store `run` folds through, on ONE libSQL handle it also hands to the server. So a split deployment is `index` plus `serve` against one database, and the shape falls out of the command set instead of needing to be explained.

**It exposes the WRITE path and not the query API, and that asymmetry is the point.** It has an HTTP surface because it must RECEIVE pushes; answering queries is `serve`'s. `/status` is available because there is an HTTP surface, and it reports on the database rather than on the process -- including the cursor, through the same injected reporter `run` builds, which is what makes a split deployment observable.

- **It makes NO chain call, and that constrains how it resolves its source.** There is no provider in this path, no log-fetcher and no fetcher host. `-n` / `--rps` are REFUSED naming what this command is instead, and the source must be given EXPLICITLY (`-d`, or `INDEXING_SOURCE` as JSON): the wire identity is derived from the source and the stream config together, so a source resolved by asking a node which chain it is on could not be the sender's. A processor module whose contracts are keyed per chain is refused by name, naming both explicit forms, rather than quietly costing an `eth_chainId`.
- **It authenticates or it refuses everyone.** `--ingest-token` (`INGEST_TOKEN`, which is preferable) is REQUIRED, so a receiver with no secret configured never binds a port rather than coming up as a write endpoint that answers `401` to a sender with no way to know why. A wrong secret is a `401` naming the variable, and nothing is applied.
- **It is idempotent by cursor, because the cursor IS the idempotency key.** A batch that does not start at the receiver's own `expectedFromBlock` is refused with a `409` carrying that value, and the sender re-sends from there; a sender that fell behind is corrected with no operator involved, and a replayed batch cannot be applied twice.
- **It owns its database.** The store's tables are created BEFORE a port is bound, so an illegal entity declaration or a retention window that does not cover what a reorg can reach is a refusal that never starts, rather than a `500` to a sender on a process still reporting itself healthy. The server's fixed-table schema is applied at startup as it is for every Node host; `--no-auto-setup` takes that back.
- **It does not terminate.** A receiver has no tip to stop at -- what it folds arrives from somewhere else -- so it ends on `SIGINT` / `SIGTERM` with exit code `0`, and exits `1` only when it could not start at all.

**The split is now a deployment CHOICE rather than a second implementation, and that is asserted at the COMMANDS.** `run` and `fetch` plus `index` fold the same processor and the same entity declarations over the same fixture chain -- including a reorg whose replacement branch carries FEWER events -- and land on identical state and an identical cursor, with the transport as the only difference. `index` plus `serve` against one database answer what `run` answers, through the read surface generated from the entity declarations and on the `/status` fields the server derives from the database. `serve` reports no cursor, which is correct rather than a bug: the cursor reaches `/status` only through an injected reporter, and a read tier owns no store.

New API: **`index`** (assemble the receiver and start answering; returns a handle carrying the url, the one database handle, the store, the processor and the stream-builder), **`indexMain`** (the process shape, resolving the exit code), and the shared folding assembly every command that owns a database now builds through (**`buildProcessor`**, **`openExplicitSource`**, **`STREAM_CONFIG`**).

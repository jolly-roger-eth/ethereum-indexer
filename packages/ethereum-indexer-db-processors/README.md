# ethereum-indexer-db-processors

> **Status: prototype / reference implementation — superseded by an active design plan.**
>
> This package is the original **PouchDB-backed** processor model for the indexer: instead of
> computing an in-memory state (as `ethereum-indexer-js-processor` does), you write event handlers
> that read/write a database, with support for reorg-aware reverting and (optionally) historical
> queries.
>
> Its `RevertableDatabase` (per-document validity ranges `startBlock`/`endBlock`, archive-on-write,
> restore-on-revert, optional `keepAllHistory` for time-travel queries) is the **closest existing
> prototype** of the historical-state database described in
> [`tasks/plan-historical-state-database.md`](../../tasks/plan-historical-state-database.md). That
> plan re-does this properly on **SQLite / Cloudflare D1** (via `remote-sql`) in a **log-watcher /
> log-processor** split. A review of the current implementation (including known bugs and the
> finality-vs-retention tension) is in
> [`tasks/findings/revertable-database.md`](../../tasks/findings/revertable-database.md).
>
> Treat this package as **prior art**, not as a maintained, recommended path. For browser/client
> indexing use `ethereum-indexer-browser` + `ethereum-indexer-js-processor`; for the future
> server-side historical-state indexer, follow the plan above.

## What it provides

- `EventProcessorOnDatabase` / `GenericSingleEventProcessor` — author a processor by writing
  `on<EventName>(event)` handlers that mutate a database (events dispatch by name).
- `EventProcessorWithBatchDBUpdate` — a variant with a dependency-declaration model so writes can be
  batched/queried more efficiently.
- `RevertableDatabase` — wraps the database to support reorg reverts and (optionally) historical
  reads via per-document `[startBlock, endBlock)` validity ranges.

Built on `ethereum-indexer-db-utils` (the `Database` / query abstractions, PouchDB-backed).

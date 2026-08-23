---
'@etherfold/state-store-sqlite': minor
---

New package: the versioned-row state store the server-side design rests on (`docs/design/historical-state-database.md`).

Entity state is kept as versioned rows with a half-open block-validity range (`_lower` inclusive, `_upper` exclusive, `NULL` meaning live) on the `remote-sql` interface and nothing else, so the same code runs on local SQLite, on libSQL/Turso and on hosted SQLite. An entity is declared as `{name, id, fields}` and the store issues the DDL itself: the table, the partial unique index on open rows (which also enforces "exactly one live version per business key"), and the indexes the as-of and revert paths ride.

`VersionedStateStore` exposes `migrate`, `applyBlock` (close-then-insert, exactly one `batch([...])`, so one atomic unit and one round-trip), `applyBlocks` (packs several blocks per batch for backfill, never splitting one), `revertTo` (DELETE versions opened above the fork, then re-open versions closed above it — an order that is not interchangeable, and is pinned in both directions by a test against a real SQLite engine), and the read side `getAsOf` / `queryAsOf` / `getCurrent` / `queryCurrent`.

Per-request statement and payload limits are a configurable bound with a conservative default (`DEFAULT_BATCH_BOUNDS`), not a hardcoded assumption about any one provider.

This is the first package published under the `@etherfold` scope, and the first to follow the `<role>-store-<backend>` naming scheme. See `docs/adr/0014` for the scope migration and why the backend is named rather than left as a generic `sql`, and `docs/adr/0017` for the word the scope ended up spelling.

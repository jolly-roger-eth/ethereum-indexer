# `db-processors` is deleted; `db-utils` retires with the indexer-server

`ethereum-indexer-db-processors` is **deleted** rather than evolved. `ethereum-indexer-db-utils` is **kept for now and retired** once the indexer-server lands, since ADR-0006 supersedes its central role. This answers open question 6 of `work/specs/ready/historical-state-database.md`, which framed it as a single delete-or-evolve call; the two packages in fact have opposite fates.

## Why delete rather than evolve

The review (`docs/reviews/revertable-database.md`) calls `RevertableDatabase` "the closest existing prototype" of the historical-state store, which is true conceptually and misleading practically. It stores per-document `startBlock`/`endBlock` with archive-on-write in PouchDB; the chosen design is half-open block ranges as two integer columns in SQL, with a partial unique index on open rows and a `revertTo` built from DELETE-then-re-open. They share the idea of validity ranges and no implementation. Evolving it would mean replacing every line while keeping a name that implies lineage.

It also had **no consumers**: nothing in the repo imported it, and its README had labelled it a superseded prototype for some time. The artifact worth keeping was never the code, it was the analysis, which is already extracted into the review. Git history keeps the rest.

## Consequences

- Removes a disproportionate share of known debt: TODO-triage theme 5 entirely (`RevertableDatabase` result/error typing) and most of theme 4 (missing batch and upsert primitives on the `Database` interface, the `delete _rev` PouchDB leakage).
- The package is public on npm, so removal from the repo must be paired with an `npm deprecate` pointing at `ethereum-indexer-js-processor` for in-memory state and at the in-design SQL store. Deprecating with no shipped replacement is acceptable only because it was always labelled a prototype and was never used.
- **Changesets cannot express a package removal**: a changeset naming a package absent from the workspace makes `changeset status` fail outright. So the removal has no changelog entry by construction, and `npm deprecate` is the only user-facing channel for it. Its name was also removed from the two pending changesets that listed it.
- **`db-utils` is on a retirement path, not an evolution path**, and this is written down so it does not quietly become permanent. It is live today (`ethereum-indexer-server` imports `EventCache`, `PouchDatabase`, `setupCache`, `QueriableEventProcessor`, `Query`, `bnReplacer`), but once the stream-builder stores the emission stream (ADR-0006), `EventCache` and `StreamDBCache` are absorbed by it and `PouchDatabase` goes with them. The trigger to revisit is the indexer-server landing, not a date.
- The event-cache analysis in `docs/reviews/event-cache.md` stays relevant precisely because that code is being re-homed rather than discarded: its known bugs (notably `replay()` reconstructing `lastSync` with empty `unconfirmedBlocks`) must not be carried into the stream-builder.

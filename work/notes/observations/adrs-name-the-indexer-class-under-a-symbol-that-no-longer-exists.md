# ADRs name the browser engine under a symbol that no longer exists

2026-09-03, spotted while building `the-old-indexer-shape-is-deleted`.

`docs/adr/0038` ("the decision is made in `EthereumIndexer`") and `docs/adr/0042` (`EthereumIndexer.feed()` / `.replay()`, twice in the decision sentence) still name the class under the identifier this task deleted; the class is `IndexerGeneration` (`@etherfold/core`, `src/indexer.ts`). ADR-0035's amendment shows ADRs in this repo are amended rather than frozen, so a reader following either one to a symbol nothing exports is a live dead end.

Not fixed here: the expand and migrate batches also left the ADRs untouched, so treating them as historical records may be deliberate, and deciding which is a call for a human rather than something to settle inside a contract batch.

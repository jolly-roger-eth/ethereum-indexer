---
'@etherfold/server': minor
---

The indexer-server now STORES the emission stream (ADR-0006): an append-only `EmissionStream` table in the FIXED schema, written by `/{indexer}/ingest`, with retractions included and superseded rows FLAGGED rather than deleted. `SCHEMA_VERSION` moves to `2`.

Every row carries the two DISCRIMINATORS, both structurally part of every read and write and neither ever defaulted: the INDEXER NAME (the route segment, ADR-0036) and the STREAM. The stream's value is the WIDE digest `streamDigestOf` builds and deliberately NOT the wire context's `{source, config}`: that is a 32-bit whole-entry hash kept whole on purpose as an identity check between the two halves of a deployment (ADR-0034), and as a KEY it fails twice. A decode-only change (a regenerated ABI, an added view function, a renamed non-indexed parameter) moves it while the fetch filter is untouched, orphaning every row already stored, and 32 bits collide, which here means one indexer silently adopting another's logs.

Nothing about the PROCESSOR is a column and there is no GENERATION column. The stream is keyed on `{source, config}` and only the state on `{source, config, processor}`, so a processor-only change is a new generation over the SAME stream; a column carrying the processor would fork this whole history on exactly the change the generation model promises is free.

The columns a later API depends on are created NOW rather than migrated in later: `address` and `topic0..topic3`, with ONE composite index on `(indexer, stream, address, topic0, blockNumber)` and `topic1..topic3` stored but UNINDEXED, to be filtered after the range scan (the shape decided in `work/specs/proposed/node-log-api.md`; indexing all four roughly doubles the table's index footprint against D1's 10GB ceiling). `alive` gets the partial index that makes the canonical view a cheap derived read.

It is in the fixed schema and not dynamic DDL because two application paths must produce the same database and one of them is wrangler's D1 migration, which executes `db.sql` and nothing else; a test now runs the file the way wrangler does and compares the result against `applySchema`.

`appendEmissions`, `EmissionAppend` and `EMISSION_STREAM_TABLE` are exported, so a host that routes batches some other way can append under a name it holds.

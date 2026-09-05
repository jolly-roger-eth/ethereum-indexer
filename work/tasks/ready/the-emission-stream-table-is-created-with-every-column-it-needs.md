---
title: 'The emission stream is stored append-only, with every column it will ever need'
slug: the-emission-stream-table-is-created-with-every-column-it-needs
spec: indexer-server-feed
blockedBy: [a-named-indexer-is-a-route-segment-and-a-registry-entry]
covers: [6, 8]
---

## What to build

Give the server the table ADR-0006 decides: the EMISSION STREAM, stored append-only with retractions
included and superseded rows FLAGGED rather than deleted, so no retraction information is ever
destroyed and the canonical view stays a cheap derived read. A batch received on the ingest route
writes its emissions here.

It goes in the FIXED schema (`packages/server/src/schema/sql/db.sql`), not dynamic DDL, so a wrangler
D1 migration and the Node schema path produce the same database.

### Every column at creation, because a key is the one thing a schema cannot be sloppy about

The columns are settled and are ALL created now. Not because retrofitting would be expensive (it
would not: nothing is deployed, no consumer holds a cursor), but because getting it right is free now
and getting it wrong costs a second build of the same table.

- **Two DISCRIMINATORS, both as columns, both structurally part of every read and write** and never a
  field a query may omit or default: the INDEXER NAME, and the STREAM.
- **The stream column's VALUE is the wide stream identity** already built in core
  (`streamDigestOf(source, resolvedStreamConfig)`), NOT the wire's `{source, config}`. The wire
  identity is ONE 32-bit hash over the WHOLE source, kept whole deliberately (ADR-0034) because it is
  an identity check between two halves of a deployment. Used as this key it fails twice: a
  decode-only change (a regenerated ABI, an added view function, a renamed non-indexed parameter)
  moves it while the fetch filter is untouched, orphaning the stored history; and 32 bits is ruled
  out as a KEY, because a collision is one indexer silently adopting another's logs.
- **`seq`**, monotonic per stream, the position a feed cursor addresses. Holes in it are legal.
- **The `alive` flag and its partial index**, which is what makes the canonical view a cheap read.
- **`address` and `topic0..topic3` as columns**, with a composite index on
  `(address, topic0, blockNumber)`. `topic1..topic3` are stored but left UNINDEXED and filtered after
  the range scan: indexing all four roughly doubles the log table's index footprint against D1's 10GB
  ceiling for little practical gain. This index shape is decided by `node-log-api` and is honoured
  here, not re-derived. Read story 8's indexed columns as columns, indexed per that decision, and NOT
  as five indexes.

## What this is NOT

- **NOT partitioned on the generation, or on anything carrying the PROCESSOR.** This is the trap. The
  stream is keyed on `{source, config}` and only the STATE on `{source, config, processor}`, so a
  processor-only change cannot invalidate the stream. Partitioning here on anything with the
  processor in it would FORK the stored logs on a processor change, duplicating the whole history,
  which is precisely the case the generation model promises is FREE. **There is NO generation column
  on this table.** Generations partition the STATE.
- **NOT a table or a schema per partition.** Neither SQLite nor D1 has schema namespaces, and a table
  per partition pushes the log table into dynamic DDL the fixed schema deliberately excludes.
- **NOT the feed.** Reading this table is the next task.
- **NOT compaction.** Rows are only ever appended or flagged here.

## Acceptance criteria

- [ ] A batch received on `/{indexer}/ingest` appends its emissions to the table, retractions
      included, with the indexer name and the stream digest on every row.
- [ ] Superseded rows are FLAGGED, never deleted: after a reorg the retracted rows are still present
      and `alive` is false for them, asserted on the rows themselves.
- [ ] The stream column holds `streamDigestOf`'s value; asserted to differ from the wire context's
      `config`/source hash, so the two are not silently interchangeable.
- [ ] A decode-only source change (an added view function, a renamed non-indexed parameter) leaves
      the stream digest UNCHANGED, so the stored history is not orphaned. Asserted.
- [ ] Two named indexers with IDENTICAL sources do not share rows, and neither can read the other's,
      which is what the name column is for.
- [ ] `address` and `topic0..topic3` are populated columns, with the composite index on
      `(address, topic0, blockNumber)` present and `topic1..topic3` unindexed.
- [ ] The table lives in the fixed schema, so the D1 migration path and the Node schema path produce
      the same database. Asserted rather than assumed.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-named-indexer-is-a-route-segment-and-a-registry-entry` supplies the indexer name this table
  keys on, and owns the route the write arrives through.

## Prompt

> Build the stored EMISSION STREAM for `@etherfold/server`: an append-only log table, retractions
> included, superseded rows flagged rather than deleted. ADR-0006 decides the substance; this task
> creates the table and writes to it from the ingest path.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/`, and the ADRs (0006 on storing emissions and deriving
> the canonical view, 0034 on why the wire's source hash is whole-source deliberately, 0035 on the
> stream cursor contract)? If a premise no longer holds, route to needs-attention rather than
> building on it.
>
> The KEY is the part to get right, and it is fully decided. Every row carries the INDEXER NAME and
> the STREAM as columns, both structurally part of every read and write. The stream value is the wide
> digest core already builds (`streamDigestOf` over the deduplicated per-entry stream hashes plus the
> stream config hash), NOT the wire's `{source, config}`: that one is a 32-bit whole-source hash, kept
> whole on purpose as an identity check between the two halves of a deployment, and using it here
> would orphan the stored history on a decode-only ABI change and would risk one indexer adopting
> another's logs on a collision.
>
> NOTHING about the processor enters this table, and there is no generation column. The stream is
> keyed on source plus config; only the STATE carries the processor. Putting the processor in here
> would fork the whole stored history on a processor-only change, which is exactly the case the
> generation model promises costs nothing.
>
> Also create, now, the columns a later API depends on: `address` and `topic0..topic3`, with a
> composite index on `(address, topic0, blockNumber)` and `topic1..topic3` unindexed and filtered
> after the range scan. That index shape is already decided in `work/specs/proposed/node-log-api.md`;
> honour it rather than deriving a new one, and do not create five indexes.
>
> Where to work: the server's fixed schema file and its ingest write path. Keep it in the FIXED
> schema; the log table must not become dynamic DDL, because the wrangler D1 migration and the Node
> schema path have to produce the same database.
>
> Done means: emissions land with both discriminators, retractions are flagged and still present, a
> decode-only source change does not move the stream digest, two identically-sourced named indexers
> are isolated, and the topic columns and their one composite index exist.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular the `seq` allocation rule and how `alive` is maintained on a retraction.

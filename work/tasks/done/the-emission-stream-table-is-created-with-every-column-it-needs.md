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

## Decisions

**Where the write lives: the ROUTE, not the fold.** ADR-0050 moved the reorg count the other way (into `StreamBuilder.receive`, injected by the store's owner) on the ground that a fact about the fold must not be a fact about the transport, and the emission stream is even more clearly a fact about the fold. I still put it on the route, because the constraint here is the KEY rather than the fact: half of it is the INDEXER NAME, and the route segment is the only place that value exists. `IndexerRegistryEntry` deliberately refuses to carry a name ("a second copy an entry could disagree with is a discriminator a write path might key on wrongly"), and `--indexer` is refused outright on `run`, `build` and `serve`, so there is no fold-side value to key on: injecting a writer into `StreamBuilder` would first require telling a receiver its own name, which is the duplication the registry rejects. Alternative considered and rejected: an `EmissionRecorder` seam mirroring `ReorgRecorder`. **What it touches:** a combined `etherfold run` / `build` folds through `createDirectIngestion`, reaches no route, and therefore stores no emission stream, so the two feed tasks that follow are servable only from `index`. That is not this module declining; that shape has no name to store one under. When `run` gets one, the write moves into `receive` and the route becomes a caller. Recorded in `emissions.ts`, `ingest.ts`, `CONTEXT.md` and the README rather than left to be re-derived.

**`seq` is allocated per `(indexer, stream)`, from the table, once per batch.** `SELECT COALESCE(MAX(seq), 0)` for the pair, then the batch is numbered from it and inserted in one `db.batch`. Per PAIR and not per stream alone (which is what the task's wording says literally) because two named indexers with byte-identical sources land on ONE digest and would otherwise punch holes in each other's cursor space; holes are legal by contract, but they should come from compaction, not from a neighbour. Read from the table rather than kept in a process counter, on the same argument that makes `StreamBuilder` re-read its cursor every call: the intended host is serverless and an in-memory sequence is one isolate's opinion of a value the database owns. It is not a lock; the PK `(indexer, stream, seq)` is, so a genuine concurrent append fails loudly instead of overwriting, and it cannot ordinarily happen because a second batch for one receiver is a `409` before it reaches here. Alternative considered: `MAX(seq)+1` as a SQL subquery per row, rejected as harder to read for no gain given the statements run in one batch anyway. **Touches** the next task's cursor, which addresses this `seq`.

**How `alive` is maintained on a retraction.** Two writes: the retraction row is APPENDED with `removed = 1` and `alive = 0` (a retraction is never something a canonical read may return), and an `UPDATE ... SET alive = 0` flags the emission it takes back, matched on `(indexer, stream, blockHash, logIndex) AND removed = 0 AND alive = 1`. Matched by block HASH rather than height, because a reorg retracts a named block and a height names whichever branch won; `alive = 1` is part of the match so a hash applied, retracted and applied again flags the row that is live at the time rather than the one already dead. Nothing is ever deleted and nothing but `alive` is ever updated. **Touches** the canonical-view task, whose read is exactly `WHERE alive AND blockNumber <= gate`.

**The composite index leads with the two discriminators**: `(indexer, stream, address, topic0, blockNumber)`, not the literal three columns `node-log-api` names. The spec decided the *shape* against D1's index footprint, and it did not have the tenancy discriminators in view; a range scan that could omit one would cross into another tenant's rows, which is the exact hazard the name column exists to prevent. Still ONE index, and `topic1..topic3` remain unindexed. **Touches** `node-log-api` when it is built: its query must bind both discriminators, which it has to anyway.

**Only the raw log is stored, never the decoded `args`/`eventName`.** `args` is what SOME ABI made of those bytes and is re-derived on replay against the source running now (`LogEventFetcher.reparse`), so persisting it would persist an opinion that a decode-only change invalidates, and it is the one thing that would break the "a decode-only change does not orphan the history" property at the row level rather than at the key. Consistent with `the-stream-stores-only-what-the-node-said`. **Touches** the feed task, which serves these rows.

**An append failure RAISES; it is not swallowed the way a reorg count is.** A lost count costs an operational number; a lost append costs the stream itself, and a stream silently missing a batch the state already applied is a HOLE, which this repo treats as the serious damage class precisely because it is invisible and self-consistent. So it becomes a `500` with `lastError` set. The sender's recovery is unaffected: the batch WAS applied, so its next attempt is the ordinary `409` and nothing is double-applied. **Touches** `etherfold index --no-auto-setup` against a database nobody migrated: ingest now fails loudly there instead of folding while storing nothing. That is consistent with `/status` already reporting such a database unhealthy.

**`streamDigest` and `emissions` are REQUIRED members, not optional.** An optional field on the fold's output is a hole with a polite name (the repo's own argument for making `getCodeFingerprint` required): a receiver that quietly omitted one would leave a host storing nothing under a key it could not form. The cost is that two hand-written fakes in tests had to grow, which is why `@etherfold/platform-nodejs` carries a patch changeset for a behaviour-neutral change.

**Naming.** Table `EmissionStream` and column `stream`, taken from the glossary's own terms rather than invented; the column holds the stream's identity, which the glossary already defines as the digest. `EMISSION_STREAM_TABLE` is spelled once so the coming reads cannot drift from this write.

**Left alone deliberately: ADR-0006's `status: accepted, not yet implemented`.** The storage half is now built and the two views and compaction are not, and `ADR-FORMAT.md` enumerates the legal status values with no "partly implemented" among them (it also cites ADR-0006 by name as the worked example of the pending case). Inventing a value would be a convention change outside this fence; the last of the six tasks should flip it.

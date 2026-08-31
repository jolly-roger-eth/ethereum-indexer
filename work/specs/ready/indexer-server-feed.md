---
title: Indexer-server log feed (the stored emission stream and the two views over it)
slug: indexer-server-feed
taskedAfter: [historical-state-database]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> Split out of `historical-state-database` at tasking time. That spec's user stories cover state queries, the ingestion wire and running serverlessly. The scope here (storing the log stream and serving it as a feed) arrived later, via `docs/adr/0006`, and is not covered by any of its stories. Tasking is atomic per spec, so this scope becomes its own spec rather than being smuggled into that one.

> **NARROWED: the REBUILD is no longer here.** Stories 9-11 moved to `work/specs/proposed/the-server-and-cli-hold-generations-too.md`, which supersedes them (see the note where they were). This spec owns the STORAGE and the FEED and nothing about upgrades; that spec is `taskedAfter` this one because it consumes the table this one creates.

## Problem Statement

Consumers that react to chain events (notification services, reward systems, third-party integrations) need an ordered, resumable log feed they can follow without running their own chain infrastructure, and without the indexer-server knowing anything about them. Separately, when a processor's logic changes, its derived state must be rebuilt from scratch while the old state keeps being served, and re-fetching the entire history from the chain to do so is unacceptable.

Both needs are met by the same thing: the indexer-server keeping the log stream it already receives.

## Solution

The indexer-server stores the **emission stream** (append-only, retractions included, superseded rows flagged) and serves two views over it: the full `seq`-ordered stream for retraction-aware real-time consumers, and a canonical gated view (`alive`, bounded by a caller-supplied block gate, ordered by block and log index) for consumers that never want to handle a reorg.

Because the stream is stored locally and keyed independently of the processor version, a processor-logic upgrade can rebuild state by replaying that local stream rather than re-fetching the chain. **HOW that rebuild works is no longer this spec's, and stories 9-11 have moved.** This spec owns the STORAGE and the FEED: the emission table, the two views, cursor semantics, compaction, and the indexed topic columns.

## User Stories

1. As a consumer, I want to follow an ordered log feed from a cursor I control, so that I can resume after downtime without re-reading everything.
2. As a real-time consumer, I want the retraction-aware stream (including `removed` entries) with a monotonic `seq` cursor, so that I can act optimistically and cancel a pending action when a reorg retracts it.
3. As a simple consumer, I want a canonical view bounded by my own gate, with no retractions in it, so that my entire sync state is one advancing position and I never implement reorg handling.
4. As a consumer of the canonical view, I want my cursor validated against the block hash I last saw, so that a reorg tells me to rewind instead of silently skipping the events I never received.
5. As a consumer, I want cursor semantics that permit holes in `seq`, so that enabling stream compaction later cannot break me.
6. As an operator, I want the stream stored append-only with superseded rows flagged, so that no retraction information is ever destroyed and the canonical view stays a cheap derived read.
7. As an operator, I want optional pair-compaction (dropping a retracted entry together with its retraction, far below finality) as an off-by-default config, so that noise can be reclaimed deliberately and never by accident.
8. As an operator, I want the log table's `address` and `topic0..topic3` stored as indexed columns, so that a node-compatible `eth_getLogs` API is possible later without migrating the whole table.
> **Stories 9, 10 and 11 MOVED to `work/specs/proposed/the-server-and-cli-hold-generations-too.md`**, which supersedes them. They described ADR-0008's blue-green rebuild: replay into a new namespace keyed by the processor version hash, flip a pointer, DROP the old. That shape is now a special case of the GENERATION model (`a-reconfigure-is-not-an-outage`), and it is too narrow in two ways that matter here: keyed by the processor hash alone it cannot express a FILTER change, and dropping the old namespace at the flip is what makes a revert impossible. Building it and then replacing it would be paying twice, so the boundary moved rather than the work being duplicated. What this spec still OWES that one is the table underneath it, which is why it is `taskedAfter` this.

## Implementation Decisions

ADR-0006 decides the substance (the emission form, the `alive` flag and its partial index, the two
views, per-view cursors, the block-hash cursor validation, legal `seq` holes, pair-compaction off by
default). Three things it does NOT decide are recorded here, because they are decisions about the
TABLE THIS SPEC CREATES and each is free now and expensive later.

**Every row carries TWO discriminators from the first migration: the INDEXER NAME and the
GENERATION**, both as COLUMNS, and both structurally part of every read and write — never a field a
query may omit, never defaulted, on the same hazard class as the cross-chain prefix collision
anchored enumeration exists to prevent. ADR-0006 supplies only `{source, config}`, which is NOT a
tenancy key: two named indexers with identical sources (same chain, same contracts, same processor)
collide on it, which is exactly the isolation test the sibling spec asserts.

**Why COLUMNS rather than a table or a schema per partition**, decided here because this spec creates
the table: neither SQLite nor D1 has schema namespaces, so a schema per generation is not available
on the actual backends; and a table per generation would push the LOG table into dynamic DDL, which
`packages/server/src/schema/sql/db.sql` deliberately excludes ("FIXED tables only… Entity tables are
NOT here and never will be", because the versioned-row store creates those at runtime). Columns keep
the log table in the fixed, shippable schema, which is what makes a wrangler D1 migration and the
Node `applySchema` path produce the same database.

**Why BOTH must be there from the start, rather than added when the sibling needs them.** This spec
builds the table AND ships stories 1-5, which are a PUBLIC, resumable consumer contract over it.
Retrofitting either discriminator later is a primary-key rebuild PLUS a breaking change to a cursor
other people hold. `node-log-api` already makes exactly this argument for its topic columns ("free at
design time, a migration over millions of rows afterwards"), and it is STRONGER here, because the DDL
is still free today while a published cursor will not be. Neither column is speculative: a server
hosts several NAMED INDEXERS, and each holds several GENERATIONS
(`a-reconfigure-is-not-an-outage`), so both axes are certain.

**Where the indexer NAME comes from is settled and is not this spec's to invent**: it arrives on
`upload`, alongside the source info and the processor, supplied by the operator and refused when
absent (`the-server-and-cli-hold-generations-too`).

**How it REACHES both paths is settled too, and it is the same shape on each: the name is a ROUTE
SEGMENT, and `ServerOptions` grows a NAME-KEYED REGISTRY.** `/{indexer}/ingest` on the write side and
`/{indexer}/feed` on the read side; `getIngestion` stops resolving one `LogIngestion` and resolves one
per name. Resolve a registry ENTRY object rather than a bare `LogIngestion`, so that the sibling's
widening to several live contexts is an ADDITIVE field rather than a change to the resolver's return
type. This keeps the existing injection design rather than bending it — a host still supplies
exactly what it was built with, which is precisely what a deploy-time `upload` manifest produces —
and it leaves ADR-0004's wire ENVELOPE untouched, so the `{source, config}` assertion and its refusal
families (`409` resumable, `400` otherwise) are unchanged. The alternative of carrying the name IN the
envelope was rejected: it would make the wire format carry tenancy and turn a misdirected batch into
a payload error rather than a routing one.

**The consumer CURSOR is OPAQUE and carries the indexer name, the generation and the position.** Three
rules, and the third is the one that cannot be walked back:

- **Opaque to the consumer.** It is a server-encoded string, not structured data a client parses.
  Otherwise its encoding becomes a public contract that can never change, and this cursor is the one
  thing this spec argues is unretrofittable. Same call ADR-0027 made for the internal sync cursor.
- **The name and the generation are VALIDATED, not used for routing.** The route routes; the cursor's
  copies exist so a MISMATCH is refused. A cursor minted for one indexer, presented at another, is a
  refusal rather than a re-interpretation — the read-side twin of `WireContextMismatchError`, which
  carries `{source, config}` in the envelope even though the endpoint already identifies the receiver.
- **A cursor whose GENERATION is no longer canonical is REFUSED, never silently continued.** `seq`
  positions in two generations are unrelated, so serving the new one at the old one's number is the
  plausible-wrong-answer class this repo refuses everywhere. The response shape already exists: this
  is ADR-0006's cursor validation one level up, where a no-longer-canonical block hash answers
  "rewind to fork block F". A no-longer-canonical GENERATION answers with the current one, and the
  consumer decides what to do (the platform advertises; it does not dictate).

The generation is ALSO surfaced as a plain readable field on every feed response, precisely because
the cursor is opaque: that field is what a consumer compares across polls to notice a promotion.

**Scope line, so this spec and its sibling do not both build the registry.** THIS spec builds the
name-keyed registry and both routes, with ONE live wire context per named indexer — which is all its
own writes need. `the-server-and-cli-hold-generations-too` EXTENDS a registry entry to hold SEVERAL
live contexts at once, and swaps the one-generation-by-construction rule above for its pointer row, which is what a filter-change successor requires, and makes
`/{indexer}/ingest/expected-from-block` answer with one entry per live context instead of one. That
endpoint already returns its `context` alongside the block number, so that is a widening of something
it does today rather than a new idea.

**The GENERATION column holds an OPAQUE identifier, and at THIS spec's scope its value is ADR-0006's
existing triple.** The column needs a value on every write, and it must not be defaulted, so say where
it comes from rather than leaving a builder to invent one:

- **At this scope the identifier is `{source, config, processor}`** — which ADR-0006 ALREADY names as
  what state is keyed by, so this is not a new derivation. Both halves are in hand at the write site:
  `source` and `config` are the `WireContext` the route resolved, and `processor` is
  `getVersionHash()` on the injected processor, which `StreamBuilder.currentLastSync()` already reads
  on every call for exactly this purpose. Nothing new is computed and nothing is duplicated.
- **It is OPAQUE to this spec's storage and reads**: a text identifier to partition and compare on,
  never parsed. That is what lets `a-reconfigure-is-not-an-outage` later REPLACE its composition with
  the stream-digest-plus-processor-hash identity without touching this table's shape, and it is why
  this spec needs no `taskedAfter` edge onto that one — importing the derivation would duplicate a
  definition that must have exactly one home.
- **At this scope every named indexer has EXACTLY ONE generation, which is therefore canonical by
  construction.** Say this explicitly, because the feed is specified as serving THE CANONICAL
  generation and there is no pointer to resolve yet: the pointer row, N generations, and promotion
  all arrive with `the-server-and-cli-hold-generations-too`. The feed's contract is written so that
  arrival changes the ANSWER and not the SHAPE — the cursor already carries the generation, and the
  response already advertises it, so a consumer built against this spec keeps working when a second
  generation first exists.

**Scope line, so this spec and its sibling do not both build the registry.** THIS spec builds the
name-keyed registry and both routes, with ONE live wire context per named indexer — which is all its
own writes need. `the-server-and-cli-hold-generations-too` EXTENDS a registry entry to hold SEVERAL
live contexts at once, and swaps the one-generation-by-construction rule above for its pointer row, which is what a filter-change successor requires, and makes
`/{indexer}/ingest/expected-from-block` answer with one entry per live context instead of one. That
endpoint already returns its `context` alongside the block number, so that is a widening of something
it does today rather than a new idea.

**The GENERATION column holds an OPAQUE identifier and this spec does not derive it.** A generation's
identity (its stream digest plus the processor version hash) is `a-reconfigure-is-not-an-outage`'s,
and deliberately stays there: the table needs a value to partition on, not the rule that computes it.
Stated so this spec needs no `taskedAfter` edge onto that one — an opaque column is buildable without
it, and importing the derivation would duplicate a definition that must have exactly one home.

**The feed SERVES THE CANONICAL generation, and every feed response and cursor ADVERTISES THE
GENERATION IDENTITY it was answered from.** Decided, and the split of responsibility is the point.
The PLATFORM's duty stops at advertising: a consumer's `seq` is a position in ONE generation's
emission stream, the canonical pointer can move underneath it, and the successor's stream has its own
sequence — so a `seq` that silently changes meaning is exactly the plausible-wrong-answer class this
repo refuses everywhere. Advertising the identity makes the change DETECTABLE at zero cost, since the
feed already resolves the pointer to answer at all.

What the platform deliberately does NOT do is decide what a consumer should do about it. Pausing,
re-scanning from the new generation's start, or carrying on are all legitimate and depend on what the
consumer's actions mean — a notifier that already fired cannot unfire, and only it knows that. So:
advertise, never dictate. (The expected consumer behaviour, for the record and not as a platform
rule, is to PAUSE on a generation change and let its operator decide.)

This is the feed's half of one question that has two surfaces: `node-log-api` open question 6 asks it
for `eth_getLogs`, and both should be answered this same way rather than diverging. Surfaced by
writing out the external trigger service's consumer contract
(`work/specs/dropped/trigger-system.md`), which is the concrete consumer that needs it.

**RETENTION bounds how far a feed consumer may lag, and that is a deployment constraint rather than
a build item.** A consumer that evaluates a state predicate as of a triggering log's block reads
through the as-of surface, and ADR-0019 makes a read outside the retention window a
`BlockNotRetainedError` — a refusal, not an answer — while ADR-0028 gives a bootstrapped store a
floor at its snapshot. So retention must exceed the worst lag a consumer is allowed to accumulate,
and the refusal is the CORRECT behaviour when it does not (a tip-served answer would be a plausible
wrong number). Recorded because nothing had written it down and the feed is what makes lagging
consumers a normal condition rather than an exceptional one.

**The topic columns follow `node-log-api`'s index decision, not a fresh one.** Story 8 asks for
`address` and `topic0..topic3` as columns; the INDEX shape is already decided there and must be
honoured rather than re-derived: a composite index on `(address, topic0, blockNumber)`, with
`topic1..topic3` stored as columns but left UNINDEXED and filtered after the range scan, because
indexing all four roughly doubles the log table's index footprint against D1's 10GB ceiling for
little practical gain. Read story 8's "indexed columns" as "columns, indexed per that decision", not
as five indexes.

## Out of Scope

- The state store, the ingestion wire and the host adapters, all covered by `historical-state-database`.
- **Rebuilding state on a processor or source change**, and everything the GENERATION model implies
  (holding several generations, the canonical pointer, moving it back, the caps). That is
  `work/specs/proposed/the-server-and-cli-hold-generations-too.md`, which absorbed stories 9-11 and
  is `taskedAfter` this spec. This spec owes it the table and the feed and nothing else.
- The `eth_getLogs` API itself (`work/specs/proposed/node-log-api.md`); this spec only owes it the schema it depends on.
- Trigger evaluation and delivery, which live entirely outside the indexer-server (`docs/adr/0005`).

## Further Notes

- The decisions are already made and recorded: `docs/adr/0006` (store emissions, derive the canonical view, cursor semantics, compaction). ADR-0008 (blue-green rebuild, chunked replay, why `getVersionHash` became load-bearing) is AMENDED and its rebuild half now belongs to `the-server-and-cli-hold-generations-too`; its chunked-replay and `getVersionHash` reasoning survives there unchanged.
- Story 4's rewind response has a proof worth keeping in mind while building: a reorg invalidates a contiguous suffix, so validating the single block at the cursor certifies the whole prefix behind it.
- The rebuild's trigger no longer lives here. `processor-version-hash-cannot-silently-lie` (now in `work/tasks/done/`, and ratified by ADR-0008's 2026-08-21 amendment) protects it, and the rebuild it protects is `the-server-and-cli-hold-generations-too`'s. Noted so the connection is not lost with the stories that moved.

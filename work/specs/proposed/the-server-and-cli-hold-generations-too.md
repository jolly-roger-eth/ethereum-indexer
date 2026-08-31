---
title: 'The server and the CLI hold generations too, over the emission-stream table'
slug: the-server-and-cli-hold-generations-too
needsAnswers: true
taskedAfter: [a-reconfigure-is-not-an-outage, indexer-server-feed]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **ALSO ABSORBS `indexer-server-feed`'s rebuild stories (9-11), which it supersedes.** That spec
> owns the STORAGE and the FEED — the ADR-0006 emission table, the two views, cursor semantics,
> compaction, the indexed topic columns — and this spec is `taskedAfter` it because it needs that
> table. Its rebuild stories described ADR-0008's blue-green: replay into a namespace keyed by the
> processor version hash, flip a pointer, DROP the old. Keyed by the processor hash alone that cannot
> express a FILTER change, and dropping the old namespace is what makes a revert impossible, so the
> generation model supersedes it rather than being layered on top of it. Building blue-green and then
> replacing it would be paying twice. The boundary moved; the work did not duplicate.

> **SPLIT out of `a-reconfigure-is-not-an-outage`** under `TASKING-PROTOCOL` §2a. That spec's
> landables all edit `packages/browser/src/IndexerState.ts`, and nothing in it builds a stream keeper
> over the server's storage, so as it stood the destination was a browser-only generation model with
> a SERVER ADR (ADR-0008) amended to describe it. The generation MODEL is runtime-agnostic and stays
> there; this spec is the runtime.

## Problem Statement

`a-reconfigure-is-not-an-outage` makes a reconfigure survivable by holding several GENERATIONS and
moving a canonical pointer. It is specified per PROJECT and per GENERATION rather than per runtime,
deliberately — but every landable that actually RUNS a generation is browser-side, and the two stream
keepers that exist are the filesystem and IndexedDB.

The server has the same problem and none of the machinery:

- `StreamBuilder` holds an `EventProcessor` and calls **`processor.clear()`** whenever the persisted
  cursor carries a different source, config or processor version — on `/ingest` and on
  `/ingest/expected-from-block`. That is the outage, with a concrete call site.
- Its stream is the ADR-0006 **emission-stream table** behind `RemoteSQL`, not ordinal segments in a
  key/value store, so `appending-to-the-stream-costs-the-batch`'s keeper does not serve it.
- ADR-0008 already decided a blue-green rebuild FOR THE SERVER, keyed by the processor version hash
  alone. Its 2026-08-31 amendment records that the key was too narrow (it cannot express a filter
  change) and points at the generation model — a pointer that currently leads to a spec with no
  server tier.

**And the CLI is the same runtime.** The goal is a CLI that runs what a server runs, so this is one
spec, not two. Older text describing the CLI as a one-shot `indexToTip` batch that never
reconfigures describes what it is today, not what it is becoming.

## Solution

The generation model, unchanged, over the server's storage. A generation is still a stream plus a
fold; one is canonical; the pointer moves when a successor is ready and moves back to revert.

Three things this runtime supplies that the browser one does not:

- **A stream keeper over the emission-stream table**, satisfying the same `ExistingStream` contract
  the two key/value keepers do.
- **A generation container above `StreamBuilder`**, so a changed context creates a successor instead
  of calling `processor.clear()`.
- **The canonical pointer as a table row**, which is what ADR-0008's `current_version` row becomes.

**This runtime is the SECOND cursor-record keeper, not the first.**
`appending-to-the-stream-costs-the-batch` fixes a CURSOR CONTRACT of four properties and leaves
PLACEMENT to each keeper precisely so a substrate with atomic multi-row updates is not forced into a
layout invented for a filesystem. A SQL keeper holds its cursor in its own ROW and updates it in the
SAME transaction as the segment insert: that satisfies property 1 and property 2 directly, makes
property 3 (no unconfirmed window per sealed segment) vacuous because there is nothing to strip, and
gives property 4 for free with no tail rewrite on an empty save. The shipped IndexedDB keeper already
does exactly this with `setMany`, so there is prior art rather than novelty — which is itself the
argument for the shared conformance material, since a third implementation is where it earns its
keep. Do not port the FILESYSTEM's tail strategy here.

## User Stories

1. As an operator, I want a feed whose context changed to be handled deliberately rather than by a
   silent `processor.clear()`.
2. As an operator, I want my server to keep answering queries from the canonical generation while a
   successor rebuilds, instead of serving progressively less.
3. As an operator, I want to move the pointer BACK to the previous generation when a new processor
   turns out worse, without re-ingesting.
4. As an operator, I want a rebuild in progress to be distinguishable from an empty result, which is
   the same absence-versus-contradiction distinction the reorg model and `SuspectedTruncationError`
   already make.
5. As an operator running MULTIPLE PROJECTS on one server or CLI, I want them fully isolated, so no
   query, prefix scan or cap in one project can ever reach another's data.
6. As a developer, I want the CLI to run exactly what the server runs, so what I test locally is what
   deploys.
7. As an operator, I want a bound on how many generations a project accumulates, and a loud refusal
   at the bound rather than a silent eviction.
8. As a maintainer, I want a processor-logic upgrade to rebuild state from the locally stored stream
   rather than from the chain, so an upgrade costs a local scan instead of a full re-index. (From
   `indexer-server-feed`, story 9.)
9. As a maintainer, I want the rebuild to run in BOUNDED CHUNKS against a durable checkpoint, so it
   completes on a serverless host that cannot hold a long-running loop. (From `indexer-server-feed`,
   story 10; ADR-0008's self-enqueueing queue reasoning survives unchanged, and the cron watchdog
   with it.)
10. As an operator, I want the canonical generation served throughout a rebuild and the pointer moved
    atomically at the end, so readers never observe partial state and a rollback before the move is
    free. (From `indexer-server-feed`, story 11 — now strictly stronger, because the retired
    generation is RETAINED under the caps rather than dropped, so the rollback stays free AFTER the
    move too.)

<!-- open-questions -->

## Open questions

1. ~~What is the emission-stream table's schema, and does it exist yet?~~ **ANSWERED, and it is why
   this spec is `taskedAfter indexer-server-feed`.** `StreamBuilder`'s docstring (not ADR-0006's — an
   ADR has none) says it "does not store the emission stream: that arrives with ADR-0006, in the
   `indexer-server-feed` spec". That spec owns the table; this one consumes it.
2. **How does a generation partition that table?** A `generation` column with every read filtered on
   it, a table per generation, or a schema per generation. The same question the browser answered
   with a key component, and the answer here is a storage-adapter decision that the composite key
   should keep open.
3. **Does the CLI hold several generations, or one?** A long-running `serve` clearly can. A one-shot
   batch arguably should not, and forcing it to would add a pointer read to a path that has no
   reconfigure. If they differ, the difference must be in the HOST rather than in the model.
4. **Where does `project`'s VALUE come from on a server or CLI?** The browser needs no discriminator
   (a page is one project) and has none, so this runtime is the first to require one, and nothing
   supplies it today: `createFileKeepState(folder)` takes no name and `packages/server` has none. Is
   it a deployment config key, a path segment on the ingest route, or derived from the feed's own
   identity?
5. **What replaces `processor.clear()` in `StreamBuilder`, exactly?** It is called on two routes and
   its removal is the concrete deletion sweep this spec owns.

<!-- /open-questions -->

## Implementation Decisions

**None of the MODEL is re-decided here.** Generation identity (its STREAM plus the processor version
hash — the VERDICT decides whether anything is created at all, which is a different question and one
the model spec keeps deliberately separate), stream identity (the deduplicated `streamHash` digest plus the stream config hash),
the canonical pointer, the caps that refuse rather than evict, cap-and-drain pausing, and the
promotion policy defaulting to `on-catch-up` everywhere are all
`a-reconfigure-is-not-an-outage`'s and are consumed unchanged. Restating any of them here would
create a second source of truth that drifts.

**The project discriminator is the same composite key**, structurally non-omittable, and whether it
maps to a column, a table prefix or a schema is exactly the storage-adapter decision the sibling
spec deliberately left open. This runtime is where that decision actually gets made.

**ADR-0008 is superseded in its KEY and its RETENTION, not in its mechanism.** Its rebuild-alongside
and flip-a-pointer shape is what this builds. Its namespace key (processor version hash alone) cannot
express a filter change and is replaced by the generation identity. Its drop-the-old-namespace rule is
replaced by the caps, which is what makes moving the pointer back possible. That amendment is already
recorded on the ADR; this spec is the thing it points at for the server.

## Testing Decisions

- **A context change creates a successor rather than calling `processor.clear()`**, asserted at that
  call site, which is the concrete outage this spec removes.
- **Queries keep being served from the canonical generation** across a full rebuild, and a rebuild in
  progress is distinguishable from an empty result.
- **The pointer moves back** and the previous generation answers exactly as before, with no
  re-ingestion.
- **The cursor contract is satisfied by the SQL keeper**, asserted against the same four properties
  as the key/value keepers rather than against a layout — ideally through the shared conformance
  material `appending-to-the-stream-costs-the-batch` names, which is where a third implementation
  earns its keep.
- **Two projects with identical sources never touch each other's data**: same chain, same contracts,
  same processor; deleting everything in one leaves the other complete and readable.
- **The CLI and the server take the same path**, asserted by driving both through one fixture.

## Out of Scope

- **The generation model itself**, which is `a-reconfigure-is-not-an-outage`.
- **The client-side stream keepers**, which are `appending-to-the-stream-costs-the-batch`.
- **The GraphQL query frontend.** Decided elsewhere (Hono, Yoga, Pothos over entity declarations) and
  guaranteed a schema source by `one-processor-everywhere`. What this spec owes it is the
  once-per-read-unit-of-work generation resolution the sibling pins, so a query cannot straddle a
  promotion.
- **Seeding a generation from a published artifact**, which is
  `a-generation-can-be-seeded-from-a-published-artifact`.

## Further Notes

The dropped stub `work/specs/dropped/an-ingest-server-reconfigure-is-not-a-blackout.md` asked three
questions about this runtime and was dropped because the sibling spec answered them at the model
level. This spec is the part that stub could not have written: not whether the server holds
generations, but what it costs over `RemoteSQL` and the ADR-0006 table.

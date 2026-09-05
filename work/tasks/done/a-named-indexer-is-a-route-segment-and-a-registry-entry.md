---
title: 'A named indexer is a route segment and a registry entry, on both halves of the wire'
slug: a-named-indexer-is-a-route-segment-and-a-registry-entry
spec: indexer-server-feed
blockedBy: []
covers: []
---

## What to build

Make the server host SEVERAL named indexers instead of one. The name becomes a ROUTE SEGMENT on
every ingest endpoint, and `ServerOptions` grows a NAME-KEYED REGISTRY that resolves one entry per
name instead of resolving a single `LogIngestion`.

`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, and
the SENDING side moves with them: `ingestClient` takes the indexer name alongside the base URL it
already takes.

Resolve a registry ENTRY OBJECT rather than a bare `LogIngestion`. `the-server-and-cli-hold-generations-too`
later widens an entry to hold several live contexts at once, and an entry object makes that an
ADDITIVE field rather than a change to the resolver's return type.

The wire ENVELOPE is untouched. ADR-0004's `{source, config}` assertion and its refusal families
(`409` resumable, `400` otherwise) are unchanged, and the name is deliberately NOT carried in the
envelope: that would make the wire format carry tenancy and turn a misdirected batch into a payload
error rather than a routing one.

### The surface this actually touches, which is wider than the server

Named because a build that changed only the server would ship one no fetcher can reach, and because
a scope fence that excluded these would leave the gate red. The unnamespaced routes are referenced
from `@etherfold/core` (`ingestClient`), `@etherfold/fetcher-host` (its configuration), the server
itself, and from tests in `@etherfold/cli`, `@etherfold/core`, `@etherfold/fetcher-host`,
`@etherfold/server` and `platforms/nodejs`. Find them with a search for the route strings rather
than from this list, which is a snapshot.

## What this is NOT

- **NOT a change to the wire envelope.** The name routes; it is not payload.
- **NOT the multi-generation registry.** ONE live wire context per named indexer here, which is all
  this spec's own writes need. Several at once is the sibling spec's widening.
- **NOT authentication.** The ingest guard and its token are unchanged.

## Acceptance criteria

- [ ] `/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` answer for a name the host was
      built with, and a name it was NOT built with is refused rather than defaulted.
- [ ] **The unnamespaced `/ingest` and `/ingest/expected-from-block` no longer answer.** Asserted, so
      the old surface is gone rather than left live beside the new one.
- [ ] `ServerOptions` resolves a registry ENTRY per name; the entry is an object, so a later field
      can be added without changing the resolver's return type.
- [ ] `ingestClient` takes the indexer name and posts to the namespaced routes; a full send/receive
      round trip passes end to end.
- [ ] Every caller of the old routes across core, fetcher-host, cli, server and platforms is moved,
      and the whole workspace gate is green.
- [ ] Two named indexers on one server are isolated: a batch pushed to one is not visible to the
      other.
- [ ] Ship a changeset for every published package whose surface changes (at least `@etherfold/core`
      and `@etherfold/server`).
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None.

## Prompt

> Make `@etherfold/server` host several NAMED INDEXERS. Today it hosts exactly one: `getIngestion`
> resolves a single `LogIngestion`, and the ingest routes are the unnamespaced `/ingest` and
> `/ingest/expected-from-block`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED):
> does it still match the code, the tasks in `work/tasks/done/` and the relevant ADRs (0004 on the
> wire contract and the receiver-authoritative cursor, 0003 on the split)? If a dependency landed
> differently, do not build on the stale premise: route to needs-attention with the discrepancy
> (WORK-CONTRACT.md, Drift is a needs-attention signal).
>
> Vocabulary. A NAMED INDEXER is the server and CLI multi-tenancy unit: one indexed answer set over
> one chain. The name arrives at deploy time, supplied by the operator and refused when absent; a
> host registers the N named indexers it was built with. It is NOT a runtime code upload.
>
> The name is a ROUTE SEGMENT, not a field in the wire envelope. Carrying it in the envelope was
> considered and rejected, because it would make the wire format carry tenancy and turn a misdirected
> batch into a payload error rather than a routing one. ADR-0004's envelope and its refusal families
> stay exactly as they are.
>
> Resolve a registry ENTRY OBJECT per name rather than a bare `LogIngestion`. A sibling spec will
> widen an entry to hold several live wire contexts at once, and an entry object makes that additive.
>
> Where to work: the server's route and options modules, and `ingestClient` in `@etherfold/core` for
> the sending half. Do NOT stop at the server: search the workspace for the route strings and move
> every caller, including the tests in cli, core, fetcher-host, server and platforms/nodejs. A build
> that changed only the server would ship one no fetcher can reach, and the gate would be red.
>
> Done means: both namespaced routes answer per name, the unnamespaced pair is GONE and asserted
> gone, two named indexers on one server cannot see each other's batches, and a full send/receive
> round trip passes.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular the registry entry's shape and how an unknown name is refused.

## Decisions

- **The registry entry is `{ingestion: LogIngestion}` and carries NO `name`.** Chosen so the sibling widening (several live wire contexts per entry) is an added field rather than a change to the resolver's return type, which is exactly what the task asks for. The name is deliberately absent from the entry because the ROUTE SEGMENT is the single source of that value and a second copy is something a write path could key on while it disagrees with the URL; the next task (`the-emission-stream-table-...`) reads the name from `c.req.param('indexer')` in the same handler. Alternative considered: `{name, ingestion}` (self-describing, but two sources of one discriminator).
- **An unknown name is `404 unknown-indexer`; a host with NO registry at all keeps `501 ingestion-not-configured`.** A name is a route, so "no such tenant" is a routing refusal, not ADR-0004's payload `400` family (which stays exactly as it was) and not a resumable `409`. Keeping `501` for the no-registry case preserves what `run` and `serve` have always answered, and says the honest thing: one is a capability this host lacks, the other a tenant it was not built with. It is never a default to "the only indexer this host holds". Touches `createHttpIngestion` (404 joins the non-retryable 4xx family, with a hint naming the name) and the `run`/`serve` tests. Alternative considered: `400` for coherence with the wire families, rejected because it would re-mean the payload family.
- **The token guard stays AHEAD of the registry lookup**, so an unauthenticated caller gets `401` even for an unknown name and cannot enumerate the names a host was built with. Asserted.
- **New export `indexerRegistry(record)` in `@etherfold/server`.** Sugar over the resolver for hosts that know their names up front (used by the round-trip test and three harnesses); own-property lookup so `constructor`/`toString` resolve to nothing. The CLI's `index` deliberately does NOT use it and writes the two-line resolver inline, because that module imports `@etherfold/server` lazily on purpose (a folding process must not pull hono into its import graph).
- **`createHttpIngestion` throws on a blank name** (a plain `Error`, matching the existing "no global fetch in this runtime" refusal beside it). This is a new refusal, at construction rather than at the first push, on the ground that a missing name is a deployment that was never configured.
- **CLI: `--indexer <name>` / `INDEXER_NAME` is REQUIRED on `fetch` and `index`, and REFUSED on `run`, `build` and `serve`.** Required-and-never-defaulted follows the vocabulary ("supplied by the operator, refused when absent") and ADR-0048's rule that only `--port` may default. Refused on the other three because none of them routes a batch by name, and this repo refuses rather than accepts-and-ignores; refusing is also the reversible direction (accepting a flag later is free, refusing it later is breaking). What it touches: it is a new row in `INPUTS`/`OWNERSHIP`/`REFUSALS`, a new `INDEXER_NAME` variable in the CLI's published env contract, and a fence a later task must open if `run`/`build` ever need a name of their own (e.g. if the emission table keys `run`'s rows on one). Alternative considered: a constant default name in the CLI, rejected because a silent default is precisely the misdirected-batch hazard the discriminator exists to remove.
- **The fetcher-host's missing-variable message now formats three names as "A, B and C"** (two still reads "A and B", so the existing message is unchanged for the pre-existing case).

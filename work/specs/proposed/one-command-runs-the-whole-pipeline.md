---
title: 'One command runs the whole pipeline, and the split is a deployment choice rather than a milestone'
slug: one-command-runs-the-whole-pipeline
taskedAfter: [one-processor-everywhere]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

**The combined pipeline already works, and no user can run it.** `one-processor-cli-and-split-server`
proved with a test that one processor and one set of entity declarations produce the same state under
the single-process path and the split path. That test constructs the pieces directly, so the capability
exists in the repo and is unreachable from a terminal.

What a terminal offers instead is two commands that each do part of it:

- **`etherfold index`** folds, but is one-shot and REFUSES an entity processor outright
  (`packages/cli/src/index.ts` throws `this processor do not support "keepState" config`), which is
  exactly the processor kind the project is built around.
- **`etherfold serve`** starts the HTTP server with `{getDB, getEnv}` and **no `getIngestion`**, so it
  hosts no processor and no fetcher. It is the RECEIVING half of a split, waiting for a remote pusher
  that a user has no command to run either.

So the shape a developer most wants — one process that follows a chain, folds into SQLite, and answers
an HTTP endpoint, on any Node runtime — is assembled by nobody, even though every part of it ships:
`@etherfold/fetcher-host` (`runFetcherLoop`, backoff, scheduling), `createDirectIngestion` in core
(both halves of the ADR-0004 wire in one process, in about eighteen lines), `@etherfold/state-store-sqlite`,
and `@etherfold/server` with `/status` behind `platforms/nodejs` on libSQL.

**And the tree reads as though the split were the goal.** ADR-0003 split the components for good
reasons, and every spec since has been written per component, so a reader would reasonably conclude
that the split deployment is the target and the combined one a convenience. It is the other way round:
the combined deployment is the thing that must work end to end first, and the split is a deployment
choice made when a chain-facing host and a serving host genuinely need to be different machines.

## Solution

**Five commands, named for the DEPLOYMENT INTENT rather than for the internal split**, so choosing one
needs no knowledge of how the components divide:

| command | follows the chain | folds into state | answers queries | terminates | database |
| --- | --- | --- | --- | --- | --- |
| **`run`** | yes | yes | yes | no | owns it |
| **`build`** | yes | yes | no | at the tip | owns it |
| **`fetch`** | yes | no | no | no | none |
| **`index`** | no | yes | no | no | owns it |
| **`serve`** | no | no | yes | no | reads one written elsewhere |

Two compositions, and both are true of the CODE rather than slogans: **`run` is `fetch` plus `index`
plus `serve` in one process** — the first pairing is precisely what `createDirectIngestion` expresses,
the same `LogFetcher` and the same `StreamBuilder` with the transport as the only difference
(`CONTEXT.md`, "the wire is a deployment choice, not two implementations") — and **`build` is `run`
without the serving, stopping at the tip**. No component is implemented twice, and no command is a
special case of another's code.

**`run` is the priority and the default thing to reach for.** It is the one that must work on any Node
runtime, and it is the one this spec exists to create.

**The query surface is `/status` and nothing more, deliberately.** It already reports the cursor, the
reorg counters (`absence` versus `contradiction`, per ADR-0004) and the schema version, which is
enough to see the pipeline working and to operate it. A richer query layer is real future work and is
explicitly NOT in this milestone; see Out of Scope, because several specs name it as their consumer
and a reader should not assume it is imminent.

## User Stories

1. As a developer, I want ONE command (`run`) that follows a chain, folds into SQLite and answers
   HTTP, so I can run the whole indexer locally without assembling components or reading about a
   split.
2. As a developer, I want the processor object I run in a browser tab to run under `run` UNCHANGED, so "write it once" is something I can verify from a terminal rather than from a test file.
3. As an operator, I want to run the chain-facing half on a host near my node and push to an
   indexer-server elsewhere, without changing my processor, my declarations or my configuration — so
   splitting is a deployment decision I can defer and then reverse.
4. As an operator, I want a read-only endpoint (`serve`) over a database something else writes, so the
   serving tier can scale or move without carrying an indexer with it.
5. As a developer or a CI job, I want a command that follows the chain, folds, and EXITS at the tip, so
   I can produce a database or a publishable artifact reproducibly without running a server.
6. As an operator, I want `/status` to tell me the cursor, the reorg counters and the schema version, so
   a running deployment is observable without a query layer existing yet.
7. As a developer choosing a command, I want the NAMES to describe what the process does for me, so I do
   not have to learn the fetcher/stream-builder/read-surface split to pick one.

## Implementation Decisions

**`run` is assembly, not new machinery.** It constructs a `LogFetcher`, wires it to a `StreamBuilder`
through `createDirectIngestion`, gives the stream-builder an `EntityEventProcessor` over a
`state-store-sqlite` store on one libSQL handle, hands the same handle to `@etherfold/server` as its
`getDB`, and drives the whole thing with `runFetcherLoop`. Every one of those exists. If a task finds
itself designing a component, it has left this spec.

**The names are chosen freely, and NOTHING in the existing CLI constrains them.** Say so explicitly,
because the opposite was assumed once already: an earlier draft preserved `index`'s current meaning on
the ground that `stratagems-snapshots` shells out to it. That is not a constraint. Nothing is
published, stratagems is a CAPABILITY REFERENCE rather than a compatibility constraint (`CONTEXT.md`),
and any consumer we own is ours to update in the same change. Renaming and re-meaning every command is
free; the cost is a changeset and a README.

**`serve` means ONLY serving, and freeing it is what made the set work.** An earlier draft had `serve`
do everything, which left the read-only tier with no honest name: `read` and `query` both sound like
ISSUING a query rather than answering one, `api` is equally true of the commands that fold, and
`reader` collides with **consumer**, which `CONTEXT.md` reserves for anything reading the FEED and
warns against renaming. The ambiguity was never in the read tier's name — it was that the serving verb
had been spent on a command that does three jobs. So `serve` answers queries and does nothing else,
and the all-in-one is `run`.

**`index` is the FOLDING half, because indexing is turning logs into state.** The half that fetches
holds no cursor, no state and no database — ADR-0003 made it stateless on purpose — so it has the
weakest claim to the project's central verb, and naming it `index` would leave the component that
actually indexes without a name. `fetch` matches the domain term (`log-fetcher`) exactly. Note the
retired word: that component used to be the "watcher" and ADR-0003 renamed it; do not bring it back.

**`index` exposes `/ingest` but NOT the query API, and that asymmetry is the point.** It has an HTTP
surface because it must RECEIVE pushed batches, which is the write path; answering queries is
`serve`'s. So a split deployment is `index` and `serve` against ONE database — the writer and a
stateless read tier — and that shape falls out of the command set instead of needing to be explained.
`/status` is available wherever there is an HTTP surface, since it reports on the database rather than
on the process.

**`build` is the one-shot, and it is named for what it PRODUCES.** Follow the chain, fold, stop at the
tip, exit — for CI, for a reproducible local database, and later for producing an artifact a browser
can seed from (a captured stream or a state snapshot,
`a-generation-can-be-seeded-from-a-published-artifact`). "Run my indexer" and "make a thing, then stop"
are different intents with different users, which is why this is a command rather than a flag on
`run`.

**`serve` is defined now and earns its keep later.** With no query layer it would answer `/status` and
nothing else, which is not much of a product. It is specified here so the SHAPE is fixed — a serving
tier that holds no processor and writes nothing — and so that `run` and `index` are not accidentally
built in a way that assumes the writer and the reader are the same process. Do not let its thinness
today argue for folding it into `run` as a flag.

**`serve` expects a remote database, and libSQL makes that free.** `createClient` takes `libsql:`,
`http(s):` and `ws(s):` URLs, so a read tier connects to a Turso database the writer also uses with no
new API and no SQL-over-HTTP endpoint. A general SQL-over-HTTP surface is explicitly rejected: the
narrow, authenticated, idempotent-by-cursor `/ingest` wire is what this system uses for remote writes,
and a second, wider one would be strictly worse.

**Every command takes the same processor and source configuration**, so moving between them is a
deployment change and never a rewrite. That is story 12 of `one-processor-everywhere` made reachable.

## Testing Decisions

- **The headline is a TERMINAL test, not a unit test**: invoke `run` against a fixture chain, assert
  state lands in SQLite and `/status` reports an advancing cursor. The existing proof of equivalence is
  a test that constructs the pieces; this must be the command.
- **The same processor object under `run` and in a browser** produces the same state, which is the
  assertion that makes story 2 more than a claim. `one-processor-cli-and-split-server` already pins the
  single-process versus split equivalence; extend that shape rather than inventing a second one.
- **`run` and `fetch` + `index` produce identical state** from the same fixture, which is the concrete
  form of "the split is a deployment choice": the same components, the transport as the only
  difference. Assert too that `index` + `serve` against ONE database answers the same reads as `run`.
- **`build` terminates at the tip and exits non-zero on failure**, so a CI job can depend on its exit
  code rather than on parsing output.
- **`serve` answers reads against a database it did not write**, and refuses to write.
- **No command silently degrades**: a missing node URL, an unreachable database or an absent processor
  is a refusal that names the flag, not a process that starts and does nothing.

## Out of Scope

- **The GraphQL query layer.** Decided in principle elsewhere (Hono, Yoga, Pothos over entity
  declarations, with `one-processor-everywhere` guaranteeing the schema source) and deliberately NOT in
  this milestone. `/status` is the query surface for now. Recorded explicitly because
  `a-reconfigure-is-not-an-outage` and `the-server-and-cli-hold-generations-too` both name that layer
  as a consumer, and a reader should not infer it is imminent.
- **The log FEED and its two views**, which are `indexer-server-feed`.
- **Generations, the canonical pointer and multi-indexer hosting**, which are
  `a-reconfigure-is-not-an-outage` and `the-server-and-cli-hold-generations-too`. This spec is one
  indexer per process; `index` and `serve` gain the indexer-name route segment when that lands.
- **Triggers**, which are a separate deliverable entirely (ADR-0005).
- **A serverless shape for `run` or `fetch`.** A cron cannot follow a chain (`CONTEXT.md`); the
  chain-facing half needs a host that can hold a process.

## Further Notes

The tasks this emits should be `blockedBy` `index-to-a-store-from-the-cli`, which is what makes the CLI
accept an ENTITY processor at all (today it throws `this processor do not support "keepState" config`)
and is currently unblocked in `work/tasks/backlog/`. Note that task is written against the CLI's
current `index` command; under this spec's names its work lands in `build` and `run`, which is a
rename of where it goes and not a change to what it does.

`server-platform-adapters` records that both host adapters are already built and that its one remaining
criterion — D1's statement and size limits reaching the store's chunk bound — was blocked on the server
having no store dependency. `run` is the first thing that wires a store into a server process, so
that criterion becomes reachable here; it is not this spec's to deliver, but the seam it was waiting
for is the one this spec creates.

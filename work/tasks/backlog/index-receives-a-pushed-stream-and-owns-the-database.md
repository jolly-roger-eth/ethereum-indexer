---
title: '`etherfold index` receives a pushed stream, owns the database, and makes the split a deployment choice'
slug: index-receives-a-pushed-stream-and-owns-the-database
spec: one-command-runs-the-whole-pipeline
blockedBy: [the-node-server-starts-on-a-handle-it-was-given, fetch-is-the-only-way-to-run-a-fetcher]
covers: [3]
needsAnswers: true
---

## What to build

The RECEIVER, which is the gap the spec's problem statement actually names. A split deployment today is missing this half, not its sender: the read tier starts the server with a database and an environment and NO ingestion, so it hosts no processor and can receive nothing, while the chain-facing half has been runnable all along.

`etherfold index` is the folding half as a command: it makes no chain call, it hosts an HTTP surface because it must RECEIVE pushed batches, it folds them through a stream-builder into an entity processor over a versioned state store, it owns the database, and it does not terminate. Indexing is turning logs into state, which is why this name is on this half: the fetching half holds no cursor, no state and no database, so it has the weakest claim to the project's central verb.

**It exposes the write path and not the query API, and that asymmetry is the point.** So a split deployment is `index` plus `serve` against ONE database, the writer and a stateless read tier, and that shape falls out of the command set instead of needing to be explained. `/status` is available wherever there is an HTTP surface, since it reports on the database rather than on the process.

**It makes NO chain call, and that constrains how it resolves its source.** The receiver is chain-free by design, which is why the chain-free stream-builder exists as its own object. The source it folds under must match the sender's, because the wire identity is derived from the source and the stream config together, so the source must be given explicitly rather than discovered by asking a node which chain it is on. A module whose contracts can only be resolved that way is a refusal naming the explicit alternatives, not a chain call made quietly.

**It receives authenticated pushes and fails closed.** The receiving server authenticates a sender with a shared secret and refuses every caller when none is configured, which is the fail-closed direction on purpose. The command resolves that secret through the shared configuration path and passes it to the host, so a receiver with no secret configured is a receiver that refuses, loudly, rather than an open write endpoint.

**The cursor reporter is THIS command's, and the read tier is given none.** `index` owns a store, so it builds a cursor reporter the same way `run` does and hands it to the server through the Node adapter: that is what makes `/status` on a split deployment show progress. `serve` owns no store, is given no reporter, and therefore reports no cursor. Do not "fix" that here: the `serve` command path belongs to the rename task, which declares its behaviour unchanged, and whether a read tier should report a cursor read out of a database it does not write is a real question for a later milestone rather than a detail to settle inside this task.

**This is where the split stops being a slogan.** With `run`, `fetch` and `serve` all in place, the equivalence the spec cares about is finally assertable end to end, and it is the concrete form of "the split is a deployment CHOICE": the same components, the transport as the only difference. Those assertions land here because this is the last command that makes them possible.

## Acceptance criteria

- [ ] `etherfold index -p <module> --store sqlite --db <url> …` starts a process that receives pushed batches over HTTP, folds them into the named database, and keeps running.
- [ ] It makes NO chain call: asserted, not asserted-by-inspection only. No node URL flag is accepted, and a source that could only be resolved by asking a node is refused naming the explicit alternatives.
- [ ] Its server hosts the ingestion capability, supplied through the Node adapter rather than by a second server host built in the CLI, so the ingestion routes work rather than answering `501`, and `/status` reports the cursor advancing as batches land, through the same reporter shape `run` already builds.
- [ ] It answers no query API beyond `/status`, which is the whole query surface for this milestone.
- [ ] A push with no shared secret configured on the receiver is refused, and a push with the wrong secret is refused: the receiver authenticates or it refuses everyone.
- [ ] The state store and the server share ONE database handle, built once by the command.
- [ ] EQUIVALENCE: `run` and `fetch` plus `index` produce IDENTICAL state from the same fixture chain, including through a reorg, with the transport as the only difference between the two runs.
- [ ] EQUIVALENCE: `index` plus `serve` against ONE database answer the same reads as `run` does, bounded to the surfaces that EXIST in this milestone, because the query layer is deliberately deferred and this task adds no query route. Concretely: the read surface generated from the entity declarations, opened over the database `serve` is pointed at, returns what the same surface returns over `run`'s database; and the `/status` a `serve` process answers agrees with `run`'s on the reorg counters and the schema version, which are the fields the server reads out of the DATABASE itself.
- [ ] The CURSOR is deliberately NOT part of that read-tier parity, and the task is done without it: the cursor reaches `/status` only through an injected reporter, a read tier owns no store and is given none, so `serve` reports no cursor in this milestone. Assert cursor parity between `index` and `run`, never against `serve`, and do NOT add a reporter to the `serve` path (that file belongs to `the-one-shot-is-build-and-serve-is-only-the-read-tier`, which declares `serve` unchanged). If that reads as too little, it is the honest size of the read tier today and NOT a licence to add a read route.
- [ ] The pushed-batch path is idempotent by cursor the way the wire already is: replaying a batch does not double-apply it, and a sender that has fallen behind is corrected rather than accepted.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style): a real sender against a real receiver over real HTTP, as the existing round-trip test does, plus the refusals.
- [ ] The CLI readme documents the split shape (`index` plus `serve` against one database, `run` when one process is enough), and says plainly that the read tier answers `/status` without a cursor. A changeset records the new command.
- [ ] `CONTEXT.md`'s command-set bullet stops saying the set is DECIDED, NOT YET BUILT: with this command the five names all exist, so the caveat and the sentence about which names currently mean something else are replaced by what is true. The five meanings, the two compositions and the three naming rules stay as they are. This is the LAST command in the set, which is why the final correction is owned here.
- [ ] The whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- `the-node-server-starts-on-a-handle-it-was-given`, which is what lets this command's server start on the handle its store folds into and carry the cursor reporter.
- `fetch-is-the-only-way-to-run-a-fetcher`, which supplies the sender the equivalence assertions drive, and which edits the same command-registration module.

## Prompt

> Goal: build the receiving half of a split deployment as a command, and then prove with a test that the split is a deployment choice rather than a second implementation.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? Read the done records of `ingest-wire-receiving-side` and `index-to-a-store-from-the-cli` before you start: the first built the wire this command receives on, the second built the folding assembly it reuses. If either landed differently than this task assumes, route the task to needs-attention with the discrepancy rather than building on it.
>
> Read: `work/specs/ready/one-command-runs-the-whole-pipeline.md` (the Solution table, the Implementation Decision explaining why the write path and the query API are on different commands, and the Testing Decisions, which are the source of the two equivalence criteria), plus `CONTEXT.md`'s command-set bullet and its glossary entries for the stream-builder and the ingest wire.
>
> Vocabulary: the **stream-builder** is the chain-free receiver, authoritative about the cursor, deriving every reorg, making no chain call; the **cursor is the idempotency key** of the wire, which is what makes a resumed or replayed push safe; the wire's refusals come in two families, one resumable and one immediate, and the resumable one is how a sender that has fallen behind is corrected with no operator involved; **absence** versus **contradiction** is the reorg distinction the counters on `/status` report (ADR-0004).
>
> Where to look: the server package's ingestion route and its options type (the ingestion capability is INJECTED by the host, because which processor runs against which source is a deployment's choice and not an HTTP app's); the Node server platform adapter, which by the time you start accepts an existing handle and passes an ingestion and a cursor reporter through to the app (`the-node-server-starts-on-a-handle-it-was-given` adds all three, so do not add a second server host here); the CLI's existing folding assembly and the cursor reporter `run` already builds from it; and the server package's existing fetcher round-trip test, which already drives a real sender against a real receiver and is the shape the equivalence tests extend.
>
> Constraints: no chain call anywhere in this command's path; no query API beyond `/status`; no second folding engine (the server-side engine is the stream-builder, decided and landed); no SQL-over-HTTP surface, ever, since the narrow authenticated idempotent-by-cursor wire is how this system does remote writes and a wider one would be strictly worse; and the indexer-name route segment that a multi-indexer host will need is explicitly NOT in this milestone (`the-server-and-cli-hold-generations-too` owns it), so this is one indexer per process.
>
> The equivalence tests are the payoff and deserve care: the SAME processor and the SAME entity declarations, one fixture chain including a reorg whose replacement branch carries fewer events, run twice, once through `run` and once through `fetch` plus `index`, landing on identical state. The pre-existing deployment-shapes test in the SQLite processor package pins that equivalence at the COMPONENT level; extend that shape at the COMMAND level rather than inventing a second harness, and make it assert at the commands the way this spec insists ("this must be the command").
>
> Two traps in the read-tier assertion, so you do not build out of scope. FIRST: `serve` answers `/status` and nothing else, and the GraphQL layer is explicitly NOT in this milestone, so "the same reads" means the generated read surface opened over the same database, plus parity on the `/status` fields the server derives FROM the database (the reorg counters and the schema version). Adding an HTTP query route to make the sentence literal would be shipping the deferred milestone, and a SQL-over-HTTP surface is rejected outright. SECOND: the cursor reaches `/status` only through an INJECTED reporter, and the read tier owns no store and is given none — so `serve` reports no cursor, that is correct rather than a bug, and you must NOT reach into the `serve` command path to give it one. That path belongs to the rename task, which declares `serve`'s behaviour unchanged. Assert cursor parity on `index` against `run`. If you conclude a read tier genuinely SHOULD report a cursor read out of a database it does not write, that is a `work/notes/ideas/` note or a needs-attention signal, not scope to take here.
>
> Done means: the receiver runs, refuses what it should, the split and the combined runs land on identical state, a read tier over the same database agrees on the reads and on the database-derived `/status` fields, the readme and `CONTEXT.md` say the set is built, a changeset records it, and the gate is green.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself. Ones to expect: how the source is given to a chain-free command and what is refused; whether the schema auto-setup default is right for a writer that owns its database; and exactly how the bounded read-tier assertion is expressed (which surface, opened where), given the query layer is deferred and the read tier reports no cursor.

---

### Claiming this task

```sh
dorfl claim index-receives-a-pushed-stream-and-owns-the-database --arbiter origin
git fetch origin && git switch -c work/index-receives-a-pushed-stream-and-owns-the-database origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/index-receives-a-pushed-stream-and-owns-the-database.md work/tasks/done/index-receives-a-pushed-stream-and-owns-the-database.md
```

## Open questions

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

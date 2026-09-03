---
title: '`etherfold run` follows a chain, folds into SQLite and answers HTTP, in one process'
slug: run-follows-folds-and-answers-in-one-process
spec: one-command-runs-the-whole-pipeline
blockedBy: [one-configuration-path-for-every-command, the-node-server-starts-on-a-handle-it-was-given]
covers: [1, 2, 6]
needsAnswers: true
---

## What to build

The headline of the spec and the command it exists to create. One process that follows a chain, folds an entity processor into SQLite and answers an HTTP endpoint, on any Node runtime, reachable from a terminal with no knowledge of how the components divide.

**It is ASSEMBLY, and every part of it ships.** A log-fetcher wired to a stream-builder through the direct ingestion (the two ADR-0003 halves with the transport removed, which is what "the wire is a deployment choice, not two implementations" means in code), the stream-builder driving an entity processor over a versioned state store on ONE libSQL handle, that same handle handed to the server as its database, and the whole thing driven by the fetcher host's loop. The one-shot already assembles exactly this pipeline and its done record explains every choice inside it; `run` is that assembly with two differences and no third:

1. **It does not stop at the tip.** The one-shot is the host loop plus an abort fired from the first caught-up or idle report. `run` is the same loop without that abort: it follows the tip forever, backing off to a poll interval when there is nothing above the cursor. Stopping is a signal, not a report.
2. **It serves.** The server starts on the handle the store folds into, and it is given a cursor reporter that reads the store's sync cursor, so `/status` reports a cursor that ADVANCES while the process runs.

If a task in this area finds itself designing a component, it has left the spec. The one engine question is already decided and already landed: the server-side folding engine is the stream-builder, NOT the browser's indexer generation. Do not construct the browser's engine here, and do not add a second folding path. The point of that decision is that "`run` and the split produce identical state" asserts something about the TRANSPORT rather than about two implementations that happen to agree.

**`run` does not accept pushed batches over HTTP.** Its ingestion is the in-process direct wire, so no ingestion capability is injected into its server and the ingestion routes answer `501` there, exactly as they do for the read tier. A remote sender pushing into a process that is already fetching for itself would be a second writer nobody asked for; the command for receiving pushes is `index`, and that asymmetry is the point of the set. The routes stay MOUNTED either way: the difference is a capability, not a route table.

**Read the ingest route before you write the `501` assertion, because the literal sentence above is not what an unauthenticated caller sees.** The token guard is registered on the PATH (`/ingest` and `/ingest/*`) and runs BEFORE the capability lookup, and the token check fails CLOSED when no `INGEST_TOKEN` is configured. So a processor-less server answers `401` to an unauthenticated call and only answers `501` to an AUTHENTICATED one. The existing seam test in the server package already does it correctly: configure a token, present a matching bearer header, then assert `501` with the ingestion-not-configured error. Do NOT make the sentence literal by moving the guard after the capability check: that would tell an unauthenticated caller whether a server hosts a processor, and the guard sits on the path precisely so a route added later inherits it.

**Signals and the exit code.** A long-running process stops on the signals a container sends, letting the cycle in flight finish, and exits zero; a refusal no waiting fixes (a foreign source or config, the wrong chain, a suspected truncation) ends the loop and exits non-zero. The fetcher host adapter already owns signal handling and the exit code for a fetcher process and accepts an ingestion target as a dependency, which is exactly the seam a combined host is meant to use, so prefer reusing it over writing a second signal handler.

**Story 2 becomes checkable here.** The same processor object that runs in a browser tab runs under `run` UNCHANGED. The NFT example is the artifact that makes it evidence rather than a claim: its entity declarations file is what the browser demo imports and what its CLI entry hands over, and there is now exactly ONE way to author a processor, so nothing is wrapped or tagged on the way in. Extend the shape of the example's existing CLI test rather than inventing a second equivalence harness.

## Acceptance criteria

- [ ] `etherfold run -p <module> --store sqlite --db <url> …` starts one process that follows the chain, folds into the named libSQL database and answers HTTP on the resolved port, and keeps running when it reaches the tip.
- [ ] The state store and the server share ONE database handle, built once by the command.
- [ ] `/status` reports a cursor that ADVANCES as the run makes progress: asserted across cycles, not once.
- [ ] A `run` process hosts no remote writer: with a token configured and a matching bearer header presented, the ingestion routes answer `501` with the ingestion-not-configured error (the shape the server package's existing ingest test already uses), while `/status` answers normally. The path-level token guard keeps its position ahead of the capability lookup, and an unauthenticated call keeps answering `401`.
- [ ] No component is implemented twice: the fetch-and-fold assembly is the SAME one the one-shot uses, refactored into something both share rather than copied, and the browser's engine is constructed nowhere in the command path.
- [ ] The command terminates only on a signal (exit 0, cycle in flight allowed to finish) or on a fatal refusal (non-zero), and never on reaching the tip.
- [ ] Every input is resolved through the shared configuration path, and a missing node URL, database, processor or source is a refusal that names the flag and the variable, raised before any chain call or database write.
- [ ] THE HEADLINE TEST is at the COMMAND, not at the pieces: it drives the same entry point the subcommand's action invokes (with the provider, the database builder, the sleep and the stop signal injected the way the one-shot's tests already inject them), against a fixture chain, over a real libSQL database and real HTTP, and asserts state landed AND the reported cursor advanced.
- [ ] Story 2 is asserted with the NFT example's unchanged entity declarations, the same file the browser demo imports, running under `run`, extending the shape of that example's existing CLI test.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style), including the non-zero exit on a fatal refusal.
- [ ] The CLI readme documents `run` as the default thing to reach for, and a changeset records the new command.
- [ ] The whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- `one-configuration-path-for-every-command`, which owns the flag-and-environment resolution this command uses and touches the same command-registration module.
- `the-node-server-starts-on-a-handle-it-was-given`, which is what lets the server start on the handle the store folds into and carry the cursor reporter.

## Prompt

> Goal: build the command this whole spec exists for. One process, one terminal invocation: follow a chain, fold into SQLite, answer HTTP, report an advancing cursor.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? In particular read the done record of `index-to-a-store-from-the-cli`, which built the assembly you are reusing and whose decisions (how the module hands over its processor, how the store target is refused, how the tip stop works, why the retention floor is validated against the stream's resolved finality) are the constraints you inherit. If something landed differently than this task assumes, route the task to needs-attention with the discrepancy rather than building on it.
>
> Read: `work/specs/ready/one-command-runs-the-whole-pipeline.md` (the Solution table, the two compositions, and the Implementation Decisions section on which ENGINE folds and why), and `CONTEXT.md`'s command-set and "what must work FIRST" bullets.
>
> Vocabulary, all of it already in the tree: a **log-fetcher** is stateless and chain-facing, holds no cursor and pushes contiguous block ranges; an **ingestion target** is where it pushes, and the DIRECT one is the wire with no wire, for a process that also runs the receiving half; a **stream-builder** is the chain-free receiver, authoritative about the cursor and the origin of every reorg; an **entity processor** folds decoded events into a **versioned state store**; a **fetcher host** decides WHEN a cycle runs and classifies each cycle into the five things a scheduler can act on, of which three are not failures. The store holds the rows AND the cursor in one transaction, which is why nothing in the command keeps a cursor of its own and why an interrupted run resumes from the store.
>
> Where to look: the CLI's existing one-shot assembly and its tests (a fake chain provider, a real in-memory libSQL, injected sleep and abort); the fetcher host's loop and its adapter for Node, which handles signals and resolves an exit code and accepts an ingestion target as a dependency; the Node server adapter for starting on a handle; the entity processor's cursor module for the key the store keeps its cursor under and the codec that reads it.
>
> Decisions already made for you, so do not re-open them: the folding engine is the stream-builder and not the browser's indexer generation; `run` injects no ingestion capability into its server, so its ingestion routes answer `501`; the split is a deployment choice, so nothing here may be a second implementation of a component. Two things the spec asks you to CHECK rather than assume while assembling: that a reorg's retractions reach the processor in ONE batch through this path, and that the run resumes from the persisted cursor rather than from the start block. (A third check the spec lists is now void: the free-form JS-object processor path it wanted verified is retired and gone, there is one authoring path.)
>
> Seams to test at: the command entry (drive the function the subcommand's action calls, with dependencies injected, which is how the one-shot is tested), the HTTP surface (real requests against the started server), and the store (real libSQL). "Invoke the command, not the pieces" is the spec's explicit requirement: the pre-existing proof of this capability is a test that constructs the components directly, and the whole gap being closed is that nobody can run it from a terminal.
>
> Done means: the command exists, the headline test drives it end to end against a fixture chain with an advancing reported cursor, the example's unchanged processor runs under it, the readme and a changeset record it, and the gate is green.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself. Ones to expect: how the shared assembly is factored so the one-shot and the follower are one path with one difference; what the cursor reporter reports (the store's cursor is a serialized structure carrying an unconfirmed window of decoded events, so reporting it whole would put an enormous blob on a status page, and the server reports verbatim whatever you hand it); and whether a retryable failure is ever bounded for a follower, given the one-shot deliberately left that decision to this command.

---

### Claiming this task

```sh
dorfl claim run-follows-folds-and-answers-in-one-process --arbiter origin
git fetch origin && git switch -c work/run-follows-folds-and-answers-in-one-process origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/run-follows-folds-and-answers-in-one-process.md work/tasks/done/run-follows-folds-and-answers-in-one-process.md
```

## Open questions

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

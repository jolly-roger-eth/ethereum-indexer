---
title: '`etherfold fetch` is the only way to run a fetcher, and the standalone binary is retired'
slug: fetch-is-the-only-way-to-run-a-fetcher
spec: one-command-runs-the-whole-pipeline
blockedBy: [one-configuration-path-for-every-command, run-follows-folds-and-answers-in-one-process]
covers: [3]
---

## What to build

The chain-facing half of a split deployment, as a command, plus the retirement of the second way to run it.

**This is a front door, not a new deployable.** The Node fetcher platform already ships the whole thing: a library entry that starts the loop and returns a stoppable handle, a process wrapper that handles the signals a container sends and resolves an exit code, and a configuration resolver that refuses by name. What it does NOT have is a flag surface: it is configured from the environment only. So `etherfold fetch` puts flags in front of configuration that is environment-only today, resolved through the shared configuration path (flags first, environment behind them), and the adapter package keeps everything else.

**And the standalone binary is RETIRED in the same change, because there is exactly ONE way to run a fetcher.** The adapter loses its process entry point and its `bin` entry and survives as a LIBRARY, which is precisely the shape the Node SERVER platform already has: no binary, and the CLI imports its start function. So the symmetry is restored rather than invented, and the runtime adapter stays the only place a runtime is named (ADR-0003's rule for `platforms/*`). One thing the retired entry point did that a library must NOT do: it hooked the logging facade to the console. That belongs in a process entry point, because an application embedding the library chooses its own sink, so the hookup moves into the CLI's fetch path rather than disappearing.

This deletion is a named deliverable of THIS task and not a side effect of another. Removing a `bin` is a breaking change to that package, so it carries a changeset that says so.

**What the command owns and what it refuses.** It takes a node URL, a source, an ingest endpoint and an ingest token. It takes NO processor, because the chain-facing half holds no processor by ADR-0003, and it owns NO database, so the store and database flags are REFUSED there with a message saying why rather than accepted and ignored. That refusal is the point of the correction the spec makes about this row: the one command that needs nothing but a node URL, a source and an endpoint must not inherit a required store flag from the commands that own state.

## Acceptance criteria

- [ ] `etherfold fetch` runs the fetch loop against a node and pushes contiguous ranges to a remote ingest endpoint, configured by flags with the environment behind them, and keeps running until stopped.
- [ ] It stops on the signals a container sends, letting the cycle in flight finish, and resolves the same exit code the retired binary did: non-zero when it stopped on a refusal, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing.
- [ ] The store and database flags are REFUSED on `fetch`, naming why (this command owns no state), and a missing node URL, source, endpoint or token is a refusal naming the flag and the variable.
- [ ] It holds no cursor and no place to remember where it got to: no state file, no lock file, no from-block flag. Progress across restarts comes from the receiver's cursor and from nothing else.
- [ ] A source can be given without a processor module, from a deployments folder or from the source variable.
- [ ] The standalone `etherfold-fetch` binary is GONE: the process entry point is deleted and the package's `bin` entry with it, while the library entry (the start function, the process runner, the loop, the signal handling, the exit code) survives unchanged.
- [ ] The console log sink that the retired entry point installed is installed by the CLI's fetch path instead, so a fetcher's cycle logs still reach a terminal and an embedding application still chooses its own sink.
- [ ] The fetcher platform's readme no longer tells a reader to run a binary that does not exist, and points at the command instead.
- [ ] Changesets record both halves: a BREAKING change for the fetcher platform package (a published `bin` removed) and the new command for the CLI.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style): the flag-and-environment resolution reaching the host, the refusals, and one drive of the loop against a fake chain pushing into a receiver a test supplies.
- [ ] The whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- `one-configuration-path-for-every-command`, which owns the resolution this command uses, including the source-without-a-processor case.
- `run-follows-folds-and-answers-in-one-process`, which edits the same command-registration module. Serialized deliberately to avoid a merge conflict, and because `run` is the priority.

## Prompt

> Goal: give the chain-facing half a flag surface as `etherfold fetch`, and leave exactly ONE way to run a fetcher by retiring the standalone binary in the same change.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? If a dependency landed differently than this task assumes, do NOT build on the stale premise, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Read: `work/specs/ready/one-command-runs-the-whole-pipeline.md` (the Solution table's `fetch` row and the Implementation Decision that retires the binary), and `CONTEXT.md`'s glossary entries for the log-fetcher and the fetcher host, which are unusually detailed and worth reading in full before you touch either.
>
> Vocabulary: a **log-fetcher** is stateless and chain-facing, holds no cursor and no reorg logic, and pushes contiguous block ranges; **a partial range is never pushed**, truncation is expressed by lowering the upper bound, and a SILENTLY truncated result is treated as suspect rather than as an answer; a **fetcher host** is the clock that decides when a cycle runs and classifies the outcome into five things, of which three are not failures. The retired word for this component is "watcher": ADR-0003 renamed it, do not bring it back.
>
> Where to look: the fetcher host package (its config resolver, its host, its loop) and the Node fetcher platform (its library entry, which is what survives, and its process entry point, which is what goes). The Node SERVER platform is the SHAPE to converge on: a library with no binary, called by the CLI. The CLI's own command registration and the shared configuration resolution are the other side.
>
> Constraints: no processor on this command, ever, because the chain-facing half holds none; no store and no database, and those flags are refused rather than ignored; nowhere to remember a block number; and the adapter must not choose a log sink, since that is a process entry point's job and the CLI is now the process.
>
> Seams to test at: the resolution (flags and environment into a host config), the refusals (pure functions), and the loop driven against a fake chain with a receiver a test supplies, which the fetcher host's and the server's existing round-trip tests already demonstrate.
>
> Done means: the command runs a real fetch loop, the binary is gone with its `bin` entry, the log sink moved, the readme is honest, both changesets exist, and the gate is green.
>
> Note for whoever integrates this, not a criterion: removing a published `bin` is free today and a breaking correction the moment the packages are published. The release task (`publish-etherfold-and-deprecate-old-names`, `humanOnly`, in the ready pool) must not run before this lands; the spec asks for this task's slug to be added to that task's `blockedBy`, and the tasker cannot make that edit.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself. Ones to expect: the flag names chosen for the endpoint and the token given the variables already have names; and whether the command re-uses the adapter's process runner wholesale or only its start function, since one of them owns the exit code.

---

### Claiming this task

```sh
dorfl claim fetch-is-the-only-way-to-run-a-fetcher --arbiter origin
git fetch origin && git switch -c work/fetch-is-the-only-way-to-run-a-fetcher origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/fetch-is-the-only-way-to-run-a-fetcher.md work/tasks/done/fetch-is-the-only-way-to-run-a-fetcher.md
```

## Resolved during tasking (no question outstanding)

The tasker's review loop found the finding below and FIXED it in this body before emitting; the `needsAnswers` stamp it left was the loop's non-convergence safety net, not an open question, and was cleared on 2026-09-03 after verifying the fix against `packages/server/src/api/ingest.ts`. Kept here because the trap it describes (a `501` that only an AUTHENTICATED caller can see) is one a builder would otherwise rediscover.

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

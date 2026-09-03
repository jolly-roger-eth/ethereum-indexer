---
title: 'The one-shot is `build`, `serve` is only the read tier, and no command is implicit'
slug: the-one-shot-is-build-and-serve-is-only-the-read-tier
spec: one-command-runs-the-whole-pipeline
blockedBy: []
covers: [4, 5, 7]
---

## What to build

The naming layer of the five-command set, over the two commands that already exist. Nothing about the pipeline changes here: the one-shot keeps every flag, every refusal and its engine, and the read tier keeps its port binding and its schema auto-setup. What changes is what they are CALLED and what they PROMISE, plus the assertions that make the promises checkable.

Three moves, all of them free today and none of them free after `publish-etherfold-and-deprecate-old-names` runs:

**1. `index` becomes `build`.** Today's default command follows the chain, folds an entity processor into a libSQL store and exits at the tip. That is this spec's `build`, named for what it PRODUCES (a database, and later a publishable artifact). The `index` NAME is needed for something else entirely, the wire receiver, which is a separate task. This is a rename of the command word plus its documentation: the `--store` decision, the `--db` requirement, the retention parsing, the module-declared processor, the stop-at-tip driver and the exit code are all already right and must come through unchanged.

**2. `serve` keeps its name and narrows its meaning to ONLY serving.** It answers queries over a database something else writes, holds no processor and receives no logs. That is already true of the code (it constructs the server with `getDB` and `getEnv` and no `getIngestion`), and it is NOT true of the documentation, some of which still describes an all-in-one under this name. So this move is documentation plus one assertion: with no ingestion injected, the ingestion routes answer `501`. Assert it as the existing seam does it. The routes are MOUNTED either way, so the difference between a read tier and a receiver is a CAPABILITY, not a route table: do not split the app to make the prose literal.

**3. There is no implicit command any more.** The one-shot is registered as commander's DEFAULT command today, so a bare `etherfold -p …` runs it. That default exists for one historical reason, recorded in the command registration's own comment (which cites ADR-0017 for the RENAME itself; the default-command argument is in the comment, not in the ADR): the rename from `ei` had already cost users the command name and should not also cost them their argument order. That reason dies here. The name is changing anyway, nothing is published, and under a set of five names chosen so that a reader can tell what a process will DO, a bare invocation that silently means one of the five is exactly the ambiguity the set exists to remove. So drop the default: a bare `etherfold` prints help, and every run names its intent.

What is deliberately NOT in scope: the unified configuration-resolution path (its own task, next), the read tier's schema auto-setup default (whether a read tier should ever apply a schema is not this spec's question, so leave the flag and its default exactly as they are), and any new command.

## Acceptance criteria

- [ ] `etherfold build -p <module> --store sqlite --db <url> …` does everything today's `etherfold index` does, with the same flags, the same refusals, the same stop-at-tip behaviour and the same exit codes (0 at the tip, non-zero on a refusal no waiting fixes).
- [ ] `etherfold index` no longer resolves to the one-shot. It is free for the receiver task; either it is unregistered here, or it exists only as an error, but it must not fold-and-exit under the old name.
- [ ] A bare `etherfold` with no subcommand prints help and exits without indexing anything; no command is registered as commander's default.
- [ ] `etherfold serve` is unchanged in behaviour and is DOCUMENTED as the read-only tier: it answers queries over a database written elsewhere, hosts no processor and writes no state.
- [ ] A test asserts the read tier refuses to write: a server started the way `serve` starts one answers `501` on the ingestion routes (with the ingestion-not-configured error), while `/status` still answers. Drive it the way the server package's existing ingest test drives it, because the summary sentence is not what an unauthenticated caller sees: the token guard is registered on the PATH (`/ingest` and `/ingest/*`) AHEAD of the capability lookup and fails closed when no token is configured, so the test configures a token and presents a matching bearer header, and `501` is the answer to an AUTHENTICATED call. An unauthenticated one answers `401` and must keep doing so: do not reorder the guard to make the prose literal, since that would tell an unauthenticated caller whether a server hosts a processor.
- [ ] Every in-repo reference to the old command word is updated in the artifacts that are LIVE documentation: the CLI readme, the root readme, the readmes of the packages and platforms that point at the CLI, the NFT example (its script command and its prose), and the CLI package's own source doc comments and test descriptions that name the command word, which are live and become false the moment it changes. The example's existing `build` script name is taken by `tsc`, so pick a script key that does not collide and keep the readme in step with it.
- [ ] `CONTEXT.md`'s command-set bullet stops describing this task's half of the set as unbuilt: the sentence saying today's CLI ships `index` (the one-shot) and `serve`, and that `build` does not exist, is corrected to what has actually landed here. The rest of the bullet (the five meanings, the two compositions, the three naming rules) is left alone, and the "not yet built" caveat stays for the three commands that still do not exist. `CONTEXT.md` is LIVE documentation and the authority every agent is told to read first, so it is the one non-readme doc this task owns.
- [ ] The read tier's `501` test names its database explicitly (in-memory, or a temp directory), so running the suite creates no stray `etherfold.db` in the repo and the adapter's convenience default is never what a test lands on.
- [ ] Historical records are NOT edited: changelogs, ADRs (including ADR-0017 and ADR-0037), already-written changeset files, and any spec or task in a terminal folder keep their wording. The glossary in `CONTEXT.md` is what a reader is meant to land on, and it already carries the new set.
- [ ] A changeset records the rename for the `etherfold` package, and says plainly that an existing `etherfold index …` invocation becomes `etherfold build …` and that a bare `etherfold …` now needs a command word.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style), and the whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- None, can start immediately.

## Prompt

> Goal: give the two shipped CLI commands their final names and their final promises, so the three commands that do not exist yet can be added without a word being reused.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? If something landed differently than this task assumes, do NOT build on the stale premise, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal"). Building on a stale task produces wrong-but-compiling work.
>
> Vocabulary and where the truth is. `CONTEXT.md` carries the whole five-name set under "What must work FIRST" and it is the authority for what each name means: `run` (follows the chain, folds, answers queries, does not terminate), `build` (the same, but exits at the tip), `fetch` (the stateless chain-facing half, pushes to a remote), `index` (the folding half, receives pushes, owns the database, exposes the write path and not the query API), `serve` (answers queries over a database written elsewhere, writes nothing). Read that bullet before you touch anything, then read the spec `work/specs/ready/one-command-runs-the-whole-pipeline.md` for why the set is named for deployment INTENT rather than for the internal component split.
>
> Where to look: the CLI package's command registration and its option-resolution module, and the Node platform adapter the read tier calls. The one-shot's engine is the two ADR-0003 halves wired in one process (a log-fetcher pushing through a direct ingestion into a stream-builder, over an entity processor and a versioned state store), landed by `index-to-a-store-from-the-cli`, whose done record in `work/tasks/done/` explains every decision inside it. You are not touching that assembly. You are renaming the command in front of it.
>
> Seams to test at: the command surface (a command word resolves or it does not, a bare invocation prints help), and the read tier's capability boundary (a server with no ingestion injected answers `501` on the ingestion routes). Both have precedents in the existing tests: the CLI package's option and refusal tests, and the Node adapter's real-HTTP `startServer` test.
>
> One warning about the rename's reach: `etherfold index` appears in changelogs, in ADRs, in already-written changeset files and in launch-snapshot specs and tasks. Those are RECORDS of what was true when they were written and they keep their wording. Only LIVE documentation moves: readmes, example scripts, and help text.
>
> Note for whoever integrates this, and NOT a criterion: this is the RENAME the spec says must land before anything is published, on the same asymmetry the publish task already respects (free today, a breaking correction to a shipped CLI the moment the packages go out). `publish-etherfold-and-deprecate-old-names` is `humanOnly`, sits in the ready pool, and both of its current blockers are already in `tasks/done/`, so nothing stops it running first. The spec asks for THIS task's slug to be added to that task's `blockedBy`; the tasker cannot make that edit, so a human must.
>
> Done means: `etherfold build` is the one-shot, `etherfold serve` is documented and asserted as a read tier that refuses to write, a bare `etherfold` prints help, the live docs and the example agree, a changeset records it, and the acceptance gate is green.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself, and do not open a notes file for a decision you made. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off, see `ADR-FORMAT.md`), also write the durable why as an ADR in `docs/adr/` and name it in the block.

---

### Claiming this task

```sh
# atomically claim it (works with a GitHub remote OR a local --bare remote):
dorfl claim the-one-shot-is-build-and-serve-is-only-the-read-tier --arbiter origin
# then start work on the updated main:
git fetch origin && git switch -c work/the-one-shot-is-build-and-serve-is-only-the-read-tier origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-one-shot-is-build-and-serve-is-only-the-read-tier.md work/tasks/done/the-one-shot-is-build-and-serve-is-only-the-read-tier.md
```

## Resolved during tasking (no question outstanding)

The tasker's review loop found the finding below and FIXED it in this body before emitting; the `needsAnswers` stamp it left was the loop's non-convergence safety net, not an open question, and was cleared on 2026-09-03 after verifying the fix against `packages/server/src/api/ingest.ts`. Kept here because the trap it describes (a `501` that only an AUTHENTICATED caller can see) is one a builder would otherwise rediscover.

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

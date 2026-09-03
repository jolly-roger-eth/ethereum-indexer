---
title: 'The Node server starts on a database handle it was given, and carries an ingestion and a cursor reporter through'
slug: the-node-server-starts-on-a-handle-it-was-given
spec: one-command-runs-the-whole-pipeline
blockedBy: [status-reports-the-cursor-through-an-injected-reporter]
covers: []
---

## What to build

The second of the spec's two named exceptions to "`run` is assembly, not new machinery". Everything else the all-in-one needs already ships; this does not.

**One handle, two users.** The Node platform adapter takes its database as a libSQL URL string and builds the handle itself. The combined commands need the opposite: the command builds ONE handle, gives it to the versioned state store the processor folds into, and hands the SAME handle to the server as its database. Two handles onto one URL would be two connections with two views of an in-memory database and two schema-setup races, and it would make the single-process claim false at exactly the place it is most load-bearing.

So the adapter gains the ability to start on an EXISTING handle as an alternative to a URL. Extend the adapter rather than re-implementing it in the CLI: it already owns the port binding, the address readback for a port asked for as zero, the schema auto-setup and the shutdown, and it already exports its handle-building helper for precisely this kind of sharing. A CLI that re-implemented that would be a second server host, and the rule that a runtime is named in exactly one place (ADR-0003 for `platforms/*`) is what keeps the server package host-agnostic.

**And it carries the HOST-SUPPLIED CAPABILITIES through: the ingestion and the cursor reporter.** Both are injected into the app by whoever knows how to build them, and on Node that is a process reaching the app through this adapter. Today the adapter passes only the database and the environment: it constructs the app with `getDB` and `getEnv` and nothing else, so a server it starts can host no processor at all and its ingestion routes always answer `501`. That is fine for the read tier and fatal for the receiver, so the passthrough is delivered HERE, in the one file that already owns this options type, rather than being discovered later by the command that needs it.

So the adapter accepts an optional ingestion capability and an optional cursor reporter and hands both to the app unchanged. It builds neither, it does not know what a cursor means, and it does not know what a processor is: what it decides is what the app's database, environment, ingestion and reporter ARE, and nothing else. The absence of either stays exactly what the server package already makes it (a missing capability, not an error), so a read tier started with neither behaves as it does today.

The URL form must keep working unchanged, because the read tier uses it and so do the adapter's own tests.

## Acceptance criteria

- [ ] The adapter's start options accept an existing database HANDLE as an alternative to a libSQL URL, and passing a URL behaves exactly as it does today (same defaulting, same schema auto-setup, same returned handle, same shutdown).
- [ ] Started on a given handle, the server shares it: a write made through that handle outside the server is visible to a read the server answers, demonstrated against an in-memory database where a second connection would NOT see it.
- [ ] Schema auto-setup works on both forms, and the opt-out still opts out on both.
- [ ] The adapter accepts an optional cursor reporter and passes it to the app unchanged, so a server it starts reports a cursor on `/status` when one is supplied and none when it is not.
- [ ] The adapter accepts an optional INGESTION capability and passes it to the app unchanged, so a server it starts can host a processor: with one supplied the ingestion routes work, with none supplied they answer `501` exactly as they do today. It builds no processor and imports no store package to do it.
- [ ] Both directions of that assertion are driven through the ingest route's OWN contract rather than the summary sentence above: the token guard sits on the path (`/ingest` and `/ingest/*`) ahead of the capability lookup and fails closed when no token is configured, so the test configures `INGEST_TOKEN` through the adapter's environment option and presents a matching bearer header. An unauthenticated call answers `401` and must keep answering `401`: the guard is NOT reordered to make `501` reachable without a token.
- [ ] The adapter still names no store package and no chain concept: it decides what the app's database, environment, ingestion and reporter are, and nothing else.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style, real HTTP against a started server as the neighbouring tests do): the handle form, the shared-handle visibility, the reporter passthrough, the ingestion passthrough in both directions (supplied and absent), and the unchanged URL form.
- [ ] A changeset records the new options on the Node platform package (the handle form, the reporter, the ingestion).
- [ ] The whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- `status-reports-the-cursor-through-an-injected-reporter`, which defines the reporter this adapter passes through.

## Prompt

> Goal: let one process own a database handle and give the SAME handle to both a state store and the HTTP server, and let that process hand the server the two capabilities only a host can build (an ingestion and a cursor reporter), without re-implementing the Node server host inside the CLI.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? If a dependency landed differently than this task assumes, do NOT build on the stale premise, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Where to look: the Node platform adapter, which is small and is the whole of the change (it builds the handle, applies the schema, binds the port, reads the bound port back, composes the app and returns a closeable handle). Read its doc comment first: it says what an adapter is allowed to be. The server package's options type is the other half: the ingestion option there has shipped for a while and NO host passes it yet (the Workers host deliberately hosts no processor, and this adapter simply never offered it), and the cursor reporter option is the one the task before this adds. Both travel the same way, so add them together.
>
> Vocabulary: the storage abstraction the whole system is written against is a **remote SQL** handle, and the adapter's exported helper builds one from a libSQL URL. A **libSQL** URL may be a file, an in-memory database, or a remote (which is how a read tier reaches a database the writer also uses, with no SQL-over-HTTP surface anywhere).
>
> The test that matters most: an in-memory database, because that is the case where the difference between one handle and two is OBSERVABLE. Two connections to an in-memory libSQL do not share state, so a shared-handle assertion against it cannot pass by accident.
>
> Note for a drift check, so you do not go looking for a conflict that no longer exists: the spec warns of a file overlap here with `d1-limits-reach-the-stores-batch-bounds`. That task has since LANDED, and it landed in the WORKERS adapter (a host stating its own backend's limits), not in this one, so there is no concurrent work and no leftover behaviour of its to preserve in the file you are changing.
>
> One thing to read before you write the ingestion test: the ingest route guards `/ingest` and `/ingest/*` with a token check registered on the PATH, ahead of the capability lookup, and that check fails CLOSED when no token is configured. So `501` is what an AUTHENTICATED caller gets from a server with no ingestion; an unauthenticated one gets `401`. Configure the token through the adapter's environment option and present a bearer header, the way the server package's own ingest test does. Moving the guard so the sentence reads literally would leak whether a server hosts a processor, and is not on the table.
>
> Done means: both start forms work, the shared handle is proven against an in-memory database, the reporter and the ingestion both reach the app, a changeset records it, and the gate is green.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself. Worth recording: how the two forms are expressed in one option type, how an ingestion is expressed for a host that resolves its database per request, and who owns CLOSING a handle the caller supplied (a server that closed a handle it did not build would take a store's connection down with it).

---

### Claiming this task

```sh
dorfl claim the-node-server-starts-on-a-handle-it-was-given --arbiter origin
git fetch origin && git switch -c work/the-node-server-starts-on-a-handle-it-was-given origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/the-node-server-starts-on-a-handle-it-was-given.md work/tasks/done/the-node-server-starts-on-a-handle-it-was-given.md
```

## Resolved during tasking (no question outstanding)

The tasker's review loop found the finding below and FIXED it in this body before emitting; the `needsAnswers` stamp it left was the loop's non-convergence safety net, not an open question, and was cleared on 2026-09-03 after verifying the fix against `packages/server/src/api/ingest.ts`. Kept here because the trap it describes (a `501` that only an AUTHENTICATED caller can see) is one a builder would otherwise rediscover.

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

---
title: '`/status` reports the cursor, through a reporter injected beside the database'
slug: status-reports-the-cursor-through-an-injected-reporter
spec: one-command-runs-the-whole-pipeline
blockedBy: []
covers: [6]
---

## What to build

The one piece of genuinely NEW surface in this spec. `/status` is the whole query surface for this milestone, and it is one field short: it reports health, the reorg counters, the schema version and the last error, and it does NOT report the cursor. The cursor is the field that makes a running pipeline OBSERVABLE without a query layer existing, and it is the number an operator actually watches.

**How it must arrive, and why not the obvious way.** The server package must NOT learn to read a cursor table. It has no store dependency at all (it knows one storage abstraction and nothing else), and the cursor is an OPAQUE STRING behind the storage seam per ADR-0027: only the processor knows what a cursor means, and a server that parsed one would have taken on both a dependency and a meaning that are not its. So the cursor arrives the way everything host-shaped already arrives, as an injected reporter beside the database and the environment and the ingestion: supplied by the process that OWNS the store, ABSENT on a host that has none, and reported VERBATIM rather than interpreted.

Follow the ingestion injection exactly: optional in the type, and its absence is a capability that is missing rather than an error. A host with no store (the Workers host is one, it constructs the app with a database binding and an environment and nothing else) supplies no reporter and its `/status` simply has no cursor to report. A host that owns a store hands over a function; whatever that function returns is what `/status` shows.

**Shape the field so it can grow a generation dimension, because that work is coming.** An indexer now holds several GENERATIONS and reports progress per generation (landed by `a-reconfigure-is-not-an-outage`). The SERVER does not hold generations yet, and giving it them is a different spec (`the-server-and-cli-hold-generations-too`), so report ONE cursor now. But do not hard-code a scalar that the generation work would have to break: the reported field is an OBJECT, never a bare string or number, so a later host can report several by adding a dimension inside it rather than by changing the field's type.

**Reported verbatim is a contract on the SERVER, not a licence for the host.** The server does not parse what it is handed, so the option's own documentation is the only place the size of that value can be constrained: state there that a reporter returns a SMALL, JSON-serialisable summary of where the pipeline has got to, and never the store's raw serialized cursor. That is not a detail. The entity processor's cursor is a serialized structure carrying an unconfirmed window of DECODED EVENTS, so a host that handed it over whole would put an unbounded blob on the one page an operator refreshes while something is wrong. The server cannot defend against that after the fact, which is exactly why the constraint belongs on the seam rather than in the head of whichever command builds a reporter next.

**A reporter must not be able to take `/status` down.** `/status` is the page an operator watches when something is wrong, so a reporter that throws, or a store that cannot be read, degrades to a cursor that is absent-with-a-reason and does not flip `healthy` and does not fail the request. The reorg counters already establish that pattern in this route.

Nothing in this task wires a real store to a real server. The processes that own a store are the CLI's commands, and they arrive in later tasks. What this task delivers is the seam plus the field, testable on its own with a reporter a test supplies.

## Acceptance criteria

- [ ] The server's options gain an OPTIONAL cursor reporter, injected exactly like the ingestion is: same shape of option, same optionality, same reason recorded in its doc comment.
- [ ] With a reporter injected, `/status` reports the cursor as an OBJECT carrying whatever the reporter returned, unparsed and uninterpreted by the server.
- [ ] With no reporter injected, `/status` answers exactly as it does today with no cursor field invented and no error, and every existing status assertion still passes.
- [ ] The server package still has no dependency on any store package, and no code in it reads a cursor table or decodes a cursor.
- [ ] A reporter that throws, or that reports it cannot read, yields a cursor that is absent or absent-with-a-reason: the request still answers, and `healthy` is unchanged by it.
- [ ] The Workers host, which owns no store, still builds and serves with no cursor field, so the absent case is exercised by a real host and not only by a test double.
- [ ] The option's documentation states what a reporter owes the server: a small, JSON-serialisable summary, never the store's raw serialized cursor (which carries an unconfirmed window of decoded events), because the server reports it verbatim and cannot bound it.
- [ ] The field is documented where the query surface is documented, saying plainly that it is the whole observability story for now and that a richer query layer is deliberately not in this milestone.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style): present, absent, throwing, and one assertion that the reported value is passed through verbatim.
- [ ] A changeset records the new option and the new field on the server package.
- [ ] The whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- None, can start immediately. Deliberately file-orthogonal to the CLI tasks in this spec, so it can run in parallel with them.

## Prompt

> Goal: make a running deployment observable by adding the ONE field `/status` is missing, without giving the server a store dependency or a cursor's meaning.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? If something landed differently than this task assumes, do NOT build on the stale premise, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Where to look: the server package's status route and its options type, and the ingestion option beside it, which is the PRECEDENT to imitate in every respect (optional in the type, absent means the capability is missing, injected by the host because only a host knows what to build). Also read the Workers platform adapter, which is the host that supplies no store and therefore no reporter.
>
> Vocabulary: the **sync cursor** is an OPAQUE STRING the store keeps under one key, written in the same transaction as the block it describes; only the processor knows what it means (ADR-0027, and the entity processor's cursor module is the codec). A **generation** is one stream plus one processor plus one state, and an indexer now holds several and reports progress per generation. **Reported verbatim** means the server places what the reporter returned into the response and does not parse it, so the meaning stays behind the seam.
>
> Constraints: do not add a store dependency to the server package; do not read a cursor table from the server; do not make the field a bare scalar (the generation dimension is coming and it must be able to grow INSIDE the field); do not let a failing reporter fail the route or change `healthy`, and follow how the reorg counters already degrade in that same route. Note for a drift check: the word "cursor" already appears in the ingestion route's comments, explaining that the cursor is the idempotency key. That is not the field, do not read those comments as evidence the field exists.
>
> Seams to test at: the route, through the app, with a reporter a test supplies (the server package's existing tests show both the in-process request style and the real-HTTP style; either is fine, match what the neighbouring test does).
>
> Done means: the option exists and is documented, the field appears when a reporter is injected and is absent when one is not, a failing reporter is harmless, the Workers host still builds, a changeset records it, and the gate is green.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself. The decision to record above all: the exact SHAPE of the reported field and how a generation dimension would grow inside it later. If that shape is hard to reverse once a client reads it (it is a published response body), it meets the ADR gate, so also write the durable why as an ADR in `docs/adr/` and name it in the block.

---

### Claiming this task

```sh
dorfl claim status-reports-the-cursor-through-an-injected-reporter --arbiter origin
git fetch origin && git switch -c work/status-reports-the-cursor-through-an-injected-reporter origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/status-reports-the-cursor-through-an-injected-reporter.md work/tasks/done/status-reports-the-cursor-through-an-injected-reporter.md
```

## Resolved during tasking (no question outstanding)

The tasker's review loop found the finding below and FIXED it in this body before emitting; the `needsAnswers` stamp it left was the loop's non-convergence safety net, not an open question, and was cleared on 2026-09-03 after verifying the fix against `packages/server/src/api/ingest.ts`. Kept here because the trap it describes (a `501` that only an AUTHENTICATED caller can see) is one a builder would otherwise rediscover.

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

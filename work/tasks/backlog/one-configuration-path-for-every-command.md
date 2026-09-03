---
title: 'Every command resolves its processor, source and destination the same way: flags first, environment behind them'
slug: one-configuration-path-for-every-command
spec: one-command-runs-the-whole-pipeline
blockedBy: [the-one-shot-is-build-and-serve-is-only-the-read-tier]
covers: []
needsAnswers: true
---

## What to build

ONE configuration-resolution path, shared by all five commands, so that moving between them is a deployment change and never a rewrite. This is the spec's named deliverable that has no user story of its own, and it is work rather than a property: today the three entry points genuinely disagree.

- The fetcher host resolves everything from the ENVIRONMENT: the indexing source as a JSON variable, the node URL, the ingest endpoint and the ingest token, with a resolver that refuses by NAME when one is missing.
- The CLI resolves from FLAGS plus a processor module: the processor path, the deployments folder, the node URL, and a store target validated by its own resolver rather than by the argument parser.
- The Node server adapter reads two variables of its own for the database and the port.

The rule to land: **flags first, environment behind them, ONE set of variable names, and a refusal that names both.** The variable names are the fetcher host's, because it already refuses by name and those names are the published contract of a deployable: the indexing source, the node URL, the ingest endpoint and the ingest token, plus the database and port names the Node adapter already reads. The CLI's own second name for the node URL is retired here (nothing is published, so it costs a readme line today and a breaking correction after publishing).

**No command silently degrades, and that is the load-bearing half of this task.** A missing node URL, a missing database, an absent processor or an unresolvable source is a REFUSAL that names the flag AND the variable behind it, not a process that starts and does nothing. In particular the CLI always passes an explicit database to the server adapter, so the adapter's own convenience default is never what a command runs on: a `serve` that quietly created an empty database file nobody named is the failure this rule exists to prevent. Keep requiredness OUT of the argument parser and IN the resolver, the way the store target already works, because the refusals are the interesting part of the contract and they should be testable functions rather than parser configuration.

**Build the resolution for all five commands even though only two exist yet.** Three commands arrive in later tasks and they must consume this rather than extend it. What each one needs:

| command | processor | source | node URL | destination | serving | ingest wire |
| --- | --- | --- | --- | --- | --- | --- |
| `run` | required | required | required | store + database, required | port and host | none |
| `build` | required | required | required | store + database, required | none | none |
| `fetch` | **NOT ACCEPTED** | required | required | **NOT ACCEPTED** | none | endpoint + token, required |
| `index` | required | required, **without a chain call** | **NOT ACCEPTED** | store + database, required | port and host | token (it receives) |
| `serve` | **NOT ACCEPTED** | none | **NOT ACCEPTED** | database, required | port and host | none |

Two asymmetries in that table are decisions rather than accidents, and both must survive:

- **`fetch` takes a SOURCE but no processor**, because the chain-facing half holds no processor by ADR-0003, and it owns no database, so the store and database inputs are REFUSED there rather than optional. A required store flag inherited by the one command that has no state would land the failure on the command that should need nothing but a node URL, a source and an ingest endpoint.
- **`index` resolves its source without touching the chain.** It is the receiving half and makes no chain call at all. Today's source resolution asks the node for its chain id when the module keys its contracts per chain, so that path is unavailable to a chain-free command: the source must come from an explicitly given one (the deployments folder, or the source variable), and a module that can only be resolved by asking a node is a refusal naming both explicit forms. Shape the resolver so a chain-free caller is a first-class case, not a special case bolted on later.

Adopt it in `build` and `serve` now, since they are the commands that exist. Leave the shape ready for the other three.

## Acceptance criteria

- [ ] One resolution module owns the whole flag-and-environment resolution for the CLI, and both existing commands go through it.
- [ ] A flag always beats the environment; the environment is used when the flag is absent; neither present is a refusal.
- [ ] Every refusal message names the flag AND the environment variable that would have satisfied it, and refuses BEFORE anything touches the chain or opens a database.
- [ ] The variable names are one set, the fetcher host's plus the Node adapter's, with no second name for the same input anywhere in the CLI. The CLI's retired node-URL variable is gone from the code and from the readme.
- [ ] No command runs on an unnamed database: the database input is resolved by the CLI and passed explicitly to the server adapter, so the adapter's default is never reached from a command.
- [ ] The resolver expresses the two asymmetries: inputs a command does not own are REFUSED with a message saying why (a fetcher holds no state, a read tier holds no processor), never accepted and ignored.
- [ ] A source can be resolved with NO chain call from an explicitly given source, and a module that needs a chain call to resolve is refused when the caller cannot make one, naming the explicit alternatives.
- [ ] Tests cover the new behaviour (mirror the repo's existing test style): flag-beats-environment, environment-behind-flag, each refusal by name, and the refused-input cases.
- [ ] A changeset records the configuration surface for the `etherfold` package, including the retired variable name.
- [ ] The whole acceptance gate is green: format, build, typecheck, tests.

## Blocked by

- `the-one-shot-is-build-and-serve-is-only-the-read-tier`, which gives the commands their final names and touches the same command-registration and option-resolution modules. Serialized deliberately: these two tasks edit the same files.

## Prompt

> Goal: make "moving between commands is a deployment change, never a rewrite" true of the CODE, by giving all five commands one configuration-resolution path with one set of names and refusals that name what is missing.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, `tasks/done/`, and the relevant ADRs? If a dependency landed differently than this task assumes, do NOT build on the stale premise, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").
>
> Read first: `work/specs/ready/one-command-runs-the-whole-pipeline.md`, the paragraph beginning "Every command resolves its processor and source THE SAME WAY", and `CONTEXT.md`'s command-set bullet for what each of the five names means. Then read the three resolution paths as they are: the fetcher-host package's config module (environment-driven, refuses by name, and note that it accepts overrides so a caller can hand it a source and a node URL it did not read from the environment), the CLI's own option resolution (flag-driven, with its store-target refusals as the model to imitate), and the Node platform adapter's two variables.
>
> Vocabulary: an **indexing source** is what tells a deployment which chain and which contracts to read; the **store target** is where folded state goes; a **fetcher host** decides when a fetch cycle runs; the **ingest endpoint** and **ingest token** are the split deployment's wire and its shared secret; the token is the same name on both sides, since the receiving server authenticates with it and fails closed without it.
>
> Design constraints that are not negotiable: flags first and environment behind them; ONE name per input; requiredness lives in the resolver and not in the argument parser, so every refusal is a testable function; a refusal names the flag and the variable; no input is accepted and ignored, because an accepted-and-ignored flag is a deployment believing something untrue; and a chain-free caller must be able to resolve a source, because one of the five commands makes no chain call at all.
>
> Seams to test at: the resolver itself (pure functions over an options object plus an environment record, which is how the existing store-target refusals are tested), and one end-to-end pass per existing command showing the resolved values actually reach the pipeline.
>
> Done means: both existing commands run entirely off the shared resolution, the refusals are tested by name, the retired variable name is gone, a changeset records the surface, and the gate is green. Three commands that do not exist yet must be able to CONSUME this without extending it; if you find yourself unable to express one of the five rows in the task's table, that is a design smell worth fixing now rather than a later command's problem.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. That block is the ONE sanctioned channel for build-time rationale, and the runner transcribes it verbatim into the done record. Do NOT write the done record, the commit message or the PR body yourself. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off, see `ADR-FORMAT.md`), also write the durable why as an ADR in `docs/adr/` and name it in the block. The one to watch for: whether a resolved input may fall back to a DEFAULT at all, and for which inputs, is exactly the kind of choice a reviewer will otherwise have to reverse-engineer.

---

### Claiming this task

```sh
dorfl claim one-configuration-path-for-every-command --arbiter origin
git fetch origin && git switch -c work/one-configuration-path-for-every-command origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/one-configuration-path-for-every-command.md work/tasks/done/one-configuration-path-for-every-command.md
```

## Open questions

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

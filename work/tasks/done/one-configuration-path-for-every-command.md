---
title: 'Every command resolves its processor, source and destination the same way: flags first, environment behind them'
slug: one-configuration-path-for-every-command
spec: one-command-runs-the-whole-pipeline
blockedBy: [the-one-shot-is-build-and-serve-is-only-the-read-tier]
covers: []
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

## Resolved during tasking (no question outstanding)

The tasker's review loop found the finding below and FIXED it in this body before emitting; the `needsAnswers` stamp it left was the loop's non-convergence safety net, not an open question, and was cleared on 2026-09-03 after verifying the fix against `packages/server/src/api/ingest.ts`. Kept here because the trap it describes (a `501` that only an AUTHENTICATED caller can see) is one a builder would otherwise rediscover.

- Three tasks require a test asserting that a processor-less server answers 501 on the ingestion routes, but that is not what the code does for an unauthenticated caller: getIngestAPI registers the token guard on the PATH (both /ingest and /ingest/*) BEFORE the getIngestion lookup, and authorized() fails CLOSED when INGEST_TOKEN is unset. So a serve/run/no-ingestion server answers 401, and 501 is reachable only by an AUTHENTICATED call. A test written to the literal criterion fails, and the tempting repair (move the capability check ahead of the guard) would let an unauthenticated caller probe whether a server hosts a processor, undoing the path-level guard the route comment says exists for exactly that reason. Fixed in the edits: each criterion now says configure the token, present a matching bearer header, assert 501 (the shape packages/server/test/ingest.test.ts:349 already uses), and states that the guard is not reordered. (packages/server/src/api/ingest.ts:106-118 (guard) vs 141/151 + notConfigured() at 199-204; affects run-follows (ingestion routes answer 501 on a run process), the-node-server (with none supplied they answer 501 exactly as they do today) and the-one-shot (a server started the way serve starts one answers 501))

## Decisions

**1. The command table is ONE table, and it drives BOTH the parser and the resolver.** `OWNERSHIP` in `src/config.ts` is the only place the task's five-row table is written down; `registerInputs` reads it to register flags and `resolveCommandConfig` reads it to refuse. Alternative considered: register flags by hand per command and keep the table as documentation, which is what the CLI did before and is how the parser and the resolver came to disagree about requiredness in the first place. **Touches**: all three unbuilt commands — adding `run` / `fetch` / `index` is `program.command(...)` plus `registerInputs(cmd, name)` plus an assembly, with no new way to read a flag.

**2. A flag a command does not own is REGISTERED HIDDEN so it parses and reaches the resolver.** The criterion is that a not-accepted input is "REFUSED with a message saying why, never accepted and ignored", and commander's `unknown option` names neither a reason nor the command that does own it. So `etherfold serve -p ./processor.js` now says a read tier holds no processor and points at `index` / `run` / `build`, and `--help` still shows only what the command owns. Alternatives considered: leave them unregistered (the resolver refusal then only fires for programmatic callers, so the message is hollow at the terminal), or refuse them visibly in `--help` (which advertises flags that always fail). **Touches**: it changed an existing assertion — `commands.test.ts` asserted `serve -p` was `/unknown option/i` — and it is the mechanism all three future commands inherit.

**3. Which inputs get an environment variable at all: exactly the seven a deployable already publishes.** `INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND` (the fetcher host's) plus `DB`, `PORT` (the Node adapter's). `-p`, `--store`, `--retention`, `-d`, `--host`, `--no-auto-setup` are flags only, and their refusals say so rather than naming a variable that does not exist. The line: **the environment carries what varies between deployments of one image; a flag carries what the image IS.** Alternative considered: invent `PROCESSOR` / `STORE` so every refusal could name a variable literally — rejected as a second way to say what a container's `CMD` already says, and as six new names against the "one set" rule. Recorded in ADR-0048. **Touches**: every future command's refusal messages.

**4. Only the PORT may fall back to a default (2000). Nothing else does.** This is the one the prompt flagged. A port is not a claim about the deployment (a wrong one fails visibly, at once, writing nothing); a defaulted database or node URL fails silently, which is the whole reason `--db` was never defaulted. The asymmetry that settles it: adding a default later is free, removing one is breaking. Retention keeps its `unbounded` default because that is the store's own default and changes nothing about a store nobody configured; `autoSetup` keeps `true` because the task put the read tier's schema default explicitly out of scope. Recorded as **ADR-0048** (`docs/adr/0048-a-command-inputs-name-and-whether-it-may-default.md`). **Touches**: `run` and `index`, which serve, and any later argument for defaulting a database.

**5. `--port` lost its commander default, and that is a rule rather than a fix.** It was `'2000'` at the parser, so the flag was *always* present and `PORT` could never be reached — a commander default silently defeats "flags first, environment behind them". The rule is now stated where flags are registered: no `requiredOption` and no commander default, ever. **Touches**: `commands.test.ts` (which asserted `port: '2000'` reached the handler) and every future serving command.

**6. Refused = a FLAG a user typed; an ambient VARIABLE a command does not own is simply not read.** `ETH_NODE_URI` set on a host that runs `fetch` beside `index` is ordinary, and refusing `index` because the machine has a node URL would make the split deployment this system exists for unconfigurable. Alternative considered: refuse on the variable too, which is more literally "nothing is accepted and ignored" but breaks the one-host-several-commands case the wire exists to enable. **Touches**: `run`/`fetch`/`index` on a shared host; asserted by a test.

**7. `--ingest-token` is offered as a flag, with the hazard documented.** "Flags first, environment behind them" is a stated non-negotiable and the refusal has to name both, so an environment-only token would have been the one input off the path. But a secret on a command line is visible in `ps` to every process on the host, so the help text and the readme both say to prefer `INGEST_TOKEN`. The refusal never quotes a value, only the name — the same rule `FetcherConfigError` already follows (asserted by a test). Alternative considered: env-only, which is safer and inconsistent. **Touches**: `fetch` and `index`, which are the two commands that will consume it.

**8. The destination is ONE field with two arms (`Destination` = `StoreTarget | DatabaseTarget`), both carrying `db`.** The database is one input (`--db`, `DB`) whatever a command does with it; what differs is whether the command also owns a STORE — which is precisely the difference the task's table draws between "store + database" and "database". `StoreTarget` therefore gained a `kind` discriminant and kept its meaning. Alternative considered: `target?: StoreTarget` for writers plus a separate `database?: string` for `serve`, which puts two names on one input in the resolved shape — the exact muddle this task exists to remove. **Touches**: `run` and `index` (store arm), any later read-only command (database arm).

**9. `prepareIndexing` takes the command name first: `prepareIndexing('build', options, deps)`.** It is typed `'run' | 'build'` — `index` folds too but makes no chain call, so it builds no provider and no `LogFetcher` and will assemble differently while resolving through the same function. Alternative considered: have it take an already-resolved config, which is a cleaner seam but pushes resolution boilerplate into six test call sites and the example, for no assertion gain. It is a public API break; the changeset says so. **Touches**: `examples/event-processor-nfts/test/cli.test.ts` (updated) and `run`, which will pass `'run'`.

**10. `--rps` is parsed to a number in the resolver, and a value that is not a rate is refused.** This closes `work/notes/observations/cli-rps-is-typed-as-a-number-and-arrives-as-a-string.md`. I judged it inside rather than outside the fence: the resolver is the thing this task builds, `rps` is one of its outputs, and shipping the new shared path with a known-false type in it would be building the deliverable with a hole. It introduces one new refusal, which is why it is here rather than silent. **Touches**: nothing outside the CLI; `REQUESTS_PER_SECOND` is the fetcher host's existing name, reached here now instead of two layers down.

**11. `cli.ts` catches and prints the message rather than an unhandled rejection.** `serve` had no refusals before, so its first one arrived as a raw stack dump through commander's un-awaited async action. Configuration refusals are written to be read, so the entry point prints `err.message` and exits 1. `main`'s existing `console.error(err)` for `build` is untouched — a fatal indexing error is a different class and its stack is wanted. **Touches**: the presentation of every future command's refusals; a later task wanting uniform presentation would need an error class, which I did not introduce.

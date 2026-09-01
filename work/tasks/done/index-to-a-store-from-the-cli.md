---
title: '`etherfold index` runs an entity processor into a store, so the same processor a tab runs also runs on a server'
slug: index-to-a-store-from-the-cli
spec: one-processor-everywhere
blockedBy: []
covers: [1, 12]
---

## What to build

The server half of the spec's headline. `index-in-the-browser-with-a-chosen-backend` made "an application developer writes one processor and indexes in a tab" real and demonstrable; this makes the other half of the same sentence real: **the same processor object, unchanged, indexing on a server into SQLite.**

Today it cannot. `etherfold index` refuses an entity processor outright, in `packages/cli/src/index.ts`:

```ts
if (!(processor as any).keepState) {
	throw new Error(`this processor do not support "keepState" config`);
}
(processor as unknown as ProcessorWithKeepState<ABI>).keepState(createFileKeepState<ABI>(options.folder));
```

An `EntityEventProcessor` has no `keepState` method and never will — its state and its cursor live in a `StateStore` (ADR-0027) — so the default command rejects exactly the processors the spec exists to make portable. The CLI's whole persistence story is `createFileKeepState`, which is the free-form blob model.

**`etherfold serve` is not this.** It has `--db <url>` but it starts the indexer-SERVER over HTTP (the ADR-0003 receiving side, whose ingestion half is `ingest-wire-receiving-side`). It is a different deployable answering a different question, and its `--db` flag is not the one this task adds.

**And note what `one-processor-cli-and-split-server` did and did not do.** It proved with a TEST that one processor and one set of declarations produce the same state under the single-process path and the split path. That is real and it stays. It is not a shipped path a user can run: the test constructs the pieces directly. So story 12 is currently demonstrated in a test file and unreachable from a terminal, which is the same shape of gap `index-in-the-browser-with-a-chosen-backend` closed for the browser.

### The ENGINE is the two ADR-0003 halves, wired together in one process

**This is the part that was re-decided, so read it before anything else.** An earlier draft of this task built the entity path on `EthereumIndexer`, the class the CLI drives today through `init()` and `indexToTip`. It does not. The CLI folds through the SAME two components a split deployment uses, with the transport removed:

```
LogFetcher  ->  createDirectIngestion(streamBuilder)  ->  StreamBuilder  ->  EntityEventProcessor  ->  VersionedStateStore
```

Every piece exists and none of them is new work: `new LogFetcher(provider, source, target, {stream, fetch})`, `createDirectIngestion(ingestion): IngestionTarget` (both `@etherfold/core`), `new StreamBuilder(processor, source, {stream})` (which IS the `LogIngestion` the direct wire receives into), `new EntityEventProcessor(store, processor)` and `new VersionedStateStore(remoteSQL, declarations, {retention, finalityDepth})`. `createNodeDB(url)` in `@etherfold/platform-nodejs` builds the `RemoteSQL` from a libSQL url and is exported for exactly this kind of sharing.

Why this and not the class that is already there, since the outcome for a user is identical:

- **There is one server-side folding engine, or there are two.** `one-command-runs-the-whole-pipeline` builds `run` (fetch, fold and serve in one process) and `index` (the receiving half of a split) on `StreamBuilder`, and asserts that they produce identical state from the same input. If the CLI's one-shot folded through `EthereumIndexer` instead, that assertion would be comparing two IMPLEMENTATIONS that happen to agree today, and every later divergence between them would surface as a mysteriously failing equivalence test rather than as a bug in one place.
- **`EthereumIndexer` cannot be split into the two halves at all.** It opens `load()` with `eth_chainId`, which is precisely why the chain-free `StreamBuilder` exists as a separate object. A CLI built on it can never demonstrate "the split is a deployment choice", because the thing it runs has no halves.
- **The fetch cycle brings machinery the CLI's retry loop does not have**: announced AND silent truncation detection (`suspectResultCount`, the failure mode that once deleted state), the `expectedFromBlock` correction protocol, backoff, and the classification of a cycle into progress / idle / contended / retry / fatal.
- **Nothing chain-side is lost.** `LogFetcher` owns the `eth_chainId` check in a split deployment already.
- What `EthereumIndexer` has and a server does not want is the kept-stream CACHE, which is a browser concern. Here the database IS the durable artifact.

`EthereumIndexer` is untouched by this task and remains the browser's engine.

**Driving it to the tip, and stopping there.** `runFetcherLoop(host, {signal, onReport})` in `@etherfold/fetcher-host` runs cycles back to back and settles into a poll interval at the tip; it has no stop-at-tip option and should not grow one here. A one-shot is that loop plus an `AbortController`: abort from `onReport` on the first report that says the work is done (`progress` with `caughtUp`, or `idle`). A `fatal` report ends the loop on its own and must exit non-zero. That is the same driver `build` will use, which is the point.

**The command NAME is not this task's to change.** `work/specs/ready/one-command-runs-the-whole-pipeline.md` renames the command set (this one-shot becomes `build`, and `index` is re-meant as the receiving half of a split), and its tasks are `blockedBy` THIS one. So build it under `etherfold index` as it stands, and do not pre-empt the rename.

**This task OWNS the one-shot's exit behaviour, and the spec's story 5 is DELIVERED BY IT under the new name.** Say so here because the spec's story cut lists story 5 as a vertical task of its own, which would emit a second implementation of what the acceptance criteria below already require. What that spec still owes on top of this task is the RENAME to `build` plus its README; the terminate-at-the-tip driver and the exit code are this task's, once.

### The rest of the shape, which is unchanged and decided

**`--store` is REQUIRED, and it names where the state goes.** Not inferred, not defaulted:

```sh
etherfold index -p ./processor.js --store file   --folder ./state          # free-form, unchanged
etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db  # entity path
```

The reason it is mandatory rather than defaulted is that this is the one decision the CLI genuinely owns, and the two answers are not interchangeable: one keeps a blob with no history, the other keeps versioned rows that answer as-of reads and survive a reorg. A default would make the difference invisible at exactly the moment a deployment is choosing it. (`--db` mirrors `serve`'s existing flag and takes a libSQL url.)

**The processor KIND is not a flag.** It comes from the module, the same way it comes from the caller in the browser: `createIndexerState` takes `{kind: 'entities', processor}` or a bare processor meaning `'js-object'` (`packages/browser/src/IndexerState.ts`). The CLI reads the same vocabulary off the module's export, and an untagged `createProcessor` keeps meaning `'js-object'`, so every shipped module keeps working untouched.

Putting the kind on the command line as well would be a SECOND source of truth for one fact, and two answers that can disagree is precisely what the browser's tag exists to prevent. So `--store` says where the state goes, the module says what kind of processor it is, and **a mismatch is a loud refusal** naming both — a `'js-object'` processor with `--store sqlite`, or an `'entities'` processor with `--store file`, fails at startup with a message saying which it got and which it needed, before any RPC call is made.

Where exactly the tag lives on the module is yours to design (a tagged `createProcessor` return, a separate named export, or a discriminated module shape). `instantiateProcessor` in `@etherfold/utils` is what resolves it today and is the natural place. Say what you chose and why.

**Both store arms run on the SAME engine.** `--store file` keeps a `JSObjectEventProcessor` with its `keepState` keeper, and `--store sqlite` builds an `EntityEventProcessor` over a `VersionedStateStore`; what changes between them is the processor and where its state lives, not how logs reach it. `StreamBuilder` takes an `EventProcessor`, which both of them are, so the fetch-and-fold wiring is written once. If a `keepState` processor turns out not to survive the swap, STOP and report it rather than forking the engine per store: it would mean the seam is narrower than `EventProcessor` claims, which is a finding about the design.

### Three things that fall out of it

- **`-f, --folder` is a `requiredOption` today and is used for exactly one thing**: `createFileKeepState(options.folder)`. On `--store sqlite` it is meaningless, so it must stop being unconditionally required without becoming optional-and-ignored on the path that needs it. Required WITH `--store file`, refused or unused with `--store sqlite`.
- **Retention is exposed, pruning is not automatic.** The entity path has a retention setting and `prune` is deliberately a call the HOST schedules rather than a side effect of a write (ADR-0022), because a prune inside processing stalls whichever block crosses the threshold. A CLI indexing into SQLite is a host, so it should be able to SET retention; it should not silently prune inside the index loop. Default stays `unbounded`.
- **No keeper on the entity path, and no second cursor.** The store holds the rows and the sync cursor, written in the same transaction as the block (ADR-0027), and `StreamBuilder` reads that persisted cursor on every call rather than holding one. Do not wire a `KeepState` alongside it, and do not invent a file cursor: that would be two places to persist and a new way to have them disagree, which is the thing the seam route was chosen to avoid.

### The example is the evidence, again

`examples/event-processor-nfts` already carries `src/entities.ts`, and the browser demo runs it. **The same file must run under the CLI**, with no change to it whatsoever — that is the claim, and a diff showing zero lines changed in the processor is the proof. Add whatever entry the CLI needs (a module exporting the tagged processor) and a README section with one documented command and what a reader should see.

If that turns out to need a change to `entities.ts`, STOP and report it: it would mean the processor is not actually backend-neutral, which is a finding about the design rather than a detail of this task.

## Acceptance criteria

- [ ] `etherfold index --store sqlite --db <url>` indexes with an entity processor into `@etherfold/state-store-sqlite`, and the resulting rows are the ones the same processor produces elsewhere.
- [ ] **The fold goes through `LogFetcher` + `createDirectIngestion` + `StreamBuilder`**, and `EthereumIndexer` is not constructed anywhere in the CLI's indexing path. Assert it rather than claim it: the split-versus-combined equivalence this repo already proves must hold against the SAME `StreamBuilder` code the split path uses.
- [ ] **The one-shot terminates at the tip and exits on its code**: `0` when it reaches the tip, non-zero on a `fatal` report (a bad token, a foreign `{source, config}`, a suspected truncation), so a CI job can depend on the exit code rather than on parsing output.
- [ ] `--store` is required, and its two values are wired: `file` keeps the existing free-form behaviour byte-for-byte, `sqlite` is the new path — both through the same engine.
- [ ] The processor kind comes from the MODULE, not from a flag, using the same `'js-object'` / `'entities'` vocabulary as `@etherfold/browser`. An untagged module still means `'js-object'` and every existing CLI invocation keeps working unchanged.
- [ ] A kind/store mismatch is refused at startup, naming what it got and what that store needs, BEFORE any network call — matching the existing ordering, which fails a keeper-less processor without first issuing `eth_chainId`.
- [ ] `--folder` is required for `--store file` and not required for `--store sqlite`.
- [ ] Stop and resume: an interrupted CLI index continues from the cursor in the store rather than re-indexing from the start block, and lands where an uninterrupted run lands. Tested by killing it mid-run, which is also what proves the fetcher holds no cursor of its own.
- [ ] Reorg through the CLI path, including a counter that decreases.
- [ ] Retention is settable from the CLI; nothing prunes automatically inside the index loop (ADR-0022).
- [ ] `examples/event-processor-nfts/src/entities.ts` runs under the CLI **unchanged** — zero lines different — with one documented command and a README section saying what to expect.
- [ ] Tests in `packages/cli/test/` (and `@etherfold/utils` if the resolution moved), vitest, plus a changeset for every published package whose surface changed.

## Blocked by

- None. `backend-neutral-entity-event-processor` (the `EntityEventProcessor` and the cursor port), `index-in-the-browser-with-a-chosen-backend` (the tagged-kind vocabulary this mirrors), `agnostic-log-fetcher` (the `LogFetcher`) and `ingest-wire-receiving-side` (the `StreamBuilder`) have all landed.

## Prompt

> Make `etherfold index` run an entity processor into a store, in the `etherfold` monorepo, so the same processor object that indexes in a browser tab also indexes on a server.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a dependency landed differently, or an ADR superseded an assumption here, do NOT build on the stale premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal"). This task in particular was REWRITTEN against `StreamBuilder` while `work/specs/ready/one-command-runs-the-whole-pipeline.md` was being drafted, and that spec has renamed the command set twice; if its command names or its engine decision have moved again, STOP rather than reconciling them yourself.
>
> **Read `CONTEXT.md`'s "What must work FIRST" bullets BEFORE the spec below.** `one-processor-everywhere` is a terminal launch snapshot that is deliberately NOT edited, and two of its words are RETIRED: it says "`etherfold serve` runs fetching, processing and serving in one process" (`serve` now means ONLY the read-only tier; the all-in-one is `run`) and its story 12 says "a split **watcher** and indexer-server" (ADR-0003 renamed the watcher to the **log-fetcher** and `CONTEXT.md` says do not bring it back). The glossary is what you are meant to land on; read that spec for its STORIES, not for its command vocabulary.
>
> Then read `work/specs/tasked/one-processor-everywhere.md` (user stories 1 and 12), then `packages/cli/src/cli.ts` and `packages/cli/src/index.ts` (note the `keepState` refusal near the top of `init`, and that `-f, --folder` is a requiredOption feeding exactly one call, `createFileKeepState`), `packages/utils/src/processorSetup.ts` (`instantiateProcessor`), `packages/browser/src/IndexerState.ts` (the `ProcessorKind` / `TaggedProcessor` union this mirrors), and ADR-0003, ADR-0004, ADR-0016, ADR-0022 and ADR-0027.
>
> The gap: the default `index` command requires `processor.keepState`, so it REFUSES an entity processor, whose state and cursor live in a `StateStore` instead. `etherfold serve` is a different deployable (the HTTP indexer-server) and its `--db` is not the flag you are adding. `one-processor-cli-and-split-server` proved the split with a TEST rather than a runnable path, so story 12 is currently unreachable from a terminal.
>
> **The engine is decided and it is NOT `EthereumIndexer`.** Fold through the two ADR-0003 halves with the transport removed: a `LogFetcher` pushing into `createDirectIngestion(new StreamBuilder(processor, source, {stream}))`, with an `EntityEventProcessor` over a `VersionedStateStore` on a libSQL handle from `createNodeDB`. Drive it with `runFetcherLoop` plus an `AbortController` aborted from `onReport` at the tip; a `fatal` report exits non-zero. The reason is that `one-command-runs-the-whole-pipeline` builds `run` and `index` on the same `StreamBuilder` and asserts they produce identical state — an assertion that means nothing if the CLI folds through a second engine. Do not construct an `EthereumIndexer` in the indexing path; it stays the browser's.
>
> The rest of the shape is decided. `--store` is REQUIRED and takes `file` or `sqlite`; `--db <url>` (libSQL) accompanies `sqlite`, mirroring `serve`. Both arms run on the SAME engine, since `StreamBuilder` takes an `EventProcessor` and both processor kinds are one. The processor KIND is NOT a flag: it comes from the module, in the same `'js-object'` / `'entities'` vocabulary the browser hook uses, and an untagged module still means `'js-object'` so nothing shipped breaks. A flag would be a second source of truth for one fact. A kind/store mismatch is a loud refusal naming both, raised BEFORE any RPC call, matching the existing ordering.
>
> Where the tag lives on the module is yours to design; `instantiateProcessor` is the natural place to resolve it. Record what you chose.
>
> Do not wire a `KeepState` on the entity path and do not invent a file cursor: the store already holds the rows and the cursor, in one transaction (ADR-0027), and the stream-builder reads that persisted cursor every call rather than holding one. Expose retention, but do not prune inside the index loop — pruning is the host's scheduled call (ADR-0022) and a prune mid-index stalls whichever block crosses the threshold.
>
> **Do not rename the command.** `one-command-runs-the-whole-pipeline` re-means the whole set (this one-shot becomes `build`) and its tasks are blocked on this one. Ship under `etherfold index`.
>
> The evidence is the example. `examples/event-processor-nfts/src/entities.ts` already runs in the browser demo; it must run under the CLI with ZERO lines changed, one documented command, and a README section. If it needs a change, STOP and report: that would mean the processor is not backend-neutral, which is a finding about the design rather than a detail of this task. The same applies if a `keepState` processor cannot be driven by `StreamBuilder`: report it rather than forking the engine per store.
>
> Done means: an author writes one processor, picks IndexedDB with one line in a tab or `--store sqlite` on a server, and both index the same chain into the same state — through the same components a split deployment uses.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular how the module declares its processor kind, what happens to `--folder`, and how you stopped the loop at the tip.

---

### Claiming this task

```sh
dorfl claim index-to-a-store-from-the-cli --arbiter origin
git fetch origin && git switch -c work/index-to-a-store-from-the-cli origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/index-to-a-store-from-the-cli.md work/tasks/done/index-to-a-store-from-the-cli.md
```

## Decisions

**1. The module declares its KIND by returning a tag: `createProcessor()` → `{kind: 'entities', processor}`; untagged means `'js-object'`.** Same two words and same shape `@etherfold/browser` takes (`ProcessorKind` / `TaggedProcessor`), read as a discriminant (`'kind' in value`) rather than sniffed, so a wrapper or proxy cannot make the guess wrong in silence. What the tag CARRIES differs on purpose: the browser is handed a store-bound runtime, a module cannot be (the store is the deployment's choice), so the `'entities'` arm carries the AUTHORING `EntityProcessor` and the CLI builds `new EntityEventProcessor(store, processor)` around it. Alternatives considered and rejected: a separate named export (reads as a tag, behaves as a sniff, a module carrying both says two things), a `processorKind` export beside `createProcessor` (two exports that can disagree), a field on the processor object (would put a host's question inside the authoring surface, and `entities.ts` had to stay unchanged). **Touches** `@etherfold/utils` (`instantiateProcessor` now refuses an `'entities'` module rather than returning a non-`EventProcessor`), `@etherfold/browser`'s vocabulary (duplicated, not imported: a module loader must not depend on a browser runtime to type an export), and story 2 of `one-command-runs-the-whole-pipeline`, which was explicitly waiting on this. Written up as **ADR-0039**.

**2. `--folder` is REFUSED with `--store sqlite`, not ignored — and `--db` and `--retention` are refused with `--store file`.** It stops being a `requiredOption` and becomes required only with `--store file`. An accepted-and-ignored flag is a deployment believing something untrue (a retention window nothing enforces, a database nothing writes). Alternative: accept and ignore, which is what "optional" would have meant. **Touches** every existing `etherfold index -p … -f …` invocation, which now needs `--store file`; the changeset says so.

**3. `--db` is REQUIRED with `--store sqlite`, with no default — deliberately UNLIKE `serve`.** `serve` defaults to `DB` then `file:./etherfold.db` inside `startServer`; the one-shot does not, so no run ever writes a database nobody named, and it is symmetric with `--folder` (which has no default either). Alternative: mirror `serve`'s default literally, which the task's "mirroring `serve`" could be read to require; I read `--db <url>` as the flag SHAPE, not the defaulting. **Touches** `serve` (unchanged) and `run`/`build`, which will have to pick one of the two conventions.

**4. Stopping at the tip: abort from `onReport` on the FIRST `progress` with `caughtUp`, or on `idle`.** A `fatal` ends the loop by itself and is re-thrown so the process exits 1. `contended` (yielded) deliberately does NOT stop: it means another sender moved the cursor, and stopping would report success having landed nothing. **Retryable failures retry indefinitely** on the host's backoff curve rather than after N attempts: bounding them would invent a policy `run` must not have, and core already applies a bounded in-cycle `RetryPolicy`. Note the practical effect is smaller than it sounds: an unreachable node fails fast during source resolution (verified: exit 1), so the unbounded path only opens after the first successful chain call. If a reviewer wants a bound, it belongs beside `build`, not here. **Touches** `build`, which the spec says reuses this driver.

**5. `resolveStreamConfig` is now public on `@etherfold/core`.** The entity store's retention window is validated against a finality depth, and the only correct number is the one the stream resolves to; restating `17` in the CLI would have pinned a value that is hashed into the wire identity and silently forked the config hash the day the default moved. Alternative: a `--finality` flag (a second opinion about one number). No `--finality` flag exists, so the CLI is always on the stream default. **Touches** `@etherfold/core`'s published surface (changeset: minor).

**6. `--retention` takes a bare number as BLOCKS, plus `revert-only` / `unbounded`, default `unbounded`.** A duration is refused naming the unit (ADR-0019). Nothing prunes inside the index loop and there is no `--prune` verb: pruning is the host's scheduled call (ADR-0022), and a prune verb is a different command's business.

**7. The root `pnpm test` filter now includes `./examples/*`.** The example is EVIDENCE for this task ("the same processor, unchanged, under the CLI"), and evidence nothing runs is a claim. Packages with no `test` script are skipped (verified: the filter exits 0 today). Alternative: put the example test in `packages/cli` importing across the workspace, which breaks `pnpm typecheck` (TS6059, `rootDir`). **Touches** the acceptance gate's scope: any future example test now runs in it.

**8. `eip-1193` moved from devDependency to dependency of `etherfold`.** `IndexingDependencies.provider` puts `EIP1193ProviderWithoutEvents` in the published `.d.ts`; core's own `publishedTypeDependencies` test caught it, and `@etherfold/core` / `@etherfold/fetcher-host` already declare it the same way.

**9. The example's CLI entry indexes ONE collection, from `NFT_CONTRACT` / `NFT_START_BLOCK`.** The browser app indexes one ACCOUNT across every address using a topic filter it passes as stream config, which a command line cannot express; "every ERC-721 transfer on mainnet" is not a demo. This also forced `"types": ["node"]` into the example's build tsconfig, since it is no longer browser-only.

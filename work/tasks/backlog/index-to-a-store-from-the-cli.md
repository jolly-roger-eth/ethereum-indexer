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

### The shape, which is decided

**`--store` is REQUIRED, and it names where the state goes.** Not inferred, not defaulted:

```sh
etherfold index -p ./processor.js --store file   --folder ./state          # free-form, unchanged
etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db  # entity path
```

The reason it is mandatory rather than defaulted is that this is the one decision the CLI genuinely owns, and the two answers are not interchangeable: one keeps a blob with no history, the other keeps versioned rows that answer as-of reads and survive a reorg. A default would make the difference invisible at exactly the moment a deployment is choosing it. (`--db` mirrors `serve`'s existing flag and takes a libSQL url.)

**The processor KIND is not a flag.** It comes from the module, the same way it comes from the caller in the browser: `createIndexerState` takes `{kind: 'entities', processor}` or a bare processor meaning `'js-object'` (`packages/browser/src/IndexerState.ts`). The CLI reads the same vocabulary off the module's export, and an untagged `createProcessor` keeps meaning `'js-object'`, so every shipped module keeps working untouched.

Putting the kind on the command line as well would be a SECOND source of truth for one fact, and two answers that can disagree is precisely what the browser's tag exists to prevent. So `--store` says where the state goes, the module says what kind of processor it is, and **a mismatch is a loud refusal** naming both — a `'js-object'` processor with `--store sqlite`, or an `'entities'` processor with `--store file`, fails at startup with a message saying which it got and which it needed, before any RPC call is made.

Where exactly the tag lives on the module is yours to design (a tagged `createProcessor` return, a separate named export, or a discriminated module shape). `instantiateProcessor` in `@etherfold/utils` is what resolves it today and is the natural place. Say what you chose and why.

### Three things that fall out of it

- **`-f, --folder` is a `requiredOption` today and is used for exactly one thing**: `createFileKeepState(options.folder)`. On `--store sqlite` it is meaningless, so it must stop being unconditionally required without becoming optional-and-ignored on the path that needs it. Required WITH `--store file`, refused or unused with `--store sqlite`.
- **Retention is exposed, pruning is not automatic.** The entity path has a retention setting and `prune` is deliberately a call the HOST schedules rather than a side effect of a write (ADR-0022), because a prune inside processing stalls whichever block crosses the threshold. A CLI indexing into SQLite is a host, so it should be able to SET retention; it should not silently prune inside the index loop. Default stays `unbounded`.
- **No keeper on the entity path, and no second cursor.** The store holds the rows and the sync cursor, written in the same transaction as the block (ADR-0027). Do not wire a `KeepState` alongside it, and do not invent a file cursor: that would be two places to persist and a new way to have them disagree, which is the thing the seam route was chosen to avoid.

### The example is the evidence, again

`examples/event-processor-nfts` already carries `src/entities.ts`, and the browser demo runs it. **The same file must run under the CLI**, with no change to it whatsoever — that is the claim, and a diff showing zero lines changed in the processor is the proof. Add whatever entry the CLI needs (a module exporting the tagged processor) and a README section with one documented command and what a reader should see.

If that turns out to need a change to `entities.ts`, STOP and report it: it would mean the processor is not actually backend-neutral, which is a finding about the design rather than a detail of this task.

## Acceptance criteria

- [ ] `etherfold index --store sqlite --db <url>` indexes with an entity processor into `@etherfold/state-store-sqlite`, and the resulting rows are the ones the same processor produces elsewhere.
- [ ] `--store` is required, and its two values are wired: `file` keeps the existing free-form behaviour byte-for-byte, `sqlite` is the new path.
- [ ] The processor kind comes from the MODULE, not from a flag, using the same `'js-object'` / `'entities'` vocabulary as `@etherfold/browser`. An untagged module still means `'js-object'` and every existing CLI invocation keeps working unchanged.
- [ ] A kind/store mismatch is refused at startup, naming what it got and what that store needs, BEFORE any network call — matching the existing ordering, which fails a keeper-less processor without first issuing `eth_chainId`.
- [ ] `--folder` is required for `--store file` and not required for `--store sqlite`.
- [ ] Stop and resume: an interrupted CLI index continues from the cursor in the store rather than re-indexing from the start block, and lands where an uninterrupted run lands. Tested.
- [ ] Reorg through the CLI path, including a counter that decreases.
- [ ] Retention is settable from the CLI; nothing prunes automatically inside the index loop (ADR-0022).
- [ ] `examples/event-processor-nfts/src/entities.ts` runs under the CLI **unchanged** — zero lines different — with one documented command and a README section saying what to expect.
- [ ] Tests in `packages/cli/test/` (and `@etherfold/utils` if the resolution moved), vitest, plus a changeset for every published package whose surface changed.

## Blocked by

- None. `backend-neutral-entity-event-processor` (the `EntityEventProcessor` and the cursor port) and `index-in-the-browser-with-a-chosen-backend` (the tagged-kind vocabulary this mirrors) have both landed.

## Prompt

> Make `etherfold index` run an entity processor into a store, in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`), so the same processor object that indexes in a browser tab also indexes on a server.
>
> FIRST read `work/specs/tasked/one-processor-everywhere.md` (user stories 1 and 12), then `packages/cli/src/cli.ts` and `packages/cli/src/index.ts` (note the `keepState` refusal near the top of `main`, and that `-f, --folder` is a requiredOption feeding exactly one call, `createFileKeepState`), `packages/utils/src/processorSetup.ts` (`instantiateProcessor`), `packages/browser/src/IndexerState.ts` (the `ProcessorKind` / `TaggedProcessor` union this mirrors), and ADR-0016, ADR-0022 and ADR-0027.
>
> The gap: the default `index` command requires `processor.keepState`, so it REFUSES an entity processor, whose state and cursor live in a `StateStore` instead. `etherfold serve` is a different deployable (the HTTP indexer-server) and its `--db` is not the flag you are adding. `one-processor-cli-and-split-server` proved the split with a TEST rather than a runnable path, so story 12 is currently unreachable from a terminal.
>
> The shape is decided. `--store` is REQUIRED and takes `file` or `sqlite`; `--db <url>` (libSQL) accompanies `sqlite`, mirroring `serve`. The processor KIND is NOT a flag: it comes from the module, in the same `'js-object'` / `'entities'` vocabulary the browser hook uses, and an untagged module still means `'js-object'` so nothing shipped breaks. A flag would be a second source of truth for one fact. A kind/store mismatch is a loud refusal naming both, raised BEFORE any RPC call, matching the existing ordering.
>
> Where the tag lives on the module is yours to design; `instantiateProcessor` is the natural place to resolve it. Record what you chose.
>
> Do not wire a `KeepState` on the entity path and do not invent a file cursor: the store already holds the rows and the cursor, in one transaction (ADR-0027). Expose retention, but do not prune inside the index loop — pruning is the host's scheduled call (ADR-0022) and a prune mid-index stalls whichever block crosses the threshold.
>
> The evidence is the example. `examples/event-processor-nfts/src/entities.ts` already runs in the browser demo; it must run under the CLI with ZERO lines changed, one documented command, and a README section. If it needs a change, STOP and report: that would mean the processor is not backend-neutral, which is a finding about the design rather than a detail of this task.
>
> Done means: an author writes one processor, picks IndexedDB with one line in a tab or `--store sqlite` on a server, and both index the same chain into the same state.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular how the module declares its processor kind and what happens to `--folder`.

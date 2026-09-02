---
title: 'Retire the JS-object processor path, keeping stratagems as a capability reference'
slug: retire-the-js-object-processor-path
blockedBy: [index-to-a-store-from-the-cli, a-snapshot-a-client-cannot-read-is-refused-not-installed]
covers: []
---

## What to build

Delete `@etherfold/js-processor` and the free-form JS-object authoring path, leaving the **ENTITY
path** as the only way to write a processor. The decision and its consequences are ADR-0037; this task
is its execution. This is a deletion task: the goal is that the repo has
ONE processor model, not two.

**Why it is worth doing rather than tolerating.** The JS-object path is what SHIPPED, but the entity
path is what this project is for (`CONTEXT.md`; `work/specs/tasked/one-processor-everywhere.md`), and
carrying both costs a fork in every seam that touches state: two `ProcessorKind`s in
`createIndexerState`, the `KeepState` blob keeper family beside the `StateStore` seam, a second revert
mechanism, and a second answer to every storage question. What the JS-object path uniquely offers is
an authoring STYLE. What it does not offer is anything a server needs: no as-of queries, no retention
or pruning, no listing, and no schema for the GraphQL layer, which is generated from entity
declarations. Its state is also a whole blob rewritten per save, which is the shape this repo has just
spent a whole design pass removing from the stream.

**What is NOT lost.** The plain-object-plus-immer-reverse-patches STORAGE characteristic already
exists behind the proper seam as `@etherfold/state-store-patch` (the LIGHT store), whose own source
notes it is "the same arrangement as `@etherfold/js-processor`'s `processor/immer.ts`". So the
mechanism survives; only the free-form authoring surface goes.

### Blocked, and this is the load-bearing part

`etherfold index` currently REQUIRES a keepState processor — `packages/cli/src/index.ts` throws
`this processor do not support "keepState" config` when a processor has none — so the CLI is built
around the path being deleted. **`index-to-a-store-from-the-cli` must land first**; it is in
`work/tasks/ready/` and its stated goal is exactly the replacement ("the same processor object,
unchanged, indexing on a server into SQLite").

**THE CLI ARM IS THIS TASK'S TO REMOVE, and it was previously owned by nobody.** The seam is
three-way and only one edge existed: `index-to-a-store-from-the-cli` CREATES `--store file` with its
required `--folder` over `createFileKeepState`; `work/specs/ready/one-command-runs-the-whole-pipeline.md`
RENAMES the command that flag lives on; and this task is what makes the free-form arm meaningless. So
name it explicitly: when this lands, `--store` loses its `file` value, `--folder` goes with it,
`packages/cli/src/keepState.ts` goes unless the snapshot path still needs it (see the `KeepState`
judgement below), and the kind/store mismatch refusal collapses because there is only one kind left.

**Beware the command RENAME while doing it.** This task says `etherfold index` twice, and its
ordering argument turns on which command carries the `keepState` refusal. Under the command set
`CONTEXT.md` now pins, the one-shot becomes **`build`** and `index` is re-meant as the receiving half
of a split. Check which names exist when you claim this; if the rename has landed, the refusal you
are deleting lives on `build`, and the argument is unchanged but the file is not.

### The stratagems conformance workload: what to keep and what to accept losing

`@etherfold/conformance-workload-stratagems` uses `fromJSProcessor` in `src/oracle.ts` to drive the
VENDORED original stratagems processor and produce the golden state.

- **KEEP** the contracts deployment as a real-ABI reference, the captured stream fixture
  (`fixtures/stratagems-alpha1.stream.json.gz`) as the golden INPUT, and the committed golden state
  (`fixtures/stratagems-alpha1.state.json`) as the thing the ported entity processor is compared
  against. The conformance test keeps working: it compares against committed data.
- **ACCEPT LOSING** the ability to REGENERATE that golden, since the oracle goes with the package.
  That is a deliberate trade and should be recorded where the fixtures are described: after this, the
  golden is a frozen expectation rather than a recomputable oracle. `CONTEXT.md` already says a diff
  on it "means the processor changed meaning, which is a FINDING and not a fixture update", so
  regeneration was never the normal path.
- The vendored GPL-3.0 original and ADR-0026's private-package reasoning are unaffected.

### The examples

Six example apps use `fromJSProcessor` (`event-processor-nfts`, `event-processor-bleeps`,
`event-processor-conquest-eth`, `event-processor-conquest-fplay`, `basic`, `mud`). Port them to entity
declarations or delete the ones that earn nothing — deciding which is part of this task, and porting
at least one is worth more than porting all six, because the examples exist to demonstrate the target
path.

## Acceptance criteria

- [ ] `packages/js-processor` is deleted, along with **every** workspace reference. Derive the list
      rather than trusting this one; at the time of writing it is a **devDependency** of
      `@etherfold/browser`, `@etherfold/processor-sqlite` and
      `@etherfold/conformance-workload-stratagems`, and a **runtime `dependency` of all SIX example
      packages** (`basic`, `event-processor-bleeps`, `event-processor-conquest-eth`,
      `event-processor-conquest-fplay`, `event-processor-nfts`, `mud`). An earlier version of this
      criterion said "not a runtime one" and named only two dependents, which is wrong on seven of
      nine and is exactly the shape that makes a deletion look done while the workspace still
      references it.
- [ ] **The five files under `docs/spikes/sqlite-in-the-browser/` that import the package by relative
      path into its `dist/` are handled deliberately** (`run/verify-port.ts`, `browser/patch-cut.ts`,
      `run/build-traces.ts`, `run/measure-patch-replay.ts`, `run/sharing-probe.ts`). `docs/spikes/` is
      NOT a workspace package, so `pnpm typecheck` cannot see them and a green gate will NOT tell you
      they broke. They are a durable EVIDENCE store, so decide between leaving them as a historical
      record with a note saying the import no longer resolves, and pruning them; say which in
      `## Decisions`. Do not silently leave dangling imports with no marker.
- [ ] The `'js-object'` `ProcessorKind` and the `TaggedProcessor` fork are removed from
      `@etherfold/browser`, along with the bare `EventProcessorWithInitialState` form
      `createIndexerState` accepts for backward compatibility. One kind, one call shape.
- [ ] The `KeepState` blob-keeper family is removed or reduced to whatever the SNAPSHOT path still
      needs — decide which, and say so in `## Decisions`, because `KeepState` is also how a snapshot
      hydrates a client and that use may outlive the processor kind.
- [ ] The conformance workload still runs and still compares the ported entity processor against the
      COMMITTED golden state, with the oracle removed. The fixture README records that the golden is
      now a frozen expectation rather than a regenerable one.
- [ ] At least one example demonstrates the entity path end to end; every remaining example builds.
      Examples that are not ported are DELETED rather than left broken.
- [ ] `CONTEXT.md` is updated in the SAME change: the `JSObjectEventProcessor` and `processor kind`
      entries go or are rewritten as history, and no glossary entry still describes two authoring
      paths as current.
- [ ] Ship changesets for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `index-to-a-store-from-the-cli` — the CLI refuses a processor without `keepState` today, so deleting
  the JS-object path before that lands breaks `etherfold index`.
- `a-snapshot-a-client-cannot-read-is-refused-not-installed` — SHARED FILE, and an ordering that
  matters. Both tasks edit `packages/browser/src/storage/state/OnIndexedDB.ts`: that one HARDENS the
  free-form keeper's remote-snapshot install (refuse an unreadable format instead of installing
  silently mistyped state), and this one removes or reduces the `KeepState` family around it.
  Serialised so the guard lands while the keeper still exists, which also means this task's central
  `KeepState` judgement is made with the snapshot path's real requirements already pinned in code
  rather than guessed at. Unserialised these two are a merge conflict, and worse, a chance to delete
  a guard that had just been added.

## Prompt

Read `work/specs/tasked/one-processor-everywhere.md` (the entity path is its whole subject) and
`CONTEXT.md`'s entries for `JSObjectEventProcessor`, `processor kind`, `KeepState`, `EntityProcessor`
and `conformance workload` before starting.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). In
particular confirm that `index-to-a-store-from-the-cli` actually landed and that the CLI no longer
requires `keepState`; if it still does, STOP and surface that rather than working around it.

**Where to look.** `packages/js-processor` is the package. `packages/browser/src/IndexerState.ts`
carries the `ProcessorKind` fork. `packages/cli/src/index.ts` has the `keepState` requirement.
`packages/conformance-workload-stratagems/src/oracle.ts` is the consumer that MATTERS outside the
examples (it drives the vendored original to produce the golden), and `src/fixtures.ts` describes the
golden files. It is not the only one, though: `packages/browser/test/invalidation.test.ts`,
`packages/browser/test/reconfigure.test.ts` and `packages/processor-sqlite/test/equivalence.test.ts`
all use `fromJSProcessor` too, and those tests must be ported or dropped with the path rather than
discovered when the build goes red.

**The judgement this task really carries** is what happens to `KeepState`. It serves two masters: the
JS-object processor's whole-state blob, and the SNAPSHOT hydration path (`bootstrap` in `CONTEXT.md`).
Deleting the first does not automatically delete the second. Work out which parts the snapshot path
needs, keep exactly those, and record the reasoning.

**Scope fence.** Do NOT change the entity path's behaviour, the state-store seam, or the conformance
suite's questions. Do NOT delete the vendored stratagems original or the fixtures. This is a removal
task; if you find yourself designing something, you have left its scope.

RECORD non-obvious decisions in a `## Decisions` block at the end of your FINAL REPORT (what survived
of `KeepState` and why; which examples were ported versus deleted; how the conformance workload
compares without an oracle). Do NOT write the done record, the commit message or the PR body.

---

### Claiming this task

```sh
dorfl claim retire-the-js-object-processor-path --arbiter origin
git fetch origin && git switch -c work/retire-the-js-object-processor-path origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/retire-the-js-object-processor-path.md work/tasks/done/retire-the-js-object-processor-path.md
```

## Decisions

**What survived of `KeepState`: nothing, snapshot half included.** It had exactly one caller (`JSObjectEventProcessor.keepState`), and its two masters turned out to be one master and a namesake. The entity path's bootstrap never used it: `openSnapshotAware` / `bootstrapFromSnapshot` / `StateSnapshot` / `ENTITY_SNAPSHOT_FORMAT` live at the storage seam, where a store's own transaction is, and duplicate the free-form keeper's client-side selection point for point plus two things it never did. So `KeepState`, `ExistingStateFetcher`, `StateSaver`, `AllData`, `ProcessorContext`, `EventProcessorWithInitialState`, `keepStateOnIndexedDB`, `keepStateOnLocalStorage`, `createFileKeepState` and `contextFilenames` all go. **This deletes the guard `a-snapshot-a-client-cannot-read-is-refused-not-installed` had just added** (the format refusal in `storage/state/OnIndexedDB.ts`) and the `BLOB_SNAPSHOT_FORMAT` envelope it guarded: what is lost is the free-form reader, not the RULE, which the entity reader already enforces with `SnapshotFormatError`. Alternative considered and rejected: keeping the blob envelope as a publish format with no writer and no reader. Touches ADR-0040 (its rule stands, one of its two numbered envelopes is gone) and the `bootstrap` / `KeepState` glossary entries.

**The `{kind, processor}` module tag is deleted too, superseding ADR-0039, and a module still carrying it is REFUSED.** The acceptance criteria mandate removing the browser's `TaggedProcessor` fork ("one kind, one call shape"); leaving `@etherfold/utils` with a one-valued tag would have kept "processor kind" a live concept in the glossary, which another criterion forbids. So `instantiateProcessorWithKind` / `ResolvedProcessor` / `ProcessorKind` go and `instantiateProcessor` returns the authoring object, typed by the caller. The refusal is a NEW ERROR and a deliberate one: unwrapping the retired shape would keep a second module shape alive forever, and silently accepting it would hand a store a wrapper it asks for `entities` and gets `undefined` three frames later. It is refused before any RPC call, at the same point the kind/store mismatch was. Touches `examples/event-processor-nfts/src/cli.ts` and any external processor module; ADR-0039 is marked superseded rather than deleted. Alternative considered: silently unwrapping the tag for one release (rejected: "nothing is published, do not add a compatibility shim for a caller that does not exist").

**`--store` survives with exactly one value and stays REQUIRED.** The task says `--store` loses its `file` value and that `one-command-runs-the-whole-pipeline` renames the command the flag lives on, so the flag itself is not a leftover: it is the axis a second backend arrives on, and the word an operator types is the same before and after one appears. Alternatives: dropping it (`--db` alone names the destination) or defaulting it to `sqlite`. Both are user-visible default changes, and neither is a removal, so I made the minimal one. Touches `one-command-runs-the-whole-pipeline` (which renames this command) and any documented invocation.

**Examples: `event-processor-nfts` ported, five deleted, `web-demo` deleted as collateral.** `event-processor-nfts` keeps `entities.ts` (which its browser demo and `etherfold index` already ran) and loses `src/index.ts`, `src/types.ts` and `scripts/version.mjs` (which substituted `__VERSION_HASH__` into the deleted `dist/index.js`; the entity processor carries a literal version and the README's build command is now plain `tsc`). `basic`, `event-processor-bleeps`, `event-processor-conquest-eth`, `event-processor-conquest-fplay` and `mud` are deleted. `web-demo` was not one of the six but consumed three of them and rendered a state blob as a JSON tree, which is the shape the entity path does not have, so porting it was a rewrite rather than a port. Two examples remain (`event-processor-nfts`, `browser-reference`), both entity-path end to end. The root `README.md`'s whole Usage section was the `basic` app, so it is rewritten against the entity path.

**Conformance workload: the golden is now frozen, and the vendored original stays unrun.** `src/oracle.ts`, `test/oracle.test.ts` and `run/regenerate-golden-state.ts` are deleted; `runWorkload` already compared against the committed file, so the workload's question is unchanged and the alpha1 case still passes on every backend. The vendored `js-processor.ts` is KEPT (the task forbids deleting it, and the goldens' whole claim is that it computed them), which meant vendoring the `JSProcessor` TYPE beside it as `vendor/stratagems/js-processor-type.ts` so the folder still typechecks rather than becoming a folder of `any`. Recorded in `fixtures/README.md`, the package README and `vendor/stratagems/README.md`: a diff is now triaged by READING that file, not by re-running it.

**`docs/spikes/sqlite-in-the-browser/`: kept with a marker, not pruned.** The five files importing `packages/js-processor/dist/` are left in place, and the spike README now names all five, says the import no longer resolves, says why they are kept (a measurement whose harness has been deleted is a number with no method), and says explicitly that `docs/spikes/` is not a workspace package so `pnpm typecheck` will not tell you. The `Re-running it` block marks each broken command `BROKEN`.

**Two pending changesets on `main` named the deleted package** and would have failed `changeset status` and any release (`packages/core/test/pendingChangesets.test.ts` catches this). I removed `@etherfold/js-processor` from their frontmatter and made one sentence of prose truthful; I did NOT rewrite `index-an-entity-processor-into-a-store-from-the-cli.md`, whose `--store file` examples my own changeset supersedes in the same release.

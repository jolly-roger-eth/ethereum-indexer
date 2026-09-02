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

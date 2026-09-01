---
title: 'Retire the JS-object processor path, keeping stratagems as a capability reference'
slug: retire-the-js-object-processor-path
blockedBy: [index-to-a-store-from-the-cli]
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
around the path being deleted. **`index-to-a-store-from-the-cli` must land first**; it is unblocked
and its stated goal is exactly the replacement ("the same processor object, unchanged, indexing on a
server into SQLite").

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

- [ ] `packages/js-processor` is deleted, along with its workspace references (it is a
      **devDependency** of `@etherfold/browser` and `@etherfold/processor-sqlite`, not a runtime one —
      check before assuming a deeper coupling).
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

## Prompt

Read `work/specs/tasked/one-processor-everywhere.md` (the entity path is its whole subject) and
`CONTEXT.md`'s entries for `JSObjectEventProcessor`, `processor kind`, `KeepState`, `EntityProcessor`
and `conformance workload` before starting.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). In
particular confirm that `index-to-a-store-from-the-cli` actually landed and that the CLI no longer
requires `keepState`; if it still does, STOP and surface that rather than working around it.

**Where to look.** `packages/js-processor` is the package. `packages/browser/src/IndexerState.ts`
carries the `ProcessorKind` fork. `packages/cli/src/index.ts` has the `keepState` requirement.
`packages/conformance-workload-stratagems/src/oracle.ts` is the only real consumer of
`fromJSProcessor` outside the examples, and `src/fixtures.ts` describes the golden files.

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

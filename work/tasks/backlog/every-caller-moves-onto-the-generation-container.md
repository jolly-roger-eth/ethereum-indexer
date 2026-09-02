---
title: 'MIGRATE: every caller, example and doc moves onto the generation container'
slug: every-caller-moves-onto-the-generation-container
spec: a-reconfigure-is-not-an-outage
blockedBy: [the-generation-container-expands-beside-the-old-shape]
covers: []
---

## What to build

The **MIGRATE** batch (`TASKING-PROTOCOL` §3a). Move every call site onto the new container class name
and the new factory shape. Purely additive in effect: the old alias and old shape still exist, so the
workspace stays green throughout.

### TWO disjoint surfaces, both this batch's, both DERIVED not trusted

They are different symbols in different packages. Deriving only one of them is the failure this section
exists to prevent — it leaves the contract batch unable to delete what it is told to delete.

**(a) The `createIndexerState` invocations** (browser-side). At the time of writing ~37 sites outside
`dist/`, most under `packages/browser/test/` (`dispose`, `invalidation`, `liveReload`, `reconfigure`,
`setupIndexing`, `txInclusion`), plus `packages/browser/browser/workload.ts`, plus the remaining
example apps.

**(b) The `EthereumIndexer` CLASS identifier** — a SEPARATE list, in FOUR packages, which no other
batch owns. The class is defined in **`@etherfold/core`** (`src/indexer.ts`), and at the time of
writing is used at ~46 sites: `packages/core` (~22, source + tests + its README), `packages/browser`
(~13, `src/IndexerState.ts`, `src/index.ts`, tests), `packages/processor-sqlite` (~9, tests) and
`packages/server` (~2, tests).

**(c) `packages/cli/test/engine.test.ts` is a SOURCE-TEXT GUARD and must be updated with the rename.**
It asserts the CLI constructs and imports no `EthereumIndexer` by matching the literal identifier with
regexes (`/new\s+EthereumIndexer|EthereumIndexer\s*[<(]/` and an import match). A rename that leaves
those regexes alone keeps them **green and VACUOUS**: the invariant that the CLI must not use the
browser engine silently stops being enforced, and nothing goes red to tell you. Update the regexes to
the new identifier so the guard keeps guarding.

**Re-derive BOTH lists before you start.** Several example apps were deleted by
`retire-the-js-object-processor-path` (`basic`, `mud`, `web-demo` among them), and the `processorKinds`
tests are gone with the retired JS-object path. Do not treat a missing site as drift — treat a site
this file does not name as the thing to catch.

**Consider splitting the work file-orthogonally** as you go: (a) is browser-side and (b) is
mostly core/processor-sqlite/server-side, so they barely overlap and can be moved independently.

**Four further edit sites are unowned unless named here, so they are named:** the README usage block,
two JSDoc examples in the browser package's `IndexerState.ts`, the JSDoc in `BrowserStateStore.ts`, and
`CONTEXT.md`.

### Not in scope: the old keeper-collision observation

An earlier draft of this task carried a clause asserting a storage-key non-collision and deleting
`work/notes/observations/keepstate-storage-id-omits-the-processor-version.md`. **That clause is
removed and must not be reinstated.** Its subject no longer exists:
`retire-the-js-object-processor-path` deleted the whole `KeepState` family including
`storage/state/OnLocalStorage.ts`, and `getStorageID` has zero hits in the repo. There is nothing to
assert and nothing to fix. The note is stale and is discharged separately, at tasking time, rather
than through a call-site migration batch.

It would also have violated this task's own scope fence: changing storage keying is not "who calls the
container and how". If per-generation state-store isolation is still wanted, it belongs to the batch
that owns per-generation state factories, expressed against what exists today (`BrowserStateStore`,
`databaseName`, the `StateStore` seam).

## Acceptance criteria

- [ ] **(a)** Every `createIndexerState` invocation outside `dist/` uses the new factory shape.
- [ ] **(b)** Every `EthereumIndexer` CLASS reference outside `dist/` uses the new generation name —
      across `packages/core`, `packages/browser`, `packages/processor-sqlite` AND `packages/server`,
      not the browser package alone. Both lists DERIVED at build time, not read off this file.
- [ ] **`packages/cli/test/engine.test.ts`'s guard regexes are updated to the new identifier**, and the
      guard still FAILS when a CLI source file constructs or imports the engine class. Assert it fails
      on a deliberate violation — a guard that is green because it matches a name nothing uses any
      more is worse than no guard.
- [ ] Every remaining example app is migrated and builds.
- [ ] The four doc sites are updated: the README usage block, the two `IndexerState.ts` JSDoc examples,
      the `BrowserStateStore.ts` JSDoc, and `CONTEXT.md`.
- [ ] **This batch is green throughout**: the alias and the old factory shape still exist, so nothing
      depends on the contract batch having landed.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `the-generation-container-expands-beside-the-old-shape` — the new name and shape must exist before
  anything can move onto them.

## Prompt

> Move every caller, example and doc in the `etherfold` monorepo onto the generation container's new
> class name and factory shape. This is the MIGRATE batch of an expand → migrate → contract refactor:
> the old alias still exists, so the workspace must stay green at every step.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) and `TASKING-PROTOCOL`
> §3a before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and HAS almost certainly
> drifted on the site list). Several example apps and the `processorKinds` tests were deleted by
> `retire-the-js-object-processor-path`. DERIVE the call sites; do not work from the counts in the task
> body. A site the task does not name is the thing to catch; a named site that no longer exists is
> expected, not drift.
>
> **Where to look.** `createIndexerState` invocations across the browser package's tests and
> `browser/workload.ts`; the remaining example apps; the README usage block; the two JSDoc examples in
> `IndexerState.ts`; the JSDoc in `BrowserStateStore.ts`; and `CONTEXT.md`.
>
> **Easy to get wrong:**
>
> - Migrating only the `createIndexerState` sites and not the `EthereumIndexer` CLASS sites. They are
>   DISJOINT surfaces in different packages; the class lives in `@etherfold/core` and is used from
>   `core`, `browser`, `processor-sqlite` and `server`. Missing (b) leaves the contract batch unable to
>   delete the alias, which is exactly how a wide refactor stalls at build time.
> - Leaving `packages/cli/test/engine.test.ts`'s regexes on the OLD identifier. They keep passing and
>   stop enforcing anything.
> - Deleting the alias or the old factory shape. That is the CONTRACT batch; doing it here breaks the
>   green-throughout property this batch exists to preserve.
> - Missing the doc sites. They are unowned by any other task, which is why they are named here.
>
> **Scope fence.** Do NOT delete the alias or the old shape. Do NOT remove the `stateDiscarded`
> discard. Do NOT change what the container DOES — only who calls it and how.
>
> Done means: nothing in the workspace still uses the old name or the old factory shape, every doc
> site is current, the generation key collision is asserted fixed and its note deleted, and the build
> is green with the alias still in place.

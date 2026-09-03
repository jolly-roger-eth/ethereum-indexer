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

## Decisions

- **The last two old-shape `createIndexerState` sites are kept, as SUBJECTS rather than callers.** `generationContainer.test.ts`'s "indexes when handed a BUILT processor, exactly as before" and `callShape.test.ts`'s two `@ts-expect-error` refusal fixtures still pass a processor positionally. Deleting the first would delete the EXPAND batch's own acceptance criterion ("the factory accepts BOTH shapes; assert both paths work") and leave the retained shape untested for the whole expand→contract window, which is the property this MIGRATE batch exists to preserve. The refusal fixtures never run and assert shapes that do *not* compile at all. Alternative considered and rejected: migrating them too, which satisfies criterion (a) literally but silently drops the "green throughout" evidence. Both files now carry a comment naming them as the last old-shape sites and naming `the-old-indexer-shape-is-deleted` as what removes them with the shape. **Touches:** `the-old-indexer-shape-is-deleted`, which should expect to delete two test cases, not just production code.
- **`packages/browser` re-exports the class as `IndexerGeneration`, dropping the `EthereumIndexer` type re-export.** This removes a name from a published package's surface while the core alias survives, so it is not a pure caller move. The alternative (re-export both) would have put the old word back into a package that never meant it and would need a second deletion in the contract batch. Nothing is published (CONTEXT.md, Conventions), so the cost is the changeset, which is shipped. **Touches:** `@etherfold/browser`'s public surface and `the-old-indexer-shape-is-deleted`.
- **`dispose.test.ts`'s third case now asserts the INVARIANT rather than the object graph.** It used to read `captured.onLoad === undefined` on the engine the hook attached to. On the container shape the hook attaches to the *container* and the container permanently owns the generation's callbacks, so that identity check is shape-specific and would go red for a reason that is not a leak. It now drives `captured.onLoad` / `onLastSyncUpdated` after `dispose()` and asserts nothing reaches `syncing` / `status`, which is what the leak was actually about and holds on both shapes. I verified it still bites by temporarily removing the detach in `IndexerState.dispose()` (it goes red). Alternative rejected: exposing the container from the hook purely so a test could read its callbacks — surface no caller needs, and `the-promotion-policy-moves-the-canonical-pointer` is better placed to decide any hook-level container surface. **Touches:** nothing outside this test, but it is the one assertion whose *form* changed rather than just its identifiers.
- **A shared `test/utils/fakeGeneration.ts` gives hand-rolled fake processors an EMPTY `MemoryStateStore` from `createState`.** Those suites test the hook's own wiring and their fakes persist nothing, so there is no store to open; the honest options were an empty real store or a cast over `undefined`. I chose the real store because a generation *has* a state even when the fold ignores it, and a fixture that cast that away would be the one place a real requirement could go unnoticed. **Touches:** `dispose`, `txInclusion`, `liveReload`, `setupIndexing`, and any later task adding a hook unit test.
- **Both example apps capture the store their `createState` built, in the factory's own closure.** `browser-reference` needs it to rebuild a processor over the same store on hot reload; `event-processor-nfts` needs it to read the capability report. This is the ergonomic consequence of the new shape (the store is no longer a value the caller holds), so it is written out with a comment in both apps and in `packages/browser/README.md`'s `updateProcessor` bullet rather than left for a reader to rediscover. **Touches:** the browser README's reconfigure section, and any future task that gives the hook a first-class way to reach the canonical generation's store.

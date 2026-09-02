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

### The sites, DERIVED not trusted

At the time of writing: **37 call sites** outside `dist/`, of which **31 under `packages/browser/test/`**
(`dispose` 3, `invalidation` 2, `liveReload` 8, `processorKinds` 10, `reconfigure` 2, `setupIndexing` 2,
`txInclusion` 4), plus `packages/browser/browser/workload.ts`, plus **five example apps**.

**Re-derive this list before you start.** Two reasons it will have moved: several example apps were
deleted by `retire-the-js-object-processor-path` (`basic`, `mud`, `web-demo` among them), and the
`processorKinds` tests it names were tied to the retired JS-object path and may be gone entirely. Do
not treat a missing site as drift — treat a site this file does not name as the thing to catch.

**Four further edit sites are unowned unless named here, so they are named:** the README usage block,
two JSDoc examples in the browser package's `IndexerState.ts`, the JSDoc in `BrowserStateStore.ts`, and
`CONTEXT.md`.

### One observation this discharges

`work/notes/observations/keepstate-storage-id-omits-the-processor-version.md` reports a keeper deriving
its storage key WITHOUT the processor version, so two generations collide on one key. A generation's
identity is stream plus processor plus config and the container supplies it, which is exactly the fix.
**Assert the non-collision and DELETE the note** as part of this task.

## Acceptance criteria

- [ ] Every call site outside `dist/` uses the new container name and the new factory shape. The list
      is DERIVED at build time, not read off this file.
- [ ] Every remaining example app is migrated and builds.
- [ ] The four doc sites are updated: the README usage block, the two `IndexerState.ts` JSDoc examples,
      the `BrowserStateStore.ts` JSDoc, and `CONTEXT.md`.
- [ ] **Two generations do not collide on one storage key**, asserted directly, and
      `work/notes/observations/keepstate-storage-id-omits-the-processor-version.md` is DELETED in the
      same change.
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
> - Deleting the alias or the old factory shape. That is the CONTRACT batch; doing it here breaks the
>   green-throughout property this batch exists to preserve.
> - Missing the four doc sites. They are unowned by any other task, which is why they are named here.
> - Forgetting the observation. A keeper deriving its storage key without the processor version means
>   two generations collide on one key; assert the fix and delete the note.
>
> **Scope fence.** Do NOT delete the alias or the old shape. Do NOT remove the `stateDiscarded`
> discard. Do NOT change what the container DOES — only who calls it and how.
>
> Done means: nothing in the workspace still uses the old name or the old factory shape, every doc
> site is current, the generation key collision is asserted fixed and its note deleted, and the build
> is green with the alias still in place.

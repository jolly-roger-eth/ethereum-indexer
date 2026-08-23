---
title: Three small independent gaps the seam drive left behind
slug: three-small-gaps-left-by-the-seam-drive
blockedBy: []
covers: []
---

## What to build

Three unrelated small fixes, each already diagnosed, batched because each is minutes of work and none deserves its own task. They are independent: do them in any order, and if one turns out to be bigger than described, say so and route it out rather than growing this task around it.

**1. A package-root `.ts` file is typechecked by nothing.** (`work/notes/observations/vitest-config-is-typechecked-by-nothing.md`)

`typecheck-tests-in-the-acceptance-gate` gave every package a `tsconfig.typecheck.json` covering `src/**/*.ts` and `test/**/*.ts`. `platforms/cf-worker/vitest.config.ts` is the one TypeScript file sitting at a package ROOT, so it falls outside both globs and is still checked by nothing (vitest loads it through esbuild, which strips types). It uses `__dirname` and the `@cloudflare/vitest-pool-workers` plugin API, which v0.22 recently reshaped, so it is exactly the file a silent type break would live in.

Pull package-root `.ts` files into the typecheck include. Do it in a way a NEW package inherits rather than one that needs remembering, and check whether other packages have root-level `.ts` files that should come along (`playwright.config.ts`, `vitest.config.ts`).

**2. The published read handle cannot use the bounded listing.** (`work/notes/observations/versioned-state-view-has-no-listing.md`)

`packages/processor-sqlite/src/view.ts` forwards `getCurrent`, `getAsOf`, `queryCurrent`, `queryAsOf`, `getBlock` and `resolveBlockNumber`, but not `listCurrent` / `listAsOf`. So a consumer holding the untyped handle that `VersionedStateEventProcessor.process()` returns cannot use the bounded id-prefix listing that `bounded-id-prefix-listing` added to every backend, and has to reach the same rows through `queryCurrent` with a hand-written `WHERE` — which is the surface the listing exists to make unnecessary.

Forward them. Keep the handle's existing untyped character (the typed surface is `createReadSurface`, and that is a different thing); this is closing an omission, not redesigning the view.

**3. Two `abitype` copies resolve in the tree.** (`work/notes/observations/two-abitype-instances-in-the-tree.md`)

`@etherfold/core` declares `abitype: ^1.2.4` and resolves 1.2.4 while its `viem@2.52.0` pins 1.2.3, so both are installed (six `node_modules/.pnpm` entries across zod peer combinations). `core` re-exports abitype's types as part of its own public surface, so the day this bites, it surfaces in a CONSUMER's build as "two different types with this name exist, but they are unrelated", which is miserable to diagnose from outside this repository.

It is not known to break anything today, which is why it was recorded rather than fixed. The cheap preventive is a pnpm `overrides` / `resolutions` entry pinning abitype to one version so only one copy resolves.

**Treat this one as conditional, not mandatory.** viem may have pinned 1.2.3 deliberately. Apply the override, then confirm the full gate passes AND that viem's own types still behave (a type-level check that a viem-derived ABI type and a `core`-derived one are mutually assignable is worth more here than a runtime test). If the override causes trouble, do NOT force it: leave the observation in place, record what you found, and say the dedupe needs a viem bump instead. A recorded negative result is a good outcome for this item.

## Acceptance criteria

- [ ] `platforms/cf-worker/vitest.config.ts` is typechecked, and a deliberately-introduced type error in it fails `pnpm typecheck`. Verify this rather than assuming it.
- [ ] The mechanism covers package-root `.ts` files generally, so a new package or a new root config file is included without anyone remembering to add it. Any other root-level `.ts` files found are covered too.
- [ ] `VersionedStateView` forwards `listCurrent` and `listAsOf`, with a test exercising them through the handle `process()` returns.
- [ ] Only ONE `abitype` version resolves in the tree, verified by inspecting the installed tree rather than by reading the lockfile diff — OR the override was tried, caused a problem, and that is recorded with the reason and the observation left in place.
- [ ] If the dedupe lands, a type-level check pins that viem-derived and `core`-derived ABI types stay mutually assignable.
- [ ] Any observation note that is no longer true after this task is DELETED, not left behind.
- [ ] The full gate passes, plus a changeset for any published package whose surface or dependencies changed.

## Prompt

> Fix three small, independent, already-diagnosed gaps in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`). They are unrelated; batched only because each is minutes of work.
>
> Read the three observations first: `work/notes/observations/vitest-config-is-typechecked-by-nothing.md`, `versioned-state-view-has-no-listing.md`, and `two-abitype-instances-in-the-tree.md`. Each names its own cause and file.
>
> (1) `platforms/cf-worker/vitest.config.ts` sits at a package root, outside the `src/**` + `test/**` globs `typecheck-tests-in-the-acceptance-gate` established, so nothing typechecks it. Pull package-root `.ts` files in, in a way a NEW package inherits automatically rather than one that has to be remembered, and sweep for other root-level configs. Prove it works by breaking the file on purpose and watching `pnpm typecheck` go red.
>
> (2) `packages/processor-sqlite/src/view.ts` forwards six store methods but not `listCurrent` / `listAsOf`, so the handle `process()` hands out cannot use the bounded listing every backend now has, and consumers fall back to hand-written `WHERE` clauses — the exact thing the listing removes. Forward them; keep the handle untyped (the typed surface is `createReadSurface` and is deliberately separate).
>
> (3) `@etherfold/core` resolves `abitype@1.2.4` while its `viem@2.52.0` pins `1.2.3`, so both are in the tree and `core` re-exports abitype types publicly. Try a pnpm `overrides` pin to collapse it to one copy. This one is CONDITIONAL: if the override breaks viem's types or the gate, do not force it — record the negative result, say a viem bump is the real fix, and leave the observation. A recorded negative result is a success here.
>
> Delete any observation note that is no longer true when you are done. If any item turns out bigger than described, route it out rather than growing this task.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular how root-level `.ts` files are picked up and what happened with the abitype override.

## Decisions

**Root-level `.ts` files are picked up by widening each package's typecheck include to `["**/*.ts"]`, not by adding `*.ts` to the existing list and not via a shared root base.** Why: a list of directories is the thing that has to be remembered, and this repo already has the scar — `packages/state-store-indexeddb` had `browser/**/*.ts` and `playwright.config.ts` hand-added to its include and `vitest.config.ts` forgotten. `**/*.ts` makes the rule statable ("every TypeScript file in the package except build output and dependencies") and covers a new root config *or* a new directory the day it appears. Alternatives considered: (a) adding `"*.ts"` to each include, which fixes root files only and leaves the same forget-a-directory hole; (b) hoisting the include into a shared root `tsconfig.typecheck.base.json` that packages extend, rejected because TypeScript resolves `include` relative to the file it is WRITTEN in, so a base-level `**/*.ts` would mean the repo root, not the package: a base can dedupe the compilerOptions but cannot carry the one line that must be remembered. Touches: every package's `tsconfig.typecheck.json`, plus `CONTEXT.md`'s conventions bullet and the root `package.json` typecheck section header, which both described the old globs.

**"A new package inherits automatically" is enforced by a test rather than by config inheritance.** TypeScript gives no way for a package to inherit an include, so a new package still authors its own `tsconfig.typecheck.json`; the previous task (`typecheck-tests-in-the-acceptance-gate`) recorded that a package with no `typecheck` script is skipped silently by the root fan-out. Rather than leave that as a second thing to remember, `packages/core/test/typecheckCoverage.test.ts` asserts both halves for every package in the fan-out. Alternative considered: leaving it, since the criterion is literally about root files. Touches: any future package or platform must carry the script + the config with the canonical include, or the core suite goes red naming it; it lives in core's suite for the same reason `publishedTypeDependencies.test.ts` does (there is no workspace-level harness).

**The abitype override pins UP to `1.2.4`, viem's copy moving, rather than down to viem's exact `1.2.3`.** viem 2.52.0 depends on `abitype@1.2.3` exactly, while `@etherfold/core` and `@etherfold/js-processor` declare `^1.2.4`. Pinning down would make the workspace resolve something *older* than what a consumer installing `@etherfold/core` from npm gets (overrides are workspace-local and do not propagate), so the local tree would stop reflecting the published one, which is the opposite of what the check is for. Pinning up gives viem a patch of its own dependency and keeps local and published resolution identical. The gate is green, including every viem-touching suite, so the conditional "back it out and record a negative result" branch did not fire. Touches: root `package.json` and `pnpm-lock.yaml`; the pin can be dropped the day viem itself moves to 1.2.4, and `packages/core/test/abitypeIdentity.test.ts` is what will say so.

**The type-level assignability check is not the whole guard, and the file says so.** The criterion asked for a type-level pin that viem-derived and `core`-derived ABI types stay mutually assignable. I verified what it actually detects: with the override removed and both copies installed, `pnpm typecheck` still passed, because abitype's types are structural and the two copies were structurally identical. So the type-level aliases catch the copies *diverging* (a later abitype reshaping `Abi`, or a `Register` augmentation merging into one copy only) and not the second copy existing. I added a resolution-based case in the same file that compares the `abitype` version reached from `core` with the one reached from inside `viem`, which is what actually fails on a second copy (proved red). Alternative considered: scanning `node_modules/.pnpm` for `abitype@*` entries, rejected because it hard-codes pnpm's layout and breaks under a different linker, and because pnpm leaves unpruned directories behind after an override change (it did here) so the scan would report copies that nothing resolves.

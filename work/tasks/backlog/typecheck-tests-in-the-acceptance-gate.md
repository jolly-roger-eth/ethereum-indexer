---
title: Add a real `typecheck` that covers test files, and make the acceptance gate's existing reference to it true
slug: typecheck-tests-in-the-acceptance-gate
blockedBy: []
covers: []
---

## What to build

A `pnpm typecheck` that exists, covers the files nothing currently typechecks, and passes.

The acceptance gate in `dorfl.json` already runs `pnpm build && pnpm typecheck && pnpm test`. There is no `typecheck` script: not in the root `package.json`, not in any package, and `git log -S'"typecheck"' -- package.json` shows there never was one. So every gate run dies with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "typecheck" not found`, and because `&&` short-circuits, **`pnpm test` never runs at all.** The gate has been failing every task before reaching the tests.

The fix is not to delete the step. It names a real gap. Every package's `tsconfig.json` sets `"include": ["src/**/*.ts"]` and each `build` script is `rm -rf dist && tsc`, so `pnpm build` typechecks `src/` only. vitest transforms tests with esbuild, which strips types without checking them. **Test files are typechecked by nothing, anywhere.**

That gap is load-bearing right now. Several queued tasks have acceptance criteria that only a typechecked test can enforce: `bounded-id-prefix-listing` requires that omitting a limit is "a TYPE error, not a runtime default", and `query-surface-from-entity-declarations` requires "a type-level test pins this". Today such a test can fail to compile and still report green, so those criteria are unenforceable.

### The shape

Each package's build tsconfig must keep emitting `src/` only, so **do not add tests to it**: with `rootDir: ./src` and `outDir: ./dist`, including `test/**` would emit test files into `dist/`. Add a separate per-package typecheck config instead (`noEmit`, `declaration: false`, `rootDir: "."`, including both `src/**/*.ts` and `test/**/*.ts`), a per-package `typecheck` script, and a root `typecheck` script mirroring how `build` and `test` already fan out (`ldenv pnpm --filter './packages/*' --filter './platforms/*' ...`). Keep the pattern the repo already uses; this is not the place to introduce project references or `tsc --build`.

Note the ordering dependency: cross-package types resolve through each package's `dist`, so `typecheck` assumes `build` has run. The gate already sequences them that way. Say so where a reader will meet it, because running `pnpm typecheck` alone on a clean clone will otherwise look broken.

### What the errors actually are

96 across `packages/` and `platforms/` on `main`, and the distribution matters because most of it is config and convention rather than broken code:

| code | count | what it is |
| --- | --: | --- |
| TS7006 | 32 | implicitly-`any` callback parameters in tests |
| TS2835 | 23 | relative imports in tests missing the `.js` extension NodeNext requires |
| TS2591 | 21 | `@types/node` not in scope (`node:path`, `node:child_process`) |
| TS2345 / TS2322 | 14 | genuine type mismatches |
| TS2307 | 4 | undeclared dependencies |
| TS2635 / TS2351 | 2 | follow-on from the `cf-worker` missing test types |

- **`@types/node` (21).** It is already a devDependency in nine packages but absent from `core` and `js-processor`, whose tests import `node:` builtins. Add it where it is missing. Prefer that over pinning a `types` array, which would narrow what those packages can see.
- **The `.js` extensions (23).** `src/` uses explicit `.js` on relative imports consistently and correctly for NodeNext; only `test/` deviates, and only vitest's resolver hides it. Bringing tests in line with the convention the source already follows is the fix. Do not relax `moduleResolution` to make the error go away.
- **Undeclared deps (4).** `abitype` is imported by `js-processor` tests but reaches them only transitively through viem; declare it explicitly. `cf-worker` tests import `cloudflare:test`, which needs the worker test types wired.
- **The real ones (14).** These include `SQLProcessor<Abi, undefined>` / `JSObjectEventProcessor<..., unknown>` assignability failures that are **pre-existing on `main`**, not introduced by any recent work. Treat them on their merits.

### The constraint that makes this worth doing

**Do not make an error disappear by suppressing it.** No `as any`, no `@ts-ignore`, no blanket `@ts-expect-error`, no loosening `strict`, no widening a type purely to silence a call site. A typecheck bought with suppressions is worse than no typecheck, because it reports green while covering nothing.

Where a genuine error reveals looseness in a **public** API (the processor generic-variance ones are the likely candidates), you have three honest options, in order of preference: fix the type properly; or narrow the test's own types so the mismatch does not arise; or, if and only if a correct fix would change published API surface and therefore belongs in its own task, leave a single narrowly-scoped `@ts-expect-error` carrying a one-line comment saying what is wrong and naming the follow-up. Count those, keep the count near zero, and report every one in your final report with its justification. If you find yourself wanting more than a handful, stop and route to needs-attention instead: that would mean this task uncovered a real API defect that deserves its own task rather than being absorbed here.

Scope is `packages/` and `platforms/`, matching what `build` and `test` already cover. `examples/` is out of scope (the root `build` does not cover it either); if it would be cheap, say so in the report rather than expanding scope here.

## Acceptance criteria

- [ ] `pnpm typecheck` exists at the root, fans out across `packages/` and `platforms/` the same way `build` and `test` do, and exits 0.
- [ ] It typechecks `test/**/*.ts` as well as `src/**/*.ts` in every package that has tests. A deliberately-introduced type error in a test file makes it fail; verify this and say so.
- [ ] `pnpm build` still emits exactly what it emitted before: no test file appears in any `dist/`. Check rather than assume.
- [ ] The full gate command from `dorfl.json` passes end to end, including `pnpm test`, which it has never reached.
- [ ] No error is resolved by suppression, widening, or relaxing compiler strictness. Any residual `@ts-expect-error` is narrowly scoped, commented with the reason, counted, and justified in the report.
- [ ] Test files use explicit `.js` extensions on relative imports, matching the convention `src/` already follows.
- [ ] Missing `@types/node` and undeclared test-only dependencies are added as devDependencies to the packages that use them.
- [ ] A changeset is included if any package's published surface or dependencies changed. A tooling-only change to a private package needs none; say which applies.

## Blocked by

- None. This is a precondition repair and it unblocks every other queued task.

## Prompt

> Add a real `typecheck` to the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`) and make the acceptance gate's existing reference to it true.
>
> FIRST, confirm the premise still holds: `grep -rn '"typecheck"' package.json packages/*/package.json platforms/*/package.json` should find nothing, and the `verify` line in `dorfl.json` should still name `pnpm typecheck`. If a typecheck already exists, route to needs-attention rather than building a second one.
>
> Read `work/notes/observations/verify-names-a-nonexistent-typecheck-script.md` for how this was found and what was measured. Read `tsconfig.base.json` and a couple of package `tsconfig.json` files before designing anything.
>
> The reason this is not simply deleting the broken step: every package's tsconfig includes `src/**/*.ts` only, and vitest strips types without checking them, so test files are typechecked by nothing. Queued tasks depend on that gap closing, because they carry acceptance criteria of the form "a type-level test pins this", which is meaningless while a test can fail to compile and still report green.
>
> The trap to avoid: do NOT add `test/**` to the build tsconfig. With `rootDir: ./src` and `outDir: ./dist` that emits tests into `dist/`. Use a separate typecheck config per package with `noEmit`.
>
> The constraint that makes this worth doing: no `as any`, no `@ts-ignore`, no relaxing `strict`, no widening a type to silence a call site. A typecheck bought with suppressions reports green while covering nothing. Most of the 96 current errors are config and convention (missing `@types/node`, missing `.js` extensions that `src/` already uses correctly, two undeclared test dependencies) and should be fixed at the root cause. Roughly 14 are genuine type mismatches, some pre-existing on `main`, around processor generic variance; fix those properly or narrow the test's own types. If a correct fix would change published API surface, leave ONE narrowly-scoped commented `@ts-expect-error` naming a follow-up, and report it. If you want more than a handful of those, stop and route to needs-attention: that means there is a real API defect deserving its own task.
>
> Done means: `pnpm typecheck` is real, it covers tests, it passes without suppressions, `pnpm build` still emits only `src/`, and the full gate command runs all the way through `pnpm test` for the first time.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report: how the typecheck configs are structured, the build/typecheck ordering dependency, every residual `@ts-expect-error` with its justification, and anything you found that deserves a follow-up task.

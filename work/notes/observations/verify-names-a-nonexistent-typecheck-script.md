---
title: The acceptance gate runs `pnpm typecheck`, which does not exist, so every task fails the gate
slug: verify-names-a-nonexistent-typecheck-script
observed: 2026-08-23
source: 'drive-tasks conductor run over the eleven one-processor-everywhere backlog tasks; first dispatch (portable-mutation-context-seam) bounced to stuck with exit 254'
---

## What happened

`dorfl do task:portable-mutation-context-seam --isolated --allow-backlog --propose --no-review` produced a complete, working branch and then failed the acceptance gate at a step that can never pass.

The `verify` command in the repo's committed `dorfl.json` is:

```
pnpm format:check && { ... changeset status ... } && pnpm build && pnpm typecheck && pnpm test
```

There is no `typecheck` script. Not in the root `package.json`, not in any package under `packages/` or `platforms/`, and `git log -S'"typecheck"' -- package.json` returns nothing, so there never was one. pnpm reports `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "typecheck" not found`.

Because `&&` short-circuits, the gate dies at `typecheck` and **`pnpm test` never runs at all**. So the gate has been failing every task before it reaches the tests, and it will fail all eleven tasks in this drive identically. This is a precondition defect, not a property of any one task.

## The work itself was green

Verified in a throwaway clone (never the human checkout) at branch `work/task-portable-mutation-context-seam`, commit `a1692ed`, running every real step and skipping only the phantom one:

| step | result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm changeset status --since=main` | pass (4 packages, minor) |
| `pnpm build` | pass |
| `pnpm test` | pass, including 16 new tests in `processor-entities` and 62 still green in `processor-sqlite` |

So the branch is a false red. It is preserved on the arbiter and nothing is lost.

## The second finding, which is the more interesting one

Every package's `tsconfig.json` sets `"include": ["src/**/*.ts"]`, and each package's `build` script is `rm -rf dist && tsc`. So `pnpm build` typechecks `src/` only. vitest transforms tests with esbuild, which strips types without checking them.

**Test files are therefore typechecked by nothing, anywhere in the pipeline.** That is precisely the gap the missing `typecheck` step appears to have been intended to close, which suggests the step was written aspirationally and the script was never added.

This is not academic for the tasks in this drive. `query-surface-from-entity-declarations` has the acceptance criterion "a type-level test pins this", and `bounded-id-prefix-listing` requires "omitting the limit is a TYPE error, not a runtime default". A type-level test that lives in `test/` is, today, an assertion that nothing evaluates: it can fail to compile and still report green.

Indicative blast radius, measured by extending each package tsconfig to include `test/**/*.ts` and running `tsc --noEmit`:

| | `main` | branch `a1692ed` |
| --- | --: | --: |
| core | 58 | 58 |
| processor-sqlite | 7 | 34 |
| server | 13 | 13 |
| utils | 6 | 6 |
| js-processor | 5 | 5 |
| state-store-sqlite | 3 | 3 |
| processor-entities (new) | n/a | 2 |
| state-store (new) | n/a | 0 |
| **total** | **92** | **121** |

Two caveats on those numbers. They come from an ad-hoc tsconfig rather than a real `typecheck` config the repo does not have, and a chunk of the `processor-sqlite` delta reports as "Two different types with this name exist, but they are unrelated", which is characteristic of a duplicate `@etherfold/core` instance under my ad-hoc resolution rather than a genuine defect. They are indicative, not authoritative.

But the shape of the delta is worth a look regardless: `processor-sqlite`'s test files go from 7 to 34 under the seam refactor, centred on `SQLProcessor<abi>` not being assignable to `EntityProcessor<Abi, undefined>`. The runtime tests pass, so if this is real it is a genuine variance looseness in the new `EventHandlers` index signature that no current gate can see.

## Why this is not something the conductor fixed

Two defensible repairs, with materially different consequences, and the choice is the human's:

- **Drop `pnpm typecheck` from `verify`.** Restores the gate to what actually runs. Cheap and honest, but it retires an intent rather than fulfilling it, and it leaves test files permanently unchecked.
- **Add a real `typecheck` script.** Fulfils the intent and closes a genuine hole, but it lands on roughly 92 pre-existing errors on `main` before this drive's work is considered, so it is a task in its own right and not a one-line fix.

Reaching for `dorfl do --skip-verify` would make the drive proceed and is the wrong answer: it disables the acceptance gate for every task in a run whose whole point is that several tasks carry constraints a plausible diff would quietly relax.

## Consequence to unpick

The runner surfaced the task by adding `needsAnswers: true` to `work/tasks/backlog/portable-mutation-context-seam.md` and pushing it (`origin/main` moved `48032a4` to `b6aef3a`). That flag makes the task non-auto-selectable, so once the gate is repaired the flag needs clearing as well as the lock being requeued.

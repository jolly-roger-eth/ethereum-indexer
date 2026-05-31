# Modernize the repo

**Area:** repo-wide tooling / config
**Type:** Implementation (will be done by the maintainer)
**Status:** todo

## Context

The repo has accumulated some dated tooling. The maintainer intends to modernize it and will
implement this themselves — so this file is intentionally light, just a checklist/landing spot to
capture intent and findings, not a detailed plan.

Some current observations (non-exhaustive):
- Node pinned old in `package.json` (`volta.node` = `18.7.0`).
- Mixed/older build tooling (`tsup`, `typedoc` next/rc versions, `vitepress` rc).
- `tsconfig` targets `ES6` with `moduleResolution: node`.
- Only the core package currently has tests/vitest wired up.

## Possible scope (to be decided by maintainer)

- Bump Node / package manager versions.
- Update build & docs toolchain.
- Update `tsconfig` (target, `moduleResolution: bundler`/`node16`, etc.).
- Standardize lint/format (already has prettier).
- Standardize test setup across packages (vitest in each `test/` folder).
- Dependency updates (viem, abitype, eip-1193, etc.) + run changesets.

## Notes

- Keep changes incremental and reviewable; coordinate with the active task list so reviews/tests
  aren't invalidated mid-flight.

_(No prompt section — this task is owned by the maintainer.)_

---
title: 'On a fresh clone `pnpm typecheck` fails in examples/web-demo, because the gate never builds examples'
slug: examples-typecheck-needs-examples-built-first
observed: 2026-08-28
source: 'noticed while building task:handler-types-do-not-lie-when-one-name-covers-two-events. Observed once, in a fresh worktree: `pnpm install` (which runs the root prepare -> `pnpm build`, filtered to packages/* and platforms/*) followed by `pnpm typecheck`.'
---

`pnpm typecheck` failed in `examples/web-demo` with `Cannot find module 'event-processor-bleeps' or its corresponding type declarations` plus 10 knock-on errors (`svelte-check found 11 errors`). Running `pnpm build:examples` once and re-running `pnpm typecheck` made it green, so the cause looks like the sibling example packages' `dist/` simply not existing: `examples/*` are in the root `typecheck` filter but in neither the root `build` filter nor dorfl's `verify` (`pnpm build && pnpm typecheck && pnpm test`), and an example's own `typecheck` is `noEmit`, so nothing in the gate ever produces the `dist/` that `web-demo`'s workspace deps resolve their types through.

Unverified beyond that one reproduction, and not touched here: it is a gate/script-ordering question that belongs to no single task. If it is real, `verify` is red on any clean environment regardless of the change under test.

---
title: '`platforms/cf-worker/vitest.config.ts` is still typechecked by nothing'
slug: vitest-config-is-typechecked-by-nothing
observed: 2026-08-23
source: 'task:typecheck-tests-in-the-acceptance-gate, while scoping what the new per-package `tsconfig.typecheck.json` should include'
---

The new `pnpm typecheck` covers `src/**/*.ts` and `test/**/*.ts`, which is what the task scoped. `platforms/cf-worker/vitest.config.ts` is the one TypeScript file in `packages/`+`platforms/` that sits at a package ROOT and so falls outside both globs; it is therefore still checked by nothing (vitest loads it through esbuild, which strips types). It uses `__dirname` and the `@cloudflare/vitest-pool-workers` plugin API, which v0.22 recently reshaped, so it is exactly the kind of file a silent type break would live in.

Adding `*.ts` at the package root to the typecheck include would pull it in; it was left out only because it is out of this task's stated scope, not because it is checked elsewhere.

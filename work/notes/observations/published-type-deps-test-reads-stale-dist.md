---
title: publishedTypeDependencies passes against stale dist artifacts
date: 2026-08-22
---

`packages/core/test/publishedTypeDependencies.test.ts` asserts that a package's published `.d.ts` files only import declared dependencies. It reads whatever is in `dist/`, and `dist/` is never cleaned before a build, so it can pass against artifacts that the current build could not produce.

Spotted during the `etherfold` rename (ADR-0017). Six of its cases failed with, for example, `browser/dist/index.d.cts imports 'ethereum-indexer', which is not declared at all`. The cause was not the rename: `dist/index.d.cts` was dated 31 May while `dist/index.d.ts` was rebuilt the same minute. Every package's `build` script is a bare `tsc`, which does not emit `.d.cts` at all, so those files are orphans of an older build setup (tsup or rollup) that have been sitting in `dist/` ever since. `rm -rf packages/*/dist && pnpm build` cleared them and the suite went green.

Two things follow, neither fixed here:

1. **The test gave false confidence for months.** It was checking a `.d.cts` that no build step produces, and it only spoke up when the rename made the stale import name obviously wrong. A dependency actually undeclared in a live `.d.ts` could have hidden behind the same staleness.
2. **`build` should clean its own output**, or the test should assert freshness (build first, or reject artifacts older than their sources). A test whose subject is "what we publish" must not be able to read something we would never publish.

Worth checking what else reads `dist/` without owning its lifecycle before treating this suite's green as meaningful.

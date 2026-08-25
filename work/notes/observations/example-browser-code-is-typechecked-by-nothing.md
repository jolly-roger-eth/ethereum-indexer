---
title: 'Example code outside `src/` is typechecked by nothing, and two real bugs shipped through the gap'
slug: example-browser-code-is-typechecked-by-nothing
observed: 2026-08-25
source: 'found while building the browser verification harness for examples/event-processor-nfts (task:index-in-the-browser-with-a-chosen-backend follow-up). The two bugs are OBSERVED -- both were caught by running a real browser and both are fixed in 392dc90; the coverage gap is read from the scripts and tsconfigs named below.'
---

`examples/event-processor-nfts/browser/main.ts` is roughly 300 lines of application code that **no gate type-checks**. Two independent exclusions stack up:

- The root scripts filter to packages and platforms. `typecheck`, `test` and `build` are all `ldenv pnpm --filter './packages/*' --filter './platforms/*' …`, so nothing under `examples/` is reached. `build:examples` exists but runs each example's own `build`, and is not part of dorfl's `verify`.
- The example's own `tsconfig.json` has `"include": ["src/**/*.ts"]`. `browser/` is not in it, so even `pnpm --filter event-processor-nfts build` (which is `tsc && node scripts/version.mjs`) does not look at it.

What compiles it is `vite build`, i.e. esbuild, which **strips types without checking them**. So the file is transpiled and shipped, and a type error in it is not an error anywhere.

## The two bugs this let through

Both were written by an agent, reviewed, built green, and only surfaced when the page was driven in a real Chromium:

1. **A temporal dead zone crash on the already-settled paths.** `waitForWallet` referenced `unsubscribe` from inside the callback passed to `connection.subscribe(...)`. A store subscription fires SYNCHRONOUSLY with the current value, so whenever the connection had already settled — a single wallet auto-selected, a chain mismatch, no wallet at all — the callback ran before the `const` was initialised and threw `Cannot access 'unsubscribe' before initialization`. The paths a human clicks through (a picker, an accounts prompt) resolve asynchronously and were fine, which is why casual manual testing would not find it either.
2. **A chain check that compared a constant with itself.** It asked `connection.provider` for `eth_chainId`, but that is `@etherplay/connect`'s always-on wrapper, PINNED to the `chainInfo` it was constructed with, so it answers `1` whatever the wallet is set to. A wallet on Polygon passed the check and indexed a mainnet contract address on the wrong chain — the exact silently-wrong-answer failure the check was written to prevent.

Neither is a type error, so typechecking `browser/` would not have caught either one. That is the point worth keeping: the gap is real, but this pair is evidence for BROWSER EXECUTION being the missing gate, not for `tsc` being it.

## Scope

Every example, not just this one. No example defines a `typecheck` script; `mud` and `web-demo` have `check` (svelte-check) which the root gate also never invokes. Every `event-processor-*` tsconfig includes only `src/**/*.ts`, so the pattern generalises: any example code outside `src/` is outside even its own compiler.

`examples/event-processor-nfts/verify/verify.mjs` now drives the built app in a real browser over six scenarios and is what caught both bugs. It is deliberately NOT in the acceptance gate, for the same reason `@etherfold/browser`'s playwright run is not: it needs a browser binary and a live RPC endpoint.

## Not acted on

Recorded rather than fixed, because the useful answer is not obvious and is worth deciding rather than defaulting. Adding `browser/**` to the example's tsconfig is a one-line change that would type-check the file but would have caught NEITHER bug. Putting the browser verification in the gate would have caught both, and costs a browser binary plus a live network dependency in CI — the trade `typecheck-tests-in-the-acceptance-gate` already weighed once for tests, and ADR-0024 weighed again for the IndexedDB browser run, both times landing on "not in the gate". A third instance of the same question suggests the answer wants stating once, somewhere, rather than re-litigated per example.

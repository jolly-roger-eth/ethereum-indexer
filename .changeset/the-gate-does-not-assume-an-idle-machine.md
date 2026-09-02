---
'@etherfold/browser': patch
'etherfold': patch
'@etherfold/core': patch
'@etherfold/fetcher-host': patch
'@etherfold/processor-entities': patch
'@etherfold/processor-sqlite': patch
'@etherfold/server': patch
'@etherfold/state-store': patch
'@etherfold/state-store-conformance': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/state-store-patch': patch
'@etherfold/state-store-sqlite': patch
'@etherfold/utils': patch
'@etherfold/platform-nodejs': patch
'@etherfold/platform-nodejs-fetcher': patch
---

The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

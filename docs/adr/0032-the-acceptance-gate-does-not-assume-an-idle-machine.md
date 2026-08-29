# The acceptance gate does not assume an idle machine

Every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s, rather than inheriting vitest's 5s default. A test that exceeds 60s is broken; a test that exceeds 5s is usually just sharing a machine.

The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with whatever else the developer is running. In one session three unrelated packages timed out at 5s on a machine at roughly twice its core count: `packages/core`'s base36 digest sweep, four cases in `packages/state-store-sqlite`'s conformance suite, and `packages/server`'s `sql2ts` round-trip. In each case the test file passed in seconds when run alone, and in each case it blocked a task that had nothing to do with the code that failed. The same run reported 466s of transform and 786s of import for five test files, which is the load, not the tests.

That failure mode is worse than a slow suite: it makes a red gate ambiguous. The whole value of the gate is that red means broken, and a timeout tuned to an idle box means red can also mean "someone opened a browser".

A generous timeout costs nothing when tests pass, because a timeout is only ever reached on failure. It costs something only when a test genuinely hangs, where it trades a faster red for a slower one, which is the right trade for a gate that gates other people's work.

## Considered options

**Skip the offending tests** was tried first and reverted the same day. It removes real coverage (the digest sweep guards a past regression where the reviver threw on an ordinary base36 digest) and it does not converge: each new slow suite costs another skip, and the list only grows.

**Raise the timeout only in the packages observed to be slow** was rejected because the set is not a property of those packages. It is a property of the machine, so the list would grow by exactly one package per incident, discovered by a red gate each time.

**Pass `--testTimeout` from the root `test` script** was rejected because it makes the gate and a local `pnpm --filter <pkg> test` behave differently, and a developer reproducing a gate failure locally would not see the same thing. Divergence between the gate and local runs is the root of this class of bug.

**A shared config file imported by each package** was the preferred shape and does not work here. Each package's `tsconfig.typecheck.json` sets `rootDir` to the package, and `include: ["**/*.ts"]` pulls `vitest.config.ts` into the program, so importing a root-level file fails with `TS6059: File is not under rootDir`. Routing it through a workspace package resolves to the same real path through the symlink and fails the same way. Excluding config files from typecheck would work but contradicts ADR-0030, which puts every workspace directory under the typechecker.

## Consequences

The value is duplicated across 19 `vitest.config.ts` files rather than shared from one place, which is the cost of the constraint above. It is one constant that changes rarely, and each copy carries a comment pointing here.

Fifteen packages gain a `vitest.config.ts` they did not have. Those files set only the timeouts, so test collection is unchanged and the default `include` still applies. The four packages that already had a config keep their existing settings, notably `packages/browser`, which restricts `include` so Playwright specs are not collected by vitest.

A genuinely hanging test now takes 60s to report instead of 5s.

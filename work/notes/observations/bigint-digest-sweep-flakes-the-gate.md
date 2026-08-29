---
title: 'The base36 digest sweep in bigint.test.ts flakes the acceptance gate on a loaded machine, and is now skipped'
slug: bigint-digest-sweep-flakes-the-gate
observed: 2026-08-28
source: 'noticed while driving task:abi-versions-are-block-ranged, whose gate died on this test with nothing else red. The same run reported `import 175.65s`, i.e. the machine was heavily loaded (a second dorfl drive plus a concurrent verify).'
---

`packages/core/test/bigint.test.ts > the tagged BigInt codec > never throws on a bare base36
digest either, including the shape that used to break` failed with
`Error: Test timed out in 5000ms.`

It is **not** a failing assertion. The body is fully deterministic: it walks
`i = 0..20000`, derives `((i * 2654435761) % 0xffffffff).toString(36)`, and makes two
assertions per iteration, so 40,000 assertions against vitest's 5s default timeout. There is
no randomness and no I/O. On an idle machine it passes; under load it does not finish in time.

The failure mode is what makes it worth recording: it reds the **acceptance gate**, so it
blocks whatever unrelated task happens to be building when the machine is busy. It cost
`abi-versions-are-block-ranged` a full build, and the task it killed had nothing to do with
BigInt encoding.

Skipped with `it.skip` on 2026-08-28 on an explicit human call, to stop it blocking the queue.

**This is a coverage loss, and the coverage is real.** It guards a genuine past regression: the
old reviver called `BigInt()` on anything starting with a digit and ending in `n`, which throws
on an ordinary base36 digest and, inside `JSON.parse`, reads as a corrupt snapshot. That is the
kind of bug a sweep catches and a single hand-picked example does not.

A permanent skip is the wrong end state. Two cheaper fixes preserve the guard:

- raise the timeout for this one test, since the cost is wall-clock rather than logic; or
- cut the iteration count sharply. The dangerous shape (`/^\d/` and ends with `n`) is hit early
  in the sweep, and the test already tracks that with `sawTheDangerousShape`, so a few hundred
  iterations would still assert it was exercised.

The second is probably right: the sweep's value is hitting the shape at all, not hitting it
20,000 times.

## Resolved 2026-08-28, the same day

The skip was the wrong fix and lasted hours. Two more instances of the identical shape appeared
immediately after: four cases in `packages/state-store-sqlite/test/conformance.test.ts`, then
`packages/server/test/sql2ts.test.ts`. Three unrelated packages, one cause, so it was never about
this test.

`testTimeout` and `hookTimeout` are now 60s in every package that runs vitest (ADR-0032), and this
test is un-skipped. The guard is back and the flake class is closed at the root rather than one
`it.skip` at a time.

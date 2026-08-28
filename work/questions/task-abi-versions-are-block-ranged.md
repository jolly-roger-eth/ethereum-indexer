<!-- dorfl-sidecar: item=task:abi-versions-are-block-ranged type=task slug=abi-versions-are-block-ranged allAnswered=false -->

## Q1

**'task:abi-versions-are-block-ranged' was bounced — how should we proceed?**

> agent failed: the agent failed to build 'abi-versions-are-block-ranged'.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

## Q2

**'task:abi-versions-are-block-ranged' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && { [ "$GITHUB_HEAD_REF" = "changeset-release/main" ] && echo 'skip changeset status on the Version PR (it consumes changesets)' || pnpm changeset status --since=main; } && pnpm build && pnpm typecheck && pnpm test`; its last output was:
>
> packages/core test:       Tests  1 failed | 306 passed | 1 skipped (308)
> packages/core test:    Start at  11:22:15
> packages/core test:    Duration  19.17s (transform 92.64s, setup 0ms, import 175.65s, tests 23.80s, environment 39ms)
> packages/core test: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
> packages/core test:  FAIL  test/bigint.test.ts > the tagged BigInt codec > never throws on a bare base36 digest either, including the shape that used to break
> packages/core test: Error: Test timed out in 5000ms.
> packages/core test: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
> packages/core test:  ❯ test/bigint.test.ts:66:2
> packages/core test:      64|  });
> packages/core test:      65|
> packages/core test:      66|  it('never throws on a bare base36 digest either, including the shape …
> packages/core test:        |  ^
> packages/core test:      67|   let sawTheDangerousShape = false;
> packages/core test:      68|   for (let i = 0; i < 20000; i++) {
> packages/core test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
> packages/core test: Failed
> /tmp/dorfl-fresh-gate-bIPXir/tip/packages/core:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @etherfold/core@0.7.0 test: `vitest run`
> Exit status 1
>  ELIFECYCLE  Test failed. See above for more details.

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):
